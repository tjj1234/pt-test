# 离线证据：DSH 原生长上下文接线与预算门禁候选验证（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**:
  - `@deepseek-ai/dsh-compaction@0.1.1-rc.2`
  - `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`
  - `@deepseek-ai/dsh-command-compact@0.1.1-rc.2`
  - `@deepseek-ai/dsh-compaction-tool-result-pruner@0.1.1-rc.2`
  - `@deepseek-ai/dsh-repeat-tool-reminder@0.1.1-rc.2`
  - `@deepseek-ai/dsh-llm@0.1.1-rc.2`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`, `@deepseek-ai/cordis@0.1.1-rc.2`
- **预算引擎**: `shell/tasks/budget.cjs` (`createRunBudget`)
- **环境隔离**: 纯本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，临时上下文与严格清理，未触碰真实生产 Key 或公网。

---

## 2. 关键发现：原生 Compaction 模型调用绕行隐患及其封闭

### 2.1 漏洞与缺口事实
- DSH 原生 `BasicCompactionEngine` 产生长会话压缩摘要时，**刻意不触发 `agent/request` 扩展点**（因为该扩展点被设计为仅属于普通 agent loop 对话轮次）。
- 摘要请求直接以 `GenerateOptions`（带 `purpose: "compaction"`）调用 `ctx.llm.stream()`。
- 如果宿主只在 `agent/request` 处实施预算 `budget.admit({ type: "model" })`，则所有因上下文过长或手动 `/compact` 命令触发的模型调用，将**彻底绕过宿主 Run 预算与用量审计**，形成不可控的计费与调用漏洞！

### 2.2 门禁候选解决方案 (`shell/runtime/dsh-native-context-gate-candidate.mjs`)
- 在 Cordis 全局 `llm/stream` waterfall 前置挂载门禁监听器（`prepend: true`）：
  - 提取 `options.purpose`（如 `"compaction"` 或 `"chat"`）与 `options.sessionId`；
  - 严格校验当前 Session 是否绑定了有效的活动 Run；未绑定时默认 **Fail-Closed**（抛出 `RUN_NOT_BOUND`）；
  - 执行 `budget.admit({ type: "model", purpose, ... })`。如果预算拒绝（超出 `maxModelCalls`、`maxCost` 或超时），立即阻断并抛出规范错误；
  - **网络请求零外发保证**：在预算拒绝时，下游适配器绝不被调用，本地 HTTP/SSE 替身请求计数严格保持为 0，且不执行隐式重试。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-context-gate-candidate-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-context-gate-candidate-test.mjs`
- **退出码**: `0`
- **通过测试数**: `5 / 5`
  1. `Context Gate Candidate - Validation of installation options`: PASS
  2. `Context Gate Candidate - Fail-Closed when model call has no active Run bound`: PASS
  3. `Context Gate Candidate - Compaction call admitted within budget and settled`: PASS (含 chat 与 compaction 混合预算消耗及超限拒绝)
  4. `Context Gate Candidate - Two sessions isolation & no crosstalk`: PASS (双会话预算完全隔离)
  5. `Context Gate Candidate - Lifecycle audit observation`: PASS (正确捕获 compaction/start, summary, end 事件)

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-context-candidate-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-context-candidate-probe.mjs`
- **退出码**: `0`
- **执行指标**:
  - `budgetModelCallsTracked`: `2` (包含 1 次 chat 与 1 次 compaction 摘要)
  - `wireRequestsCount`: `2`
  - `compactionBypassClosed`: `true`
  - `leakagePreventedOnBudgetDenial`: `true` (第 3 次调用被预算拒绝，本地服务器未接收到任何新请求)

---

## 4. 四插件独立启用与其依赖分析

| 插件 ID | 职责 | 依赖项 | 独立启用可行性与建议 |
|---|---|---|---|
| `compaction-basic` | 自动长上下文压缩引擎 | `@deepseek-ai/dsh-compaction`, `dsh-token-meter`, `dsh-llm` | 可独立启用，但**必须**挂载本候选的 `llm/stream` 门禁以防止预算绕行。 |
| `command-compact` | 手动 `/compact` 斜杠命令 | `dsh-compaction` | 依赖压缩后端（即需要 `compaction-basic` 提供能力）。 |
| `tool-result-pruner` | 超大工具输出不依赖模型的轻量剪枝 | 无复杂外部依赖 | 可独立启用。只裁剪输入上下文表层，不影响宿主持久落盘数据。 |
| `repeat-tool-reminder` | 重复工具调用提醒 | `dsh-agent` | 可独立启用。不触发额外模型调用，不越过工具预算。 |

---

## 5. 主 Agent 最小接线说明（生产入口接入建议）

1. **`shell/persistent-runner.mjs` 接缝**:
   - 在持久进程初始化或 `agents.create` 的 setup 中：
     ```javascript
     installNativeContextGate(ctx, {
       getActiveTurn: (sid, purpose) => {
         const active = activeTurns.get(sid);
         return active ? {
           sessionId: sid,
           tenantId: active.tenantId,
           runId: active.runId,
           budget: active.budget,
           recordEvent: (evt) => { /* emit to host via RPC */ },
         } : null;
       },
     });
     ```
2. **`shell/runtime/dsh-adapter.cjs` 的 `PROFILE_PATCH`**:
   - 现阶段 profile 禁用了 `compaction-basic`、`command-compact`、`tool-result-pruner`、`repeat-tool-reminder`。在主 Agent 决定恢复前，可逐项在 profile 中取消 `disabled: true`。
3. **未解决限制与安全声明**:
   - 本候选在隔离沙箱中已通过离线测试。
   - 生产接入前需由主 Agent 核定多租户环境下真实长对话的 token meter 压力阈值配置（如 `compactionRatio` 与 `compactionRetries`）。
