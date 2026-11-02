# 离线证据：DSH 原生上下文与组合预算门禁 R4 准入反例闭环与真实原生压缩（2026-11-01）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**:
  - `@deepseek-ai/cordis@0.1.1-rc.2`
  - `@deepseek-ai/dsh-agent@0.1.1-rc.2`
  - `@deepseek-ai/dsh-commands@0.1.1-rc.2`
  - `@deepseek-ai/dsh-command-compact@0.1.1-rc.2`
  - `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`
  - `@deepseek-ai/dsh-token-meter@0.1.1-rc.2`
  - `@deepseek-ai/dsh-session@0.1.1-rc.2`
  - `@deepseek-ai/dsh-llm@0.1.1-rc.2`
  - `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`
- **底层 SDK**: `@earendil-works/pi-ai`
- **预算系统**: `shell/tasks/budget.cjs` (`createRunBudget`)
- **测试环境**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零真实凭据，零真实 PT 访问，零数据库写入。

---

## 2. R4 核心修复与主审独立复现的 5 项穿透反例闭环

主审在 `tests/probes/dsh-context-r3-main-review-20261101.mjs` 与 `docs/refactor/evidence/context-r3-main-review-20261101.json` 中复现了 5 项 controlled dispatch 穿透。R4 实现了严格的全链路闭环：

| 穿透反例 | R3 缺陷原因 | R4 严格闭环手段 | 判定结果 |
|---|---|---|---|
| **1. `chat-ticket-without-active-run`** | R3 未强制要求 chat 拥有活动 Run，无活动 Run 时仍放行 | 普通 chat 必须验证 `getActiveTurn(sessionId, purpose)`；若无活动 Run 立即在网络前抛出 `RUN_NOT_BOUND`，底层 dispatch 为 0 | 已闭环 |
| **2. `chat-ticket-old-run-client-overrides-active-run`** | R3 优先使用客户端传入的 `streamOptions.runId`，旧 Run 凭证可冒充新 Run | 凭据绑定核验严格以权威 `activeTurn.runId` 为准，客户端自报 runId 错配抛出 `TICKET_RUN_MISMATCH`，底层 dispatch 为 0 | 已闭环 |
| **3. `auxiliary-missing-required-intent-recorder`** | R3 将 `recordModelIntent` 视为可选回调，缺失时不拦截 | 辅助模型调用强制要求必须具备持久意图记录器，未提供直接抛出 `MISSING_INTENT_RECORDER`，底层 dispatch 为 0 | 已闭环 |
| **4. `auxiliary-canceled-while-awaiting-intent`** | R3 仅在 await 意图前检查取消，意图记录异步耗时中途被取消则继续 dispatch | 在 `await recordIntentFn(...)` 之后、调用底层 `next()` 之前实施二次双重核验，发现取消立即 settle 预算并抛出 `RUN_CANCELLED`，底层 dispatch 为 0 | 已闭环 |
| **5. `auxiliary-canceled-after-stream-created-before-consume`** | R3 在返回 generator 时立即调用了 `next()`，导致未消费先 dispatch | 采用惰性调度设计：将底层 `next()` 推迟到生成器真正开始消费的首个循环，并在消费前再次检查取消状态；消费前取消抛出 `RUN_CANCELLED`，底层 dispatch 为 0 | 已闭环 |

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-context-r4-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-context-r4-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Context Gate R4 - Review Blockers 1 & 2: Chat bound to authoritative active Run and client runId override rejected`: PASS (2.12ms)
  2. `Context Gate R4 - Review Blockers 3, 4 & 5: Required intent recorder, cancellation during await, and cancellation before consume`: PASS (0.69ms)
  3. `Context Gate R4 - Secure Ticket Manager: Crypto random IDs, capacity limits, and TTL pruning`: PASS (121.33ms)
  4. `Context Gate R4 - Barrier-controlled overlapping concurrent sessions isolation`: PASS (1.20ms)

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-context-r4-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-context-r4-probe.mjs`
- **退出码**: `0`
- **真实生态与公开入口验证**：
  1. 加载并装配 `@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-command-compact`；在受控维护 Run 下调用 `ctx.commands.execute(dummyAgent, "/compact", ...)`，成功返回 commandId 并完成公开入口调度；
  2. 普通 Chat（带 Ticket）+ 原生 `BasicCompactionEngine.summarize` = **恰好 2 次本地 HTTP/SSE 网络外发，2 次预算记账**；
  3. 5 项穿透反例全部实测验证，在网络外发前均被阻断，本地 HTTP/SSE 替身请求总数严格维持为 2（**0 泄露**）。

---

## 4. 主线接缝说明

1. **`shell/persistent-runner.mjs` 接缝**:
   - 宿主通过 `installNativeContextGateR4` 初始化；
   - 在 `agent/request` 预算准入后通过 `ticketManager.issueTicket(...)` 签发绑定 `activeTurn` 的加密 Ticket；
   - 辅助压缩调用复用原生 `BasicCompactionEngine` 与 `sessionId: agent.session.id`，并在门禁层前置要求 `recordModelIntent`。
