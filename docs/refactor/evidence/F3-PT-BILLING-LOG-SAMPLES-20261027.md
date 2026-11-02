# F3：用户提供的 PT 消费日志样例（2026-10-27）

用户提供四条 PT 消费记录，分别为文本、视频、图片、音频。本文只保留字段结构与脱敏数值，不保存样例中的完整 `consume_id`、`request_id`、`task_id`。这是**用户提供的样例证据**，不是按 Key 可查询的 PT API，也不代表当前北极星已能自动取得这些日志或计算 PT 最终扣费。

| 类型 | endpoint | `usage` | `billing.billing_unit` / `unit_size` | `billing.items` 有效计费项 | 样例小计 → `final_quota` |
|---|---|---|---|---|---|
| 文本 | `POST /v1/chat/completions` | input 1642、output 1486、total 3128 | `per_tokens` / 1,000,000 | uncached input、cache hit input、output、active cache write | 0.78 + 4.235 = 5.015 → 6 credits |
| 视频 | `POST /v1/videos` | `{}` | `per_tokens` / 1,000,000 | output 38,800 × 3,850 credits/million = 149.38 | 149.38 → 150 credits |
| 图片 | `POST /v1/images/edits` | `{}` | `per_image` / 1 | images 1 × 71.25 credits/image | 71.25 → 72 credits |
| 音频 | `POST /v1/audio/speech` | characters 235 | `per_characters` / 1,000 | characters 235 × 95 credits/thousand = 22.325 | 22.325 → 23 credits |

四个样例的 `consume_time` 为 Unix 秒，分别对应 `2026-07-23T13:34:24Z`、`2026-07-24T06:14:24Z`、`2026-07-08T02:05:54Z`、`2026-06-09T08:59:36Z`。四例的 `final_quota` 都等于各自小计向上取整数，但**四例不足以确立 PT 全局舍入规则**，尤其不能从文本美元价格推断 credits 与 USD 的兑换比例。

## 对 F3 台账的直接影响

1. 调用时先记录本地 `runId`、调用序号、请求时刻、请求模型、endpoint、任务/模态及影响计费的参数；响应时补上可证实的 provider 回报模型、响应 usage、状态和可取得的外部关联 ID。PT 样例的 `consume_id`、`request_id`、`task_id` 用于**将来可得日志时的精确对账**，不能凭模型名和时间猜关联；没有上游回报时保持 unknown。
2. 价格维度按 `billing_unit` 分开。文本的四类 token 计数在样例中可与当前 `shell/usage/text-cost-estimate.cjs` 的分项语义对照；视频虽然 `usage` 为空，账单却以 output tokens 计费；图片按张、音频按字符。故不能用 `usage:{}` 推断零费用，也不能用统一 token 算法覆盖所有模态。
3. 官方消费日志的 `billing.items`、`quota`、`original_quota`、`final_quota` 是**日志本身给出的账单事实**；本地按官网价格快照计算的是估算，必须分列显示。当前没有按 Key 查询日志的公开 API，所以 F3 不应承诺自动同步 PT 实际扣费。
4. 样例视频顶层 `original_quota=148`，但 `billing.original_quota=150`，两处不同；同一记录的 `quota=150`、`billing.final_quota=150`。需要保留原始层级与冲突标记，不能悄悄择一。`billing.formula` 是供人阅读的文本，不作为权威计算输入；结构化 `items` 与最终字段分开保存。
5. 四条样例均为 `status:success`；失败、取消、提交未知及退款样例仍缺。不能用这些样例定义失败扣费或重提规则。图片／视频功能开发当前按用户要求挂起，这些记录只用于后续设计与对账证据。

**与 Gemini 任务的边界**：`GEMINI-F3-PRICE-SNAPSHOT-SELECTION-PACKAGE-20261027.md` 仍只处理本地官方**文本 USD 价格快照的唯一选择**，不读取 PT 消费日志、不换算 credits。主 Agent 后续决定价格快照与 PT credits 的展示/对账契约，不能用样例隐含的 `quota_per_unit=1000` 猜汇率。
