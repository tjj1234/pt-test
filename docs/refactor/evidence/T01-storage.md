# T01 · 存储迁移源收口与真实旧库升级

日期：2026-10-16。基线：`a2adbee64c326653dbf5bfed3f918dd09f96589d`；分支 `feature/northstar-phase1-refactor-20261016`。实施者：架构子 Agent。结论：**默认迁移源和关闭所有权的定向修改、自测通过，待独立验收；不代表 T01 全部完成。**

| 文件 | 改动 |
|---|---|
| `shell/storage/index.cjs` | 默认由旧 `storage/migrations` 改为 `shell/db-migrations`，与 auth 默认一致；显式旧目录覆盖保留；两条 close 入口共用一次关闭 Promise |
| `shell/storage/README.md` | 更新唯一默认源、升级与连接所有权，删除“权威仍在 conv”等过期声明，明确真实验证和剩余债务 |
| `tests/regression/storage-upgrade-test.mjs` | 新增两项测试：完整默认源检查、真实 PGlite 旧库升级与持久性／关闭测试 |

没有删除迁移快照、改 SQL、重编号、删库重建或重写仓储；未修改 db.cjs、auth.cjs、server.cjs 等共享文件。主 Agent 同批负责 db.cjs／db-pg.cjs 的迁移事务与显式 PG 失败语义，该部分不在本子 Agent 自证范围内。

## 实测路径与结果

环境 macOS、Node `v24.14.0`、声明依赖 PGlite `0.5.8`。依赖由主 Agent 完成 `npm ci` 后使用，未绕过缺失依赖或采用 mock 替代。测试创建系统临时目录和独立 master key；所有数据为合成夹具，不请求 PT；成功或失败均清理测试目录。

1. 用旧 `shell/storage/migrations` 建真实磁盘 PGlite，仅应用原 001–006 六个文件，确认无 chat_usage。
2. 创建用户与真实 session，写有固定消息、标题的归档对话，写普通记忆和模型内部偏好；通过既有 keys 模块 AES-GCM 加密合成 Key。
3. 保存旧用户／sessions／conversations／user_memory／api_keys 全行快照，关闭真实连接。
4. 使用 `createStorage` 默认源重开；当前完整目录含 11 个迁移文件（含 `002_roles.sql`），确认 schema_migrations 与目录逐一对应、无重复；确认 roles／tool_calls／auth_accounts／chat_usage 存在，category／model_name 和 nullable token_count 正确。
5. 升级后的五类原行与升级前完全一致；原登录态有效，归档、消息、普通记忆、模型选择和 Key 解密正确。登录态检查会更新 last_seen_at，之后用新快照验证后续重启。
6. 重跑 migrate 不改应用记录；调用 Storage close 和 Adapter close 并发、再次 close，真实 auth 关闭只执行一次；重新打开无新增迁移，所有数据与 session 保留。
7. 新连接验证事务提交落盘、抛错回滚、回滚后连接仍可查询。

| 完整命令 | 实际结果 |
|---|---|
| `node --test tests/regression/storage-upgrade-test.mjs` | 2 tests／2 pass／0 fail／0 skip，约 1.0 秒真实数据库用例 |
| `node tests/regression/seam-test.mjs` | 19 通过／0 失败，契约与 mock 事务 |
| `node tests/regression/seam-smoke.mjs` | 14 通过／0 失败，真实 PGlite、用户／对话隔离／记忆／Key／事务 |
| `git diff --check -- shell/storage/index.cjs shell/storage/README.md` | exit 0 |

测试输出的“B14 PT_DASH_INTERNAL_KEY 未配置”仅表示未启用业务看板 token 签发；本测试不声称验收该能力。非 Windows 既有 key 模块提示 raw-0600 主密钥，本次只验证旧加密数据可继续读取，未把它升级为生产密钥托管。

## 未覆盖与风险

- **真实 PostgreSQL 未执行，不能标 PASS。** 测试发现任何非空 `PT_PG_*` 即失败，避免误触外部数据库；目标 PG 的迁移、连接、备份仍须独立验证。
- Schema 已升级不等于服务生产入口已经全量通过；本批未跑 Google、真实 DSH、多模态、UI 或生产部署。
- 旧 `storage/migrations` 保留可能误用；README 明确不能向其中添加新迁移，生产默认已收口；显式目录参数为兼容保留，不能据此宣称所有外部脚本都自动改好了。
- 关闭一次保证限于 Storage 的两个公开入口；直接使用 auth.close 或 db.close 会绕过它，应由产品生命周期统一关闭。auth 仍拥有连接，仓储初始化失败后的统一清理与跨仓储事务化留后续，不隐瞒。
- 不为本次升级新建平行数据库或迁移权威。回滚本次代码可恢复旧默认目录，但不会撤销已成功应用 SQL；生产回滚涉及数据库兼容性与备份恢复，不能简单反向执行旧迁移。
