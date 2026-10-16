# 北极星一期重构工作记录

本文件是 Codex 开发过程记录，**不是正式《北极星总文档》**。用户于 2026-10-16 授权从 T00 开始；正式总文档在整体验收后由用户根据实际结果发布。本记录及本地 v1.11 不取代正式总文档，不提前宣布任务包 D 或旧架构修订稿作废。

## 开工约束

集成分支：`feature/northstar-phase1-refactor-20261016`。起点：`a2adbee64c326653dbf5bfed3f918dd09f96589d`。T00–T18 仅在该分支实施，不合并 main、不部署。全部完成后仍须 Claude 整体验收及全新 Claude Code 完整测试，不能以 Codex 自测替代。

每次交付记录任务、分支、完整 commit hash、文件与接口／迁移变化、验证命令和环境、证据时间／ID、外部阻塞及结论。证据文档不能记录秘密，未知不能当通过。

## 批 0 文件归属（2026-10-16）

| 角色 | 专属改动范围 | 当前任务 |
|---|---|---|
| 主 Agent | 六共享接缝、集成、工作记录；本批存储入口与聚焦测试 | 基线保护、安装依赖、T00 集成、T01 迁移源核查 |
| 子 Agent A | `tests/probes/northstar-*`、`evidence/T00-dsh.md` | 真实 SDK 受控上游验证；无付费 Key 调用 |
| 子 Agent B | `shell/contracts/phase1.cjs`、对应契约测试、`evidence/T00-contracts.md` | 版本化关联对象、状态及事件契约 |
| 子 Agent C | `scripts/northstar-preflight.mjs`、对应测试、`evidence/T00-dependencies.md` | 依赖与外部条件检查，脱敏输出 |

`server.cjs/tenant.cjs/persistent-runner.mjs/public/app.js/public/index.html/public/styles.css` 本批唯一集成人为主 Agent，子 Agent 不修改。各 Agent 不自行切分支、提交或修改他人文件。独立验收分配给未参与该项实现的实例；最终 Claude 测试另行执行。

## 当前状态

| 任务 | 过程状态 | 证据与下一步 |
|---|---|---|
| T00 | 进行中 | 专用分支已建立；安装锁定依赖；真实 SDK、契约与外部条件并行核查 |
| T01–T18 | 未交付 | 按契约与前置证据分批推进，不因并行工作跳过验收 |

本轮没有真实 Google、PT 付费调用、生产 DB 或部署验证。外部凭据只检查存在性，不输出其内容；测试预算未给定时不发起媒体付费生成。
