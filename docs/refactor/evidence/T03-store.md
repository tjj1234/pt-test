# T03 · 持久任务存储定向交付

日期：2026-10-16。实施分支 `feature/northstar-phase1-refactor-20261016`；实施基线 `a2adbee64c326653dbf5bfed3f918dd09f96589d`。状态：**模块与真实隔离 PGlite 自测通过，待独立验收；没有 HTTP、SSE、执行器或 UI 接线，不代表 T03 完成。**

## 文件与最小接口

| 文件 | 交付 |
|---|---|
| `shell/db-migrations/011_runs_events.sql` | agent_runs 和 agent_run_events；Run 幂等 scope 唯一、eventId 全局唯一、run＋seq 唯一、状态／revision／seq 约束 |
| `shell/tasks/store.cjs` | `createTaskStore(db,{workspaceForIdentity?})`；复用 phase1 版本、身份、事件、状态与幂等契约 |
| `tests/regression/task-store-test.mjs` | 真实磁盘 PGlite：原子创建、越权、冲突、并发事件、游标、重启与外部未知恢复 |

| 方法 | 语义 |
|---|---|
| `createRun(identity,input)` | input 为 conversationId、idempotencyKey、policyVersion、request；验证 conversation 真实属于可信 user／tenant。默认服务端 workspace 为 `ws_`＋tenantId，也可由可信代码注入 resolver；客户端身份／workspace 冲突拒绝 |
| `getRun(identity,runId)` | 同时按 user／tenant 过滤，不返回别人任务是否存在的详细差异 |
| `listRuns(identity,{afterRunId,limit})` | 按 run UUID 稳定升序游标，最多 500；不是按创建时间排序的时间线 |
| `eventsAfter(identity,runId,{after,limit})` | 归属校验后按 seq 返回 events、nextCursor、hasMore；不丢页、不逐字写事务的策略尚待执行层决定 |
| `appendEvent(identity,runId,event)` | 锁 Run 行原子分配 seq；生成可信 scope，参数企图覆盖 run／conversation／seq／version 则拒绝；相同 eventId＋内容重放返回原事件，不同内容冲突 |
| `transition(identity,runId,next,expectedRevision)` | 锁行并比较 revision、复用状态机；状态记录和事件同一事务提交，终态同时写 done |
| `recordExternalIntent(identity,runId,{provider,operationKey,expectedRevision})` | 必须在真正提交付费外部请求前保存意图；进入 waiting_external＋needs_reconciliation，不实际发送请求 |
| `recordExternalTaskId(identity,runId,{taskId,expectedRevision})` | 保存已知供应商 taskId 与 accepted；重复覆盖／旧 revision 拒绝 |
| `recoverInterrupted(identity)` | 仅由确认旧 worker 已死亡后的恢复流程调用；普通 running／cancelling 变 interrupted；外部等待保留原任务，已知 ID 标 pending_query、未知标 unknown 并 needs_reconciliation，不自动重提 |

SQL 值全部参数化；只用静态 SQL 和内部布尔锁子句，不拼接用户标识符。事务与行锁复用 StorageAdapter，未新建连接、循环、Runner 或 SessionStore。Run request 会持久化，调用方必须先去除凭据及不应保存的敏感字段；该模块不是通用日志脱敏器。

## 原子性与恢复边界

创建在一个事务中执行 conversation 归属锁、唯一 scope `INSERT ... ON CONFLICT DO NOTHING`、读取已有请求 hash 与首条 queued 事件。相同可信身份／操作／Key／请求重放同一个 Run；不同请求抛 `IDEMPOTENCY_CONFLICT`、HTTP 状态建议 409；不同身份的同名 Key 独立。没有先查后插的竞态窗口。

Run 行锁让多请求顺序认领 seq；eventId 主键防跨 Run 重用，失败整笔事务回滚、不会留序号空洞。状态 revision 是乐观并发版本，事件序号独立；append 事件不伪增状态 revision。终态不可重新运行，迟到 delta／connecting／tool.started 等拒绝；工具完成等观测事件可追加但不重开状态。

恢复只修改持久状态，不调用上游；未知付费结果要求人工核查，已知 taskId 供后续执行服务查询原任务。重复恢复未知任务不重复写事件或改 revision。**模块还没有 worker lease／进程存活探测；不得对仍活跃 worker 调用恢复方法。** 外部核查确认完成后如何验证证据、解除 reconciliation 并恢复执行，仍需后续服务层协议，不能把本模块当作已实现完整恢复器。

## 实际验证

环境 macOS、Node `v24.14.0`、PGlite `0.5.8`。测试发现 PT_PG 配置即失败，不连接任何外部 PG。测试 fixture 使用临时库、合成账号与 Key，无网络／DSH／付费调用。

| 完整命令 | 结果 |
|---|---|
| `node --test tests/regression/task-store-test.mjs` | 1 个综合用例通过，0 fail／skip，约 1 秒 |
| `node --test tests/regression/task-store-test.mjs tests/regression/storage-upgrade-test.mjs tests/regression/phase1-contract-test.mjs` | 14 tests／14 pass／0 fail／skip；旧库升级自动包含新增 011 |
| `node --check shell/tasks/store.cjs` | exit 0 |
| `git diff --check` | exit 0；不代替未跟踪文件校验 |

综合用例真实覆盖：12 次并发 createRun 只得一个 Run、一条 queued，只有一个非 replay；不同请求 409；用户 B 同 Key 不共享 Run；跨用户／租户／workspace 与 conversation 越权拒绝；两次并发 revision 更新只有一个成功；15 次并发事件无重复序号；eventId 重放／不同内容冲突／跨 Run 冲突；失败 append 回滚序号；after 分页连续、非法游标拒绝；重启后事件与幂等记录保留；恢复不新建替代付费任务、普通任务 interrupted、未知外部任务 manual_check、已知 taskId pending_query；终态不能重开。

**真实 PostgreSQL、多连接并发和生产执行未验，不标通过。** SQL 使用 PG 兼容类型与行锁语法不能替代真实 PG 集成。PGlite 并发证明单进程同库事务与约束行为，尚不证明 PG 跨节点执行容量。当前唯一 scope 可防重复创建 Run，不保证外部动作恰好一次；真正调用仍需供应商幂等键、提交意图与查询协议。

## 接线与回滚

主集成人应把旧 `/api/chat` 和未来 Run API 接到同一服务，可信身份由已验证 session 得到，workspace resolver 不接收原始路径；持久 queued 成功才启动执行。事件批量保存与重连、预算、任务租约、取消收敛、供应商查询与 reconciliation 闭环仍未接线。migration 已加入唯一默认目录；回滚模块不反向删表或删除审计事件，生产数据库回滚需备份与兼容性计划。

## 独立首验返工：两项 FAIL 与修复

独立 reviewer 实证发现：① conversations.remove 的级联会删除 waiting_external Run、付费提交意图与事件；②终态自动写 done 后，新 eventId 可以再次写逻辑 done。两项均成立，首验不通过；以下是实施方修复与自测，须 reviewer 重新独立复核后才可标验收通过。

选择最小留存策略：011 的 conversation_id 保留原 UUID 为不可变历史关联，去掉 conversation 外键级联；createRun 仍事务检查真实归属。删除对话只移除对话内容，不隐式删除 Run／付费意图／审计事件；历史 Run 仍按原可信 user／tenant 查询，新任务不能再使用已删除对话。这不是全账号数据删除方案：当前 user／tenant 外键仍可能级联，账号删除必须另走明确的外部任务核查、留存／清除政策，不能因为对话删除有留存便声称完整账号删除已解决。Run request 也可能含用户内容，未来正式删除入口必须向用户说明留存范围与期限并按策略物理清理，不能仅隐藏。

done 去重在持有 Run 锁时先检查已有逻辑终态；新 ID 的重复 done 抛 TERMINAL_EVENT_EXISTS，不再新增；原 eventId 与相同内容仍原样返回。数据库新增每 run 的 done 部分唯一索引，即便绕过 store 直接写也拒绝重复；相同事件全信封重放保留原 seq 检查。

补充测试实际验证：终态同 eventId 重放、新 ID 重复 done 拒绝、原始 SQL 绕过被 23505 拒绝；删除对话后 unknown 外部 intent 和全部原事件保留、旧对话不能创建新 Run。`node --test tests/regression/task-store-test.mjs tests/regression/storage-upgrade-test.mjs` 为 3／3 通过；新增数据库唯一性断言后 task-store 独跑再次通过。011 尚未正式发布，本次修改是未发布迁移的收口；已手动试跑旧版 011 的临时库应重建夹具，未来已发布迁移必须新增升级文件，不能修改历史 SQL 冒充升级。
