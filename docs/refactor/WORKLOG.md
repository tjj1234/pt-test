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
| T03 | 存储模块独立通过，执行闭环待接线 | `21021432c6bfc602d3a1b1223cad33b13e3e56be`；独立review与实现共测试通过；尚未接HTTP、scheduler、runner、预算/恢复 |
| T04 | 纯调度模块独立通过，真实runtime并发待实现 | `06e88e46df22cfd393e2382354dc340575438a36`；复验19/19；尚未证明DSH SDK同进程真实并发、取消收敛、事件与资源边界 |
| T06 | 能力生命周期纯模块独立通过，目录接线待实现 | `21098eb92133f0a341f4548a23d6789cacd74ad4`；首验3处FAIL、修复后21/21独立通过；尚未接每日目录同步、持久缓存、权限范围或AUTO运行时 |
| T05 | Registry Schema校验子范围 PASS；整包仍未完成 | commit `39d324dd32de9fbf39c49749f2c07798ef6677a2`；Ajv精确直接依赖、非法输入在logger/executor前拒绝、版本竞态和stale executor首验缺陷均独立复验通过（18/18）。首验FAIL→修复→PASS证据见`docs/refactor/evidence/T05-schema-review.md`。DSH直连工具桥接及完整权限/报告/沙箱仍未验 |
| T10 | 产物路径子范围修复并独立通过，整包未完成 | commit `33210cbf8a9d79b68aa9f2a39ad7a48ac65efc77`；`artifacts.cjs` 跨平台反斜杠归一化、拒绝盘符相对路径及C0/C1控制字符；实现75/75 + 边界1/1，独立反例发现DEL/NEL后修复复验通过，见`docs/refactor/evidence/T10-artifact-path-review.md`。产物归属、持久化、下载与文档包格式仍待验 |
| T07–T09、T11–T18 | 未交付 | 按依赖批次推进；不会以模块自测替代独立验收或端到端验收 |

未进行真实Google授权、PT模型/媒体付费调用、生产PostgreSQL或部署验证。`.env`不读取；测试临时环境不继承Key。子Agent两次遇到平台用量限制后已按轮换方式继续；不降低独立验收要求。当前未合并main、未部署、未push；全任务仍需Claude整体验收和全新Claude Code测试。
