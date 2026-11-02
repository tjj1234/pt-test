# T11 保活请求独立记账方案（2026-10-23）

**结论：`PT_HEARTBEAT_ENABLED` 保持默认关闭。** 开启后，定时器会用用户 BYOK 向默认模型发送真实付费请求；当前 `persistent-runner.mjs` 已产出逐响应 `usageEvidence`，但 `dsh-adapter.cjs` 的 `pulse()` 只返回聚合 `usage`，`server.cjs` 只在成功时写日志。失败、超时和进程退出都可能已经发生上游计费，不能按零处理。保活不得进入用户主对话的 `chat_usage`、Run 统计或工具调用统计。

## 最小持久化契约

1. **派发前准入与意图。** 在同一数据库事务内核对用户对该 BYOK 保活用途的明确授权、所选模型的可用资格及账户级预算，生成不可重用的 `heartbeat_attempt_id`（UUID），记录 `tenant_id`、`user_id`、`model`、策略版本、准入时间和 `state=accepted`。预算预留与 attempt 创建原子完成；发送 task 前改为 `dispatched`。跳过的租户不创建付费 attempt。不得记录 key 或 prompt 内容。
2. **按证据结算。** `pulse()` 把 `heartbeat_attempt_id` 关联到一次全新 runner session，并返回 `code`、`budget`、完整 `usageEvidence`（`responses`、`coverage`、`totalSemantics`）及实际模型。独立 `heartbeat_usage` 以 `(heartbeat_attempt_id, response_seq)` 唯一，沿用 T11 的字段合法性、缓存 token 语义与冲突检测；重复完成帧只能得到相同记录，冲突帧进入人工核对。聚合 `usage` 仅作展示，不再作为第二条用量写入。`chat_usage` 不增加保活行。
3. **未知结果保留。** timeout、进程退出、缺失 usage chunk、用量冲突或写库失败均保留 attempt 与 `usage_coverage=unknown`／待核对状态；已知部分字段可保存，但未知总量不得显示为零或可信费用。超时后若同一 attempt 的迟到 `done` 到达，按相同幂等键补充证据；若进程已退出则保留未知，不自动重新发送。落库失败要有受控重试和可审计告警，不能只写 `heartbeat_ok` 日志。
4. **预算边界。** 账户级跨周期预算须在 `server.cjs` 定时扫描调用 `tenant.heartbeat()` **之前**原子准入，已派发但结果未知的 attempt 仍占预留额度。`run-budget.json` 的单次时长／调用／输出上限不是货币额度；当前缺少可信价格或最坏费用上界时，货币上限无法证明，应拒绝启用。运行时每次模型请求仍受单次预算限制，保活不能绕过 BYOK 授权、模型资格或账户限流。

## 验收边界

默认关闭时验证无保活出网；开启试验须先证明授权、原子预算、独立表唯一键及失败／取消／超时／迟到完成的去重。以锁定 DSH 事件形态核对成功和失败的逐响应 token；未知保持未知，保活与人工对话统计互不混入。未经目标环境的受控真实请求及账单核对，不宣称实际费用完整或生产可开启。
