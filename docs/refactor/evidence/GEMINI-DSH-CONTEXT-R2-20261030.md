# 离线证据：DSH 原生长上下文 R2 组合预算与真实压缩候选验证（2026-10-30）

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
- **验证环境**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零真实公网调用、零真实凭据。

---

## 2. R2 关键修复与增强事实

### 2.1 彻底解决预算重复扣减（No Double-Counting）
- **R1 缺陷核查**：当前 `shell/persistent-runner.mjs` 原生已经在 `agent/request` 监听器中对普通对话请求执行了 `budget.admit({ type: "model" })`；R1 的 `llm/stream` 门禁对所有流无差别准入，导致普通对话被重复扣减 2 次。
- **R2 解决方案**：
  - 普通对话请求（`purpose === "chat"`）沿用既有 `agent/request` 的预算准入，在 `llm/stream` 处直接透传；
  - 辅助模型调用（`purpose === "compaction"`，即原生 `BasicCompactionEngine` 绕过 `agent/request` 直接调用 `ctx.llm.stream()` 的操作）由 R2 门禁在 `llm/stream` 前置精准准入；
  - 组合验证证实：1 次 chat + 1 次 compaction 恰好消耗 2 个预算单位，无任何重复扣减。

### 2.2 流式异步生命周期与精确 settle
- **R1 缺陷**：R1 在获取流对象后立即同步调用 `admission.settle()`，偏离了流传输中途可能失败或取消的语义。
- **R2 解决方案**：
  - 通过 `wrapStreamWithSettle` 包装底层 `AsyncIterable`；
  - 仅在流实际消费完毕（正常结束、迭代异常或 abort）时触发 `admission.settle({ error })`。

### 2.3 严格活动 Run 绑定与重叠会话隔离
- 严禁猜测全局活动会话，未携带 `sessionId` 或查询不到有效活动 Run 时直接 **Fail-Closed**（`RUN_NOT_BOUND`）；
- 两个并发会话的预算完全隔离：会话 1 预算耗尽阻断后，本地 HTTP 请求计数严格为 2（零泄漏），完全不影响会话 2 正常消耗。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-context-r2-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-context-r2-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Context Gate R2 - No double-counting: chat admitted in agent/request, compaction admitted in llm/stream`: PASS
  2. `Context Gate R2 - Accurate settle timing across stream consumption`: PASS
  3. `Context Gate R2 - Fail-Closed when missing active Run or sessionId`: PASS
  4. `Context Gate R2 - Overlapping sessions isolation`: PASS

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-context-r2-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-context-r2-probe.mjs`
- **退出码**: `0`
- **探针执行指标**:
  - `wireRequestsCount`: `3`
  - `session1Calls`: `2` (1 次普通对话 + 1 次辅助压缩)
  - `session2Calls`: `1` (会话 2 独立调用)
  - `noDoubleCounting`: `true`
  - `budgetExhaustionZeroLeakedRequests`: `true` (第 3 次调用被预算阻断，本地服务器请求计数未增加)
  - `multiSessionIsolationVerified`: `true`
  - `compactionEventsCaptured`: `3` (`compaction/start`, `compaction/summary`, `compaction/end`)

---

## 4. 主线接缝说明（生产入口接入建议）

1. **`shell/persistent-runner.mjs` 接缝**:
   - 在持久进程初始化时挂载 R2 门禁：
     ```javascript
     const { installNativeContextGateR2 } = require("./runtime/dsh-native-context-r2-candidate.mjs");
     installNativeContextGateR2(ctx, {
       getActiveTurn: (sid, purpose) => {
         const active = activeTurns.get(sid);
         return active ? {
           sessionId: sid,
           tenantId: active.tenantId,
           runId: active.runId,
           budget: active.budget,
           recordEvent: (evt) => { /* emit to host */ },
         } : null;
       },
     });
     ```
   - 现有的 `agent/request` 监听器继续保持对普通 chat 请求的准入，两者协同工作，恰好各自负责其生命周期。
2. **`shell/runtime/dsh-adapter.cjs` 的 `PROFILE_PATCH`**:
   - 后续主 Agent 可按需逐步移除 `compaction-basic`、`command-compact`、`tool-result-pruner`、`repeat-tool-reminder` 的 `disabled: true`。

---

## 5. 未验证项声明
- 本次验证基于本地 localhost HTTP/SSE 替身与锁定环境。
- **未验证项**：真实大模型在海量历史 token 压力下触发压缩的语义保留保真度、真实 PT 网关对于 `x-deepseek-harness-compact: 1` 归因头的处理表现。这些工作由主 Agent 在主线发布中进行。不得宣称长上下文与压缩能力已上线。
