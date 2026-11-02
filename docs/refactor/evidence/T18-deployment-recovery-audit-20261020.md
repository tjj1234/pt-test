# T18 部署与恢复材料只读审计（2026-10-20）

**结论：T18/AC24 继续 blocked。** 当前运维说明主要写目标流程和验收条件，不能当作部署完成或恢复演练报告。仓库有 DSH profile/settings 局部升级恢复能力和受控回归，但未见应用数据库、附件、BYOK 主密钥的真实恢复演练，也未见告警触发/恢复演练、应用级升级回滚或独立交付验收。2026-10-21 部署清单已记录 r5 在选定目标试运行主机部署及用户回传的登录、会话持久化和 HTTPS health 结果；这属于受控试运行证据，不等于最终候选 clean-release 或生产验收。本文仅依据仓库中的部署记录和用户回传摘要更新，未独立访问目标主机、运行测试或修改代码。

## 2026-10-22 部署证据增补

部署清单记录：目标为 `agent-fat.adorado.top` 的 Ubuntu 26.04.1 全新测试机/数据库；r5 包已上传并校验、安装依赖、提交 19 条迁移，shell 服务启动；用户回传 Google 登录成功、PostgreSQL 中有 2 个用户/Google identity/active session，shell 重启后会话仍有效且 HTTPS health 通过（部署清单第 3、13–16、24 行）。这证明目标试运行环境已选定并运行 r5 的若干基础路径。证据来自仓库所记用户回传，并非本次独立线上核验。

该部署不能关闭 T18：r5 来源于未提交工作树；尚无最终冻结候选的目标环境 clean-release 证据，也没有应用数据库及附件/Skill/必要配置与 BYOK 主密钥的冷备恢复演练、告警触发及恢复演练、应用级数据库/产品版本回滚演练、RPO/RTO 实测，或 Claude 独立整体验收和全新 Claude Code 最终测试记录。故 T18/AC24 维持 `blocked`；“已有目标试运行部署”应与“生产交付验收通过”分开表述。

## 2026-10-22 本地脚本与发布材料核查

仓库未发现应用级 DB/附件/workspace/配置备份或恢复脚本，也没有描述这些运行数据的 deployment manifest。`scripts/northstar-profile.cjs` 与 `shell/runtime/profile-lifecycle.cjs` 的 `restore-backup` 只恢复 DSH `run-persistent` managed profile；它依赖 profile 自己的 journal、backup 名称和 manifest hash，不能恢复 PGlite/PG、附件或 BYOK 密文。`shell/runtime/dsh-release-manifest.json` 绑定的是 DSH 包文件、vendor、lock 与 hash；`docs/dsh-profile-snapshot/run-persistent/northstar-profile-manifest.json` 描述从仓库构建的 DSH profile 文件，两者都不是运行数据备份清单。静态列出 `release-artifacts/northstar-controlled-trial-20261021-r5.tar.gz` 未发现 app backup/restore entry、运行 DB、附件、workspace 或 master key；部署清单第 167 行也说明发布包排除 `.env*`、`secrets/`、上传附件和运行数据库。发布包 checksum 只识别包字节，不记录或封存运行数据。

针对唯一相邻的真实恢复入口运行现有隔离 fixture：`node --test tests/regression/profile-maintenance-cli-test.mjs`，结果 1/1 PASS。夹具仅在 `os.tmpdir()` 创建临时 DSH home、测试 rebuild 将旧 profile 和 operator note 保存在 backup，并验证缺少有效 recovery journal 时 `restore-backup` 被拒绝；测试 teardown 删除该临时目录（测试第 13–15、31–42 行）。这只是 profile rebuild/拒绝路径证据；没有验证 profile restore-backup 成功路径，更不是应用级备份恢复。未连接 PostgreSQL、未读取真实环境配置或密钥、未访问线上。

### 可独立实现与验收的最小应用数据子范围

首个安全实现应严格限定在本机合成数据的 PGlite 冷备/恢复 fixture；不能自动识别后便操作未知目标库。实现与验收清单：

1. 在备份入口中显式记录已选 backend。PGlite 仅允许操作者确认进程已停止后，对明确给出的完整 `PT_DB_DIR` 做冷备；出现 `PT_PG_DSN` 或 PG 连接配置时必须拒绝文件复制并提示走单独的 PostgreSQL 备份流程。不要把 `PT_DB_DIR` 当成 PG 实际数据目录。
2. 要求绝对 source/target 路径；拒绝 source 等于 target、任一方包含另一方、符号链接或非普通目录；恢复必须写入全新空目标，已有目标只允许显式保留到隔离路径，不自动覆盖或递归清理。命令失败时非零退出，并保留 source。
3. PGlite fixture 同步覆盖 `PT_DB_DIR`、`PT_RUNTIME_DIR/_uploads`、`workspaces/<tenantId>`、共享 `workspace/.dsh/skills` 与必要 DSH settings。manifest 只列相对路径、类型、大小、hash、迁移/应用版本和时间；不写入 DSN、环境变量值、附件正文或任何凭据。`_tmp`、可再生 catalog cache、日志按独立策略排除。
4. 主密钥不进入普通归档或 manifest； fixture 使用临时生成的合成 master key，并在独立临时秘密通道复制到恢复侧。分别验证合成 BYOK 密文可解密、缺失/错误 master key 明确失败。真实环境密钥备份、解密、密钥轮换和 Windows DPAPI 跨身份恢复不纳入自动化子范围。
5. 恢复验收使用合成用户/租户、会话、对话/Run、附件与产物：检查记录可读、上传 hash 和 size 一致、附件归属不跨租户、附件授权失败时拒绝、workspace 产物可读、Key 解密成功；故意破坏一个文件/hash 时必须非零退出，且不得输出秘密。
6. PostgreSQL 另开隔离 disposable 实例做后续验收：使用该环境支持的 `pg_dump`/恢复流程，记录 schema/data 与所需 roles/grants；清楚证明程序未使用生产 DSN。PGlite fixture PASS 不得外推为 PG 或目标环境恢复通过。

T18 整包仍需在目标环境验证备份保留/加密/删除、告警触发与恢复、RPO/RTO、应用升级回滚及独立交付。生产服务停机、在线数据库备份、真实数据/密钥复制与解密、写目标配置或覆盖现存恢复目录均需独立运维授权，不应包含在自动 fixture 或默认 CLI 路径中。

## 证据分类

| 范围 | 当前可证明 | 缺口与边界 |
|---|---|---|
| Runbook 与部署环境 | [`北极星部署升级与维护说明-v1.0.md`](../../北极星部署升级与维护说明-v1.0.md) 给出 Node/配置、迁移、升级、回滚、备份、监控与恢复的目标流程；文档第6–10行声明这是重构前运维规格，不是部署完成报告。另据[`北极星受控试运行部署命令清单-20261021.md`](../北极星受控试运行部署命令清单-20261021.md)第3、13–16、24行，目标主机已选定，r5 已部署，用户回传 Google 登录、会话持久化和重启后 HTTPS health 通过。 | 受控 r5 试运行不是最终冻结候选的 clean-release，也不是生产验收；本文未独立核验线上环境。仍缺目标候选安装/升级与回滚演练及完整交付证据。运维说明第39、41、73–75行仍要求目标环境验证。 |
| 数据库与文件备份恢复 | 文档第124–132行定义需备数据库、主密钥、上传/产物、workspace、Skill/profile/config，要求冷备、独立目录恢复并校验真实记录、附件授权和 BYOK 解密；第126行明确旧记录中的 `backup.cjs`、`restore.cjs`、`key-migrate.cjs`、`key-import.cjs` 当前不可执行/未找到。 | 未见应用 DB、附件、Skill 与配置一致性备份脚本或目标数据恢复演练；PGlite/PG 局部存储与迁移夹具不等于此恢复验收。RPO/RTO 仍需演练测量。 |
| 升级与回滚 | `scripts/northstar-profile.cjs` 暴露 profile `restore-backup` 与 settings upgrade/recovery/rollback 操作；`shell/runtime/profile-lifecycle.cjs` 通过 journal、hash 验证和显式恢复回退 profile。WORKLOG 第17、49–53行记录 settings/profile 局部回归通过。 | 这是 DSH profile/settings 文件事务的局部回滚，不是应用数据库 schema 回滚、全量数据恢复、目标环境升级或产品版本回滚演练。WORKLOG 第208–219行所记 T16 回归与 CLI/HTTP smoke 均为本机或受控夹具证据。 |
| Key 与主密钥 | [`shell/keys.cjs`](../../../shell/keys.cjs) 有 AES-GCM 用户 Key 加密、非 Windows `raw-0600` 主密钥文件及 Windows DPAPI CurrentUser 保护；运维说明第63、67行提醒跨机/身份边界和主密钥丢失风险。 | 未见应用数据密钥迁移、主密钥备份恢复或跨机恢复演练。DPAPI CurrentUser blob 不可假定能在另一台机器或服务身份下解密；重置应用登录密码不能恢复失去的主密钥。 |
| 健康与告警 | `shell/server.cjs:1075–1084` 的 `/healthz` 返回 `ok/status/version/pid/uptime/ts`，可证明进程响应。运维说明第41行明确其不代表 Google、数据库恢复、DSH、模型或工具可用。 | 当前响应只反映进程级探活，不是依赖就绪；未见告警接线或进程退出、DB不可用、Run无进展、队列积压、磁盘/配额、备份失败的触发与恢复演练。运维说明第149行列的是目标告警面。 |
| 最终交付 | [`ACCEPTANCE-STATUS-20261018.md`](../ACCEPTANCE-STATUS-20261018.md) 第67、98行将 T18、AC24 标为 `blocked`；T18 任务包第513–519行要求新环境安装、旧数据升级/恢复、Google/BYOK/DSH/文件/日志闭环、发布记录和独立交付结论。r5 受控试运行部署及用户回传的部分路径结果见 2026-10-21 部署清单。 | 已有目标试运行部署，但未见应用数据恢复、告警、应用级回滚或最终独立验收证据；不能将 r5 登录/health 或 profile/settings 测试提升为 T18/AC24 通过。 |

## 最小 runbook 增量

deadline 前最小可补的是将运维说明第130–132行的原则要求写成一份可按步骤执行的 PGlite 冷备/独立目录恢复清单：停止并确认进程退出、记录源版本/迁移与数据目录、备份及校验归档、恢复到新目录、启动后验证历史用户/对话和附件读取及 BYOK 解密、确认失败返回非零，并记录 RPO/RTO 待测值。命令模板和检查表只提高可操作性；没有在隔离目标环境实际演练，仍不构成恢复证据或关闭 T18。
