# T03 RPC、provider 与预算接线增量（2026-10-18）

当前分支 `feature/northstar-phase1-refactor-20261016`，提交基线 `b09b1e13720cd16cd7538999d4c63386920b367c`；本文件记录未提交工作区增量，不能作为发布版本标识。T03 和项目整体验收仍未完成。

## 已实现与证据

| 范围 | 本轮行为 | 验证边界 |
|---|---|---|
| 提交 fencing | intent 只允许有效 lease 的 running Run 首次写入；已有 intent 拒绝重复授权；取消后迟到 taskId 可持久化 | PGlite 存储与独立夹具；尚无本轮真实 PG 并发证据 |
| 未知提交 | 无 taskId 仅可记录 unknown_submission，形成 manual_check，禁止查询或重提；提交 worker 可显式保留 lease 后正常终结 Run | 新增保 lease 负向/终结回归 |
| RPC | v1握手、profile模块hash、requestId/sessionId对应、pending去重、安全错误、abort/timeout清理；media_route固定请求宿主 | 假DSH进程+JSONL10/10；非真实DSH |
| 媒体回调 | 宿主POST前await intent，taskId先落库再轮询；同步成功、未知响应、迟到taskId、本地未提交取消均有不同持久状态 | 媒体mock80/80；宿主8/8含实际PGlite+同Run两次提交/重复intent无额外POST |
| 多外部操作 | migration015及逐operation子表；Run租约与查询租约分离，Run状态按未解决操作聚合，终态不回转；Run详情支持有界租户分页 | store/worker PGlite专项，未发真实provider请求；不把provider成功当Run完成 |
| provider worker | 原子 claim 后只读 GET、最多8次、未知状态人工核查；stop 等待进行中的查询/写回结束 | 受控 fetch/store/clock；adapter pending 词表尚无真实契约，默认未知即人工核查 |
| 预算 | runner 注册工具执行前准入；profile 复制独立预算模块；done 携带 configured/unconfigured 与安全计数 | 未配置限额时没有额度保护；模型/SDK内部重试/真实费用尚未覆盖 |

执行证据：`node --test tests/regression/task-store-test.mjs tests/regression/task-execution-test.mjs tests/regression/task-store-review-test.mjs` 首次6/9，通过修正必需 leaseOwner 的旧夹具后9/9；新增保 lease 覆盖后独立 review 文件8/8。`node --test tests/regression/task-budget-provider-test.mjs` 最终9/9（含worker stop drain）。`node --test tests/regression/dsh-parent-rpc-test.mjs` 由实现 agent 执行6/6。实现 agent 另执行媒体 mock80/80、runtime contract26/26。以上均为受控、本地验证，未发真实模型或付费请求。工作区 `git diff --check` 通过。

## 未完成与交接

宿主已在取消后drain回调；新提交已迁移到逐operation子表，legacy scalar worker只恢复旧数据，两个worker启停均接主进程且shutdown等待写回。预算configured/unconfigured已持久化为usage事件，模型/内部retry/费用仍未覆盖。T04 server/UI会话隔离已接，runner正补per-session队列与turn元数据隔离；受控UI并行41/41，尚不能外推真实DSH并发。真实数据库、双实例SSE、浏览器断线及真实PT验收仍需补证。queued恢复命令与redispatch正在实现，尚未验收。完整源码版本与依赖生产锁定也未验收。

最新增量：usage按SDK每个response汇总并保留缺失值，不把最后一份usage当整轮总量；纯逻辑6/6，runner/日志存储接线与幂等关联正在推进。该计数只表示可观测response，不能代表内部网络重试/计费请求总数。

项目整体状态见 [ACCEPTANCE-STATUS-20261018.md](../ACCEPTANCE-STATUS-20261018.md)。用户要求整个北极星项目于2026-10-21验收上线，质量优先；现有证据不足以作上线通过结论。
