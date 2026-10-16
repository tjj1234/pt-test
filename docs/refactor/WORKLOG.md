# 北极星一期重构工作记录

本文件是 Codex 开发过程记录，**不是正式《北极星总文档》**。用户于 2026-10-16 授权从 T00 开始；正式总文档在整体验收后由用户根据实际结果发布。本记录及本地 v1.11 不取代正式总文档，不提前宣布任务包 D 或旧架构修订稿作废。

## 开工约束

集成分支：`feature/northstar-phase1-refactor-20261016`。起点：`a2adbee64c326653dbf5bfed3f918dd09f96589d`。T00–T18 仅在该分支实施，不合并 main、不部署。全部完成后仍须 Claude 整体验收及全新 Claude Code 完整测试，不能以 Codex 自测替代。

每次交付记录任务、分支、完整 commit hash、文件与接口／迁移变化、验证命令和环境、证据时间／ID、外部阻塞及结论。证据文档不能记录秘密，未知不能当通过。

## 批 0 文件归属（2026-10-16）

| 角色 | 专属改动范围 | 当前任务 |
|---|---|---|
| 主 Agent | 六共享接缝、集成、工作记录 | T02 集成／T01、T00收口；处理T10审查修复与集成 |
| 子 Agent A | 独立基线／验收，不改实现 | T01 Google-only存储政策独立复核完成；后续按依赖轮换 |
| 子 Agent B | 隔离模块实现，避开共享接缝 | T04纯调度已交付；开始T05 schema校验模块，尚未独立验收 |
| 子 Agent C | 独立安全／维护审查 | T10产物路径反例审查已完成；FAIL修复后复验PASS |

`server.cjs/tenant.cjs/persistent-runner.mjs/public/app.js/public/index.html/public/styles.css` 本批唯一集成人为主 Agent，子 Agent 不修改。各 Agent 不自行切分支、提交或修改他人文件。独立验收分配给未参与该项实现的实例；最终 Claude 测试另行执行。

## 当前状态

| 任务 | 过程状态 | 证据与下一步 |
|---|---|---|
| T00 | 契约与受控SDK验证通过；部署/配置基线待收口 | 契约与受控DSH SDK验证见`0e2acc83849a8203a80ed5c1cb1cd892d990eabd`；schema v2 offline preflight提交`74cff64ac7a053dd56bc7939603eb840e21bbd45`，测试7/7；实际仍`ready=false`，唯一阻断为仓库缺生产`run-persistent` profile快照，且无真实服务/网络验证。T00剩余项需按技术验证证据清单闭环 |
| T01 | PGlite迁移与边界测试通过；真实PG/打包待验 | `cafe3b414f77ce5d4591699ea1c7378175a7b4da`统一默认迁移源、PG fail-closed及事务原子迁移；策略校正与独立审查提交`0e738384c37924e2911fc68c659ec891950e1667`；当前策略联合10/10，真实磁盘PGlite覆盖旧数据保存、旧token撤销、实际受控OIDC callback新session重启持久。真实PostgreSQL、干净打包和生产恢复未验，不标整体完成 |
| T02 | Google 登录本地集成限定验收通过；待正式配置与全链路验证 | Google OIDC底层`5ec2d442cdea1b3a5e2f3ac6c44591c61cc4d201`；集成提交`98c0411f8ec101e48ff1aff1cf6397ece0356663`，证据更新`fa91c6bcb20fdc368df7f51e855b3007f11683c8`。adapter独立验收与联合测试通过；server/UI独立集成复核3/3、绑定反例独立2/2、实现冒烟1/1；OIDC／存储聚焦回归52/52（2项loopback测试在批准的沙箱外权限重跑通过）。可信绑定同步撤销旧Session；配置及真实Google、目标HTTPS、浏览器体验仍待环境验证。证据`docs/refactor/evidence/T02-integration.md`、`T02-integration-review.md`、`T02-binding-review.md`。T02未整体完成 |
| T03 | store／执行服务及基础 HTTP 接线完成，整包仍进行中 | 接线 commit `f484924376bf01645a7f709a35631599b8c1e169`；HTTP排队、跨租户访问边界与游标重连验收代码在 `6b72810b7cea80bf1fccb608ecf6a836688822bf` 基础上继续增强，最新提交待补录。新增 `/api/runs` 查询、事件（JSON/SSE及游标回放）、取消；旧 `/api/chat` 纳入持久 run、幂等重放、durable SSE投递与启动恢复。双用户强制排队HTTP取消、跨租户读/取消拒绝、Last-Event-ID终态重连、focused PGlite回归通过；尚缺浏览器断线重连、真实多进程PostgreSQL及故障恢复验收。worker lease、预算熔断、外部 provider 查询/reconciliation闭环尚未完成，不标T03整包完成。详见`docs/refactor/evidence/T03-http-integration.md` |
| T04 | 纯调度模块独立通过，真实runtime并发待实现 | `06e88e46df22cfd393e2382354dc340575438a36`；复验19/19；尚未证明DSH SDK同进程真实并发、取消收敛、事件与资源边界 |
| T06 | 能力生命周期纯模块独立通过，目录接线待实现 | `21098eb92133f0a341f4548a23d6789cacd74ad4`；首验3处FAIL、修复后21/21独立通过；尚未接每日目录同步、持久缓存、权限范围或AUTO运行时 |
| T05 | Registry Schema校验子范围 PASS；整包仍未完成 | commit `39d324dd32de9fbf39c49749f2c07798ef6677a2`；Ajv精确直接依赖、非法输入在logger/executor前拒绝、版本竞态和stale executor首验缺陷均独立复验通过（18/18）。首验FAIL→修复→PASS证据见`docs/refactor/evidence/T05-schema-review.md`。DSH直连工具桥接及完整权限/报告/沙箱仍未验 |
| T10 | 产物路径子范围修复并独立通过，整包未完成 | commit `33210cbf8a9d79b68aa9f2a39ad7a48ac65efc77`；`artifacts.cjs` 跨平台反斜杠归一化、拒绝盘符相对路径及C0/C1控制字符；实现75/75 + 边界1/1，独立反例发现DEL/NEL后修复复验通过，见`docs/refactor/evidence/T10-artifact-path-review.md`。产物归属、持久化、下载与文档包格式仍待验 |
| T07–T09、T11–T18 | 未交付 | 按依赖批次推进；不会以模块自测替代独立验收或端到端验收 |

### 2026-10-16 · T03 执行生命周期服务子范围（过程记录）

新增 `shell/tasks/execution.cjs`，用注入式 executor 接通已验收的持久 store 与 T04 scheduler：幂等 replay 短路、串行事件持久化、终态记录、按 runId 取消并等待执行器收敛。新增真实临时磁盘 PGlite 集成测试 `tests/regression/task-execution-test.mjs`。独立首验 FAIL 抓到 rejected event tail 未终态化、晚完成与取消回执不一致两项；修复并加入反例后，原独立 reviewer `/root/architecture` 限定复验 PASS（联合测试7/7，两个原反例独立受控 probe 均闭环）。命令 `node --test tests/regression/task-execution-test.mjs tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs`：7/7 PASS，Node v24.14.0，无外部 PG／网络／DSH／PT 调用。证据 `docs/refactor/evidence/T03-execution-service.md`。此结论仅是服务模块子范围；不宣称 T03 完成。HTTP/SSE／重连、旧 `/api/chat` 接线、worker lease 与重启恢复扫描、预算和外部 provider 查询仍未交付。

### 2026-10-16 · 前端框架评估结论

PM 同意：本期保留现有原生 HTML/CSS/JavaScript，不做全量 Vue 迁移；Vue 可作为后续渐进演进方向，优先考虑状态复杂且边界清晰的新页面（如任务中心、用量日志），聊天页须等 SSE、取消、附件和产物行为通过真实浏览器验收后再评估迁移。采用 Vue 不等于前后端部署拆分；若后续启动，可独立构建静态产物，由现有 Node 服务同源提供页面与 `/api/*`，继续使用同源 Cookie/SSE。此项为路线决策记录，不是本期新增实现承诺；若变更为一期范围，须先修订 T16、工时和验收标准。

### 2026-10-16 · T03 持久 Run 到 HTTP/SSE 的接线（过程记录）

将 `/api/chat` 接入持久 run 生命周期，新增 run 查询、事件分页／SSE游标回放与取消路由；新请求在executor启动前即取得runId和queued事件。legacy SSE仅从已持久化事件投递，终态帧在state与done事务提交后发送；executor在ready前失败通过执行结果竞速收敛，避免HTTP悬挂。独立审查发现queued→running与取消CAS竞争，修复为REVISION_CONFLICT后重读重试，并新增`globalLimit=1`确定性模块反例；另扩展双身份HTTP集成测试，真实排队第二个用户请求并通过Run API取消（测试夹具只延迟首任务）。独立复核该CAS修复PASS；HTTP集成1/1通过，模块回归21/21，Node v24.14.0，本地PGlite与受控身份，无真实Google、DSH/PT请求。**待补**：浏览器断线重连、真实多进程PG、worker lease、预算与provider reconciliation；所以只记录接线子范围通过，不宣布T03整包完成。完整证据见`docs/refactor/evidence/T03-http-integration.md`。

未进行真实Google授权、PT模型/媒体付费调用、生产PostgreSQL或部署验证。`.env`不读取；测试临时环境不继承Key。子Agent两次遇到平台用量限制后已按轮换方式继续；不降低独立验收要求。当前未合并main、未部署、未push；全任务仍需Claude整体验收和全新Claude Code测试。
