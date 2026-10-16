# T03 · 持久 Run 的 HTTP/SSE 接线证据

日期：2026-10-16。分支：`feature/northstar-phase1-refactor-20261016`。验证时基线 HEAD：`4b98e570f941f773eba79719769734da81b072e8`；本交付尚待提交，提交后在工作记录补录完整commit hash。结论：**HTTP接线与本地集成子范围通过；T03整包仍未完成。**

## 变更范围

| 文件 | 变化 |
|---|---|
| `shell/server.cjs` | 增加`GET /api/runs`、`GET /api/runs/:id`、`GET /api/runs/:id/events`（JSON分页或SSE游标回放）、`POST /api/runs/:id/cancel`；将`POST /api/chat`纳入持久Run、幂等提交、旧SSE帧兼容和断线后任务继续；`/api/chat/stop`按run取消；启动时扫描并恢复遗留queued/running任务。事件在持久化发布后写入HTTP流；SSE done在终态state与done事件事务提交后发送。|
| `shell/tasks/execution.cjs` | 取消遇到CAS revision冲突后重读并重试，解决queued晋升running期间取消丢失。|
| `shell/tasks/store.cjs` | 启动恢复包括queued任务；增加按数据库真实user/tenant集合扫描`recoverAllInterrupted()`。|
| `shell/contracts/phase1.cjs` | 允许持久事件中的`step`、`artifact`类型。|
| `shell/public/app.js` | 为每次chat生成幂等键；流式终态能显示needKey提示。|
| `tests/regression/task-execution-test.mjs` | 持久事件、终态顺序、scheduler拒绝与确定性queued→running取消竞态覆盖；反例含显式15秒超时。|
| `tests/regression/task-store-test.mjs`、`task-store-review-test.mjs` | 验证重启将无人执行queued任务转interrupted。|
| `tests/regression/google-login-integration-review-test.mjs` | 受控OIDC身份、PGlite和`PT_CHAT_DRYRUN=1`下验证真实HTTP路由的Run创建、事件回读、幂等重试。|

## 验证证据

| 命令 | 结果 | 环境与边界 |
|---|---|---|
| `node --check shell/server.cjs && node --check shell/public/app.js && git diff --check` | PASS | Node v24.14.0；本机语法与diff格式检查。|
| `node --test tests/regression/task-store-test.mjs tests/regression/task-execution-test.mjs tests/regression/task-store-review-test.mjs tests/regression/session-scheduler-test.mjs tests/regression/run-events-contract-test.mjs` | 21/21 PASS（取消race后专项：1/1） | 隔离临时目录和磁盘PGlite；未读取`.env`，无真实PG/DSH/PT请求。确定性反例以globalLimit=1先占满槽位，将第二个run排队；暂停queued→cancelled写入，释放首任务使第二任务晋升running，再恢复CAS；最终`stopped=true`、持久state=`cancelled`，executor收到AbortSignal。|
| `node --test tests/regression/google-login-integration-review-test.mjs` | 1/1 PASS | 本地HTTP服务、PGlite、受控Google身份模块fixture和`PT_CHAT_DRYRUN=1`。验证HTTP响应返回run ID、完成帧、run events中有delta且done最后、同幂等键重试返回原run且用户消息只落一条。测试临时密钥与本机`.env`隔离。 |
| 独立代码复核 `/root/t03_review` | PASS（取消CAS反例修复） | 审查者未修改文件；先独立重现取消竞态，再复核重试逻辑与新增反例测试。其指出本范围仍缺HTTP级强制排队/取消测试。|

## 已知缺口与结论边界

尚未验证HTTP级真实排队后取消和断线重连的端到端路径；现有强制排队反例在执行服务与真实临时PGlite层覆盖。未实现worker lease、多进程/多实例PostgreSQL协调、预算熔断、外部provider状态查询及完整reconciliation闭环；数据库持续故障导致持久终态写不入时，HTTP连接会结束但不会伪造done，需依靠后续恢复策略。未验证真实Google OAuth、真实DSH SDK执行、PT请求、浏览器UI、生产PostgreSQL、部署或重启中的存活worker处理。`PT_CHAT_DRYRUN`只证明应用HTTP/持久Run夹具链路，不是模型验收。`.env`未读取；当前可用测试key余额限制未用于本验证。

因此本证据只确认当前代码范围接线与隔离测试通过，**不宣称T03整体完成，也不构成Claude整体验收或全新Claude Code测试**。
