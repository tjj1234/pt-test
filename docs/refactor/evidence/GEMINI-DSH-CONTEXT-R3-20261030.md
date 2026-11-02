# 离线证据：DSH 原生长上下文与组合预算门禁 R3 真实原生压缩与完整预算门禁（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**:
  - `@deepseek-ai/cordis@0.1.1-rc.2`
  - `@deepseek-ai/dsh-agent@0.1.1-rc.2`
  - `@deepseek-ai/dsh-llm@0.1.1-rc.2`
  - `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`
  - `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`
- **底层 SDK**: `@earendil-works/pi-ai`
- **测试环境**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零公网访问，零真实凭据，零真实数据库变更。

---

## 2. R3 核心修复与 R2 主审缺口闭环事实

### 2.1 闭环缺口 1：一次性宿主准入凭证（杜绝无凭证 Chat 透传）
- **R2 主审复现 blocker**：`tests/probes/dsh-context-r2-main-review-20261030.mjs` 证明 R2 仅按 `purpose === "chat"` 透传，未绑定 Run 的普通对话请求可绕过预算直接 dispatch (`unbound-chat-dispatched-without-budget`)。
- **R3 严格闭环**：
  - 提供 `ChatAdmissionTicketManager` 一次性凭证管理契约；
  - 宿主在 `agent/request` 预算准入通过后签发一次性 Ticket，绑定确切 `runId`、原生 `sessionId`、`provider` 与 `model`；
  - 在 `llm/stream` 处严格消费一次凭证；无凭证（`MISSING_ADMISSION_TICKET`）、凭证重放（`TICKET_ALREADY_CONSUMED`）、参数篡改/跨会话错配（`TICKET_SESSION_MISMATCH`）或超时（`EXPIRED_ADMISSION_TICKET`）均在网络外发前以 Fail-Closed 立即拦截，绝不发生零预算透传；
  - 消费后凭证原子性失效，杜绝重放攻击。

### 2.2 闭环缺口 2：原生归属复用与拒绝未绑定活动 Run
- **机制核查**：锁定 `@deepseek-ai/dsh-compaction-basic` 的 `summarizeWithLlm` 调用时原生传递 `sessionId: agent.session.id` 与 `purpose: "compaction"`；
- **R3 严格闭环**：
  - 直接复用原生会话归属，不猜测全局唯一活动会话；
  - 辅助模型调用必须提供 `sessionId`，并通过 `getActiveTurn` 定位活动 Run；若无活动 Run 立即抛出 `RUN_NOT_BOUND` 阻断在网络前；
  - 保持业务会话与原生 session.id 的隔离映射。

### 2.3 闭环缺口 3：取消、Abort、过期与耗尽的严格 Fail-Closed
- **R2 主审复现 blocker**：`cancelledTurn` 下直接调用 compaction 仍发生 dispatch (`cancelled-turn-compaction-dispatched`)。
- **R3 严格闭环**：
  - 无论是普通 Chat 还是辅助 Compaction，只要 `activeTurn.cancelRequested === true`、`signal.aborted === true` 或 `activeTurn.expired === true`，在预算计数与网络 dispatch 之前一律抛出 `RUN_CANCELLED` / `RUN_EXPIRED` 立即阻断；
  - 预算耗尽时抛出 `RUN_MODEL_CALL_LIMIT`，网络请求严格不增加；
  - 消除主审反例测试暴露的安全隐患。

### 2.4 闭环缺口 4：可 await 的持久模型意图与审计接口
- 辅助摘要调用在发往网络前，必须先完成持久模型意图记录（`await recordModelIntent(...)`）；
- 若意图持久化失败，立即抛出 `INTENT_AUDIT_FAILED`，同时触发 `admission.settle({ error })`，保证审计失败时绝不外发网络，且预算记账状态不泄露。

### 2.5 闭环缺口 5：流生命周期与跨会话并发隔离
- **精确流 Settle**：`wrapStreamWithSettle` 包装底层 AsyncIterable，保证在正常遍历完成、抛出异常、消费者提前 `break`/`return` 或 abort 时均能准确触发 settle；
- **并发重叠隔离**：使用 Promise 栅栏（Barriers）对真实并发交错的两个会话进行测试：会话 1 流执行中途挂起，会话 2 执行 compaction 并触发取消；会话 1 恢复消费并正常结束，证明会话间的凭证、预算、取消状态与事件完全解耦隔离。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-context-r3-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-context-r3-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Context Gate R3 - Chat admission ticket: missing, replay, and mismatch rejected`: PASS (2.29ms)
  2. `Context Gate R3 - Fail-Closed: cancelled turn, abort signal, expired run, or audit failure`: PASS (0.76ms)
  3. `Context Gate R3 - Stream lifecycle and settle semantics`: PASS (0.15ms)
  4. `Context Gate R3 - Barrier-controlled overlapping concurrent sessions isolation`: PASS (0.50ms)

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-context-r3-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-context-r3-probe.mjs`
- **退出码**: `0`
- **真实原生插件加载与触发**：
  - 实际加载锁定 `@deepseek-ai/dsh-compaction-basic`（`BasicCompactionEngine`）、`@deepseek-ai/dsh-llm`（`LlmRuntime`）与 `@deepseek-ai/dsh-llm-pi-ai`（`PiAiAdapter`）；
  - 真实通过 `compactionEngine.summarize(historyInput, agentWrapper)` 原生管道触发压缩，生成原生内部 checkpoint；
  - 严禁人工 emit 事件，严禁手写假摘要。
- **真实网络 I/O 与预算断言**：
  - 1 次普通 Chat（带 Ticket）+ 1 次原生 Compaction = **恰好 2 次本地 HTTP/SSE 网络调用，2 次预算计数**；
  - 摘要模型生成文本: `"This is an established checkpoint consolidating earlier project tasks and tenant rules."`；
  - 第 3 次调用预算耗尽：网络前抛出 `RUN_MODEL_CALL_LIMIT`，本地替身请求计数严格维持为 2（0 泄露）；
  - 无凭证 Chat 反例：网络前抛出 `MISSING_ADMISSION_TICKET`，本地替身请求计数严格维持为 2（0 泄露）；
  - 取消 Turn 压缩反例：网络前抛出 `RUN_CANCELLED`，本地替身请求计数严格维持为 2（0 泄露）；
  - 持久模型意图记录验证：100% 捕获并核实。

---

## 4. 主线接缝与产品接入说明

1. **`shell/persistent-runner.mjs` 接缝**:
   - 在宿主 `agent/request` 中执行 `budget.admit({ type: "model" })` 后，调用 `gate.ticketManager.issueTicket(...)` 签发一次性凭证，并将 `admissionTicket` 附加至请求参数；
   - 在底层 `llm/stream` 处，`installNativeContextGateR3` 拦截并校验该凭证，杜绝任何未授权或绕过预算的 chat 调用；
   - 辅助压缩调用直接复用 DSH 原生 `sessionId: agent.session.id`，由门禁自动关联活动 Run 执行预算准入与模型意图记录。
2. **生产边界**:
   - 本候选模块保持为独立 4 文件交付物，不修改任何主线生产文件，无破坏性改动。
