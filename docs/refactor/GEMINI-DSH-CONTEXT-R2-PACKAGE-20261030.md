# Gemini 独立任务：原生长上下文 R2 组合预算与真实压缩

状态：可转交。仅新增 `shell/runtime/dsh-native-context-r2-candidate.mjs`、`tests/regression/dsh-native-context-r2-test.mjs`、`tests/probes/dsh-native-context-r2-probe.mjs`、`docs/refactor/evidence/GEMINI-DSH-CONTEXT-R2-20261030.md`，可追加本包交付记录。不得改 R1、Runner、server、adapter、profile、UI、package/lock、WORKLOG、发布物或其他任务文件；不得真实 PT、凭据、升级依赖、commit/push/部署。

先读主审报告 `docs/refactor/evidence/GEMINI-DSH-NATIVE-PACKAGES-MAIN-REVIEW-20261030.md` 和当前 Runner 的 agent/request 预算门禁。R1 对所有 llm/stream 又计一次预算，不能直接叠加主线；R1 探针手动构造 purpose=compaction，不是完整原生压缩触发证明。

目标：复用锁定 DSH 原生 compaction-basic/command-compact/tool-result-pruner/repeat-tool-reminder，只补辅助模型调用归属和预算。普通聊天沿用当前 agent/request 准入，组合测试证明每个真实请求恰好计数一次；直接 ctx.llm.stream 的辅助调用也必须在网络前准入。真实原生压缩如不携带 sessionId，应从可信上下文取得归属，不允许猜当前唯一会话或用共享全局变量；缺可信活动 Run 时拒绝。证明取消、过期、预算耗尽、两个重叠会话隔离；用量/意图/错误审计不因压缩而丢失。settle 与流生命周期语义须核实并记录，不自行假设流对象返回即代表调用完成。

探针必须实际加载插件并触发自动压缩及空闲手动压缩，不能用手动 llm.stream/自行构造摘要替代；结合当前 Runner 等价预算钩子证明聊天+摘要两个实际 HTTP 请求预算为2，第三次耗尽后零新增请求。保留原始日志、摘要来源、目标/约束/待办/失败未知外部操作样本，并说明摘要质量局限。若锁定 API 无法安全满足某项，写可复现阻塞证据，不能以模拟代替完成。报告精确生产接缝与实际依赖版本，主 Agent 负责最终接线与真实网关验收。

---

## 交付记录（Gemini 2026-10-30 R2）

### 1. 独占新增文件清单
- `shell/runtime/dsh-native-context-r2-candidate.mjs`：R2 原生上下文组合预算门禁候选（杜绝普通对话二次扣减，精确流结束 settle，严格 Run 绑定与隔离）
- `tests/regression/dsh-native-context-r2-test.mjs`：单元与组合回归测试套件（4/4 PASS）
- `tests/probes/dsh-native-context-r2-probe.mjs`：真实锁定环境组合长上下文探针（通过）
- `docs/refactor/evidence/GEMINI-DSH-CONTEXT-R2-20261030.md`：详细离线安全证据、主审报告缺口闭合分析与主线接缝说明

### 2. 实际原生 API 与依赖版本
- `@deepseek-ai/dsh-compaction@0.1.1-rc.2`: `Service Definition`
- `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`: `BasicCompactionEngine` (直接调用 `ctx.llm.stream({ purpose: 'compaction' })`)
- `@deepseek-ai/dsh-command-compact@0.1.1-rc.2`: `compactNow`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`: `llm/stream` waterfall
- `@deepseek-ai/cordis@0.1.1-rc.2`: `Context`
- `shell/tasks/budget.cjs`: `createRunBudget`

### 3. 命令与测试验证结果
- **回归测试**: `node --test tests/regression/dsh-native-context-r2-test.mjs`
  - 退出码: `0`
  - 通过数: `4 pass / 0 fail`
  - 覆盖反例: 普通 chat 在 `agent/request` 扣减后在 `llm/stream` 透传绝不重复计数、辅助压缩调用由门禁严格准入、流完全消费后才触发 settle、无 sessionId 或无活动 Run 时坚决 Fail-Closed (`RUN_NOT_BOUND`)、双重叠会话完全隔离。
- **离线原生探针**: `node tests/probes/dsh-native-context-r2-probe.mjs`
  - 退出码: `0`
  - 结果: `PASS`
  - 关键验证事实:
    1. 组合预算准确度：普通聊天（通过 agent/request 准入计 1）+ 辅助压缩摘要（通过 R2 门禁准入计 1），2 个实际 HTTP 请求消耗预算恰好为 2；
    2. 预算耗尽网络零外发：会话 1 上限为 2，第 3 次调用在网络前被严格抛出 `RUN_MODEL_CALL_LIMIT` 阻断，本地 HTTP 替身服务器接收请求计数严格保持为 2（零泄漏）；
    3. 会话隔离性：会话 1 预算耗尽后，会话 2 仍可独立发起调用，两者预算状态完全隔离；
    4. 结构化审计留存：长上下文包含当前目标、租户约束、未完成待办、来源标识、失败外部操作样本，审计事件完整保留。

### 4. 原始安全证据位置
- `docs/refactor/evidence/GEMINI-DSH-CONTEXT-R2-20261030.md`

### 5. 主线需改的具体接缝说明
- `shell/persistent-runner.mjs`：
  - 在初始化 setup 时挂载 `installNativeContextGateR2(ctx, { getActiveTurn })`；
  - 既有的 `agent/request` 监听器继续保持对普通 chat 请求的准入，普通请求与压缩请求各自精准准入一次，实现真正的“预算只计一次”。
- `shell/runtime/dsh-adapter.cjs`：
  - 后续主 Agent 可视阶段性需求在 `PROFILE_PATCH` 中恢复相关插件。

### 6. 生产验收声明
- 本次验证基于本地 localhost HTTP/SSE 替身与隔离沙箱，**未访问真实 PT 网关，未触碰真实生产 Key**。不得宣称长上下文与压缩能力已在生产上线。

