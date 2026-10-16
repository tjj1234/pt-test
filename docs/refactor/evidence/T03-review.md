# T03 任务存储独立审查

日期：2026-10-16。审查当前新增 `shell/tasks/store.cjs`、迁移 `011_runs_events.sql` 与 task-store-test。审查者未参与实现，只新增 `tests/regression/task-store-review-test.mjs` 和本文。范围是持久存储 API／事务，不是 HTTP、SSE 或 DSH worker 集成。

**首轮结论：FAIL，两个真实 PGlite 反例未通过。** 实跑 `node --test tests/regression/task-store-review-test.mjs`：**5 项，3 PASS／2 FAIL，exit 1**。每项使用独立临时真 PGlite 数据库、真实迁移与仓储，显式拒绝 PT_PG_* 环境，关闭并删除测试库；未联网、不调用付费模型。测试创建合成账号与模拟外部标识，不是真实凭据。

| 编号 | 实际结果 | 处理要求 |
|---|---|---|
| TR01：未核对外部 intent 丢失 | 创建 run → running → recordExternalIntent，持久 provider 与 paid-submit-intent；调用现有 conversations.remove 删除该对话，因 run.conversation_id ON DELETE CASCADE，run 行及事件级联消失，回查 0 行 | 拒绝删除活跃／待核对任务关联对话，或采用保留任务历史／墓碑的显式策略；必须保留未知扣费／外部提交核对线索。不是要求 store 实现新 UI，而是新 FK 改变既有删除行为后已实证的数据丢失 |
| TR02：逻辑 done 可重复 | running → completed 自动写一条 done；appendEvent 使用新 eventId 和相同 completed payload 再写 done，未拒绝 | 明确一个 run 的权威终结事件只写一次，重复请求可返回原 done 或受控拒绝；eventId 唯一不能代替逻辑终结幂等。允许终态后补 usage／artifact 等事件不等于允许再次终结 |

通过的独立控制：

- 两个独立 store 实例共享同一个真 PGlite adapter，对同一 key 并发提交不同 request，一次成功、一次 IDEMPOTENCY_CONFLICT，没有多建 run；这是同进程单库事务竞争，不是 PostgreSQL 多连接或跨进程竞争验收。
- 使用另一个用户，或伪造 A 的 userId＋B 的 tenantId，读取、状态变更、记录外部 intent 均 NOT_FOUND，list/recover 无泄漏；覆盖 append 中 conversationId 被拒，事件 seq 仍为 [1]。可信 identity 由未来 HTTP 鉴权层提供，本测试不允许把客户端 identity 直接当可信。
- 外部 intent 在无 taskId 时先持久化，关库重开后 operationKey 存在；恢复标 unknown 后再次 recordExternalIntent 被 EXTERNAL_INTENT_EXISTS 拒绝，相同 create key 返回旧 run，agent_runs 仍一行。证明 store 没创建替代任务；store 没有真实网络提交，因此不声称验证了上游绝不重复扣费。
- 跨 run 复用 eventId 被 EVENT_ID_CONFLICT 拒绝，失败事务不消耗 next_seq，下一合法事件 seq=2。

## 范围与未验证项

`recoverInterrupted` 明确只允许在 worker 已知死亡／租约失效后调用；目前 store 没有 lease，也不能区分活 worker。误当轮询调用会将活任务标 interrupted，这是接线时必须执行的前置条件，不把注释本身说成保护已经实现，也不要求本次 store 单独承担调度器完整功能。后续 worker 接入必须有真实所有权／租约证据，再验恢复不误杀与不重复提交。

当前预算可作为 request 内容持久化，但 store 不执行模型，不负责预算熔断；预算校验、调用前检查、重试／外部费用核对需由执行任务验收。不存在「存了request就完成预算控制」的结论。错误边界已验的仅冲突／身份／scope／序号；原始 SQL 错误到 HTTP 是否统一脱敏，本 store 尚未 HTTP 接线，不能算完成或直接认定线上泄漏。

真正 PostgreSQL 多进程并发、同key同请求／异请求的唯一约束等待行为、行锁竞争、死锁与连接失败恢复未实测；PGlite 本进程 Promise 并发不能替代。测试读取了真实 SQL 唯一约束，但不会据此冒称跨进程验收。生产验收需补该证据。对话删除后的已完成历史保留／清除策略仍需产品明确；TR01 至少要求未知外部操作不能无声消失。

本审查没有修改 store、SQL、依赖或其他产品文件；失败断言保留，待修复后独立重跑并更新结果。

## 独立复验：本组任务存储通过

实现者修复后审查者读取实际store/SQL，并执行 `node --test tests/regression/task-store-review-test.mjs tests/regression/task-store-test.mjs tests/regression/storage-upgrade-test.mjs`：**8/8 PASS，exit 0**。其中独立审查5/5；删除conversation后待核对intent仍保留，第二逻辑done受控拒绝，原三项隔离／幂等／重启控制同时通过。仅将允许的明确拒绝码列表增加新实现的TERMINAL_EVENT_EXISTS，没有删断言或降低done计数要求。

当前结论更新为 **PASS（本组真实PGlite持久任务存储边界）**，此前FAIL保留为返工历史。删除对话后保留任务历史是当前明确策略；账号删除、数据留存时长及用户删除权的完整清理链路需后续独立设计和验收，不等于「全部数据永久不可删除」。真正PG跨进程竞争、HTTP身份绑定、worker死亡判定／租约与真实上游不重提仍未验证。
