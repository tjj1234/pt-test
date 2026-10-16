# T03 · 运行生命周期服务子范围

日期：2026-10-16（验证区间 08:35–08:39 UTC）。分支 `feature/northstar-phase1-refactor-20261016`。基线：T03 store 已提交于 `21021432c6bfc602d3a1b1223cad33b13e3e56be`；本子范围提交前。结论：**首轮独立验收 FAIL，修复后独立限定复验 PASS；不代表 T03 完成**。

新增 `shell/tasks/execution.cjs`，将持久 store 与 T04 scheduler 通过注入式 executor 连接：先持久创建 queued Run，重复幂等请求只返回原 Run、不再次排程；执行前推进 running；每个 Run 串行追加事件，执行完成前 drain 事件写入；成功／失败／取消写入终态；显式取消先记录 cancelling，再针对 runId 调度器取消并等待 executor 收敛。身份只由可信调用方传入，查询及状态修改仍由 store 做 user＋tenant 所有权校验。新增 `tests/regression/task-execution-test.mjs`，真实临时磁盘 PGlite + 确定性 executor 覆盖事件顺序、同幂等键不重复执行与运行中取消收敛。

首轮独立审查在同一命令及真实隔离 PGlite 发现两项缺陷：事件写入失败后重复 await 已拒绝的 Promise，Run 留在 running；取消后 executor 忽略 Abort 并晚返回成功，取消结果声称 stopped 但 Run 是 completed。实现者修复：事件失败后 drain rejected tail 并以持久状态为准尝试 failed 收尾；取消晚成功时返回 `stopped:false`、state=completed；新增两个确定性反例测试。修复后命令：`node --test tests/regression/task-execution-test.mjs tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs`；环境 macOS、Node `v24.14.0`、真实隔离 PGlite、合成用户、无网络／DSH／PT 请求，结果 **7/7 PASS，0 fail/skip**。独立 reviewer 原样复验 7/7，并另用受控 Promise probe 重跑两个反例：写失败为 `STORAGE_FAILED` 且状态 `failed`；取消后晚成功返回 `stopped:false` 且状态 `completed`。运行时间约 4 秒。日志仅出现非 Windows临时 master key 0600 权限提示与未配置内部看板 key 提示；未写入仓库或提交任何密钥。

此模块没有 HTTP/SSE 路由、启动恢复、持久 worker lease、预算策略、外部供应商查询、对话消息提交事务或 runtime 事件接线。`/api/chat` 仍在 HTTP 生命周期内执行并保留按用户锁；断线不取消的行为、`Last-Event-ID` 回放、指定 run HTTP 停止与 legacy SSE 兼容均未验证。事件落库失败会使执行 Promise 失败，不会报告成功；数据库不可用时终态可能仍需恢复流程处理。`request` 应由未来可信服务层生成最小脱敏元数据，当前服务不负责通用脱敏。尚未验证多进程 PostgreSQL、真实 DSH、浏览器、Google OAuth、付费调用或部署。

独立复核者 `/root/architecture` 未参与本模块实现；首验 FAIL，修复后限定复验 PASS。状态：**子范围验收通过 / T03整包进行中**。独立复核没有验证真实 DSH／HTTP；数据库持续不可用时仍需后续恢复收尾。
