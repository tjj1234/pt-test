# T01 存储改造独立审查

日期：2026-10-16。基线 `a2adbee64c326653dbf5bfed3f918dd09f96589d`；审查当前未提交增量 `shell/db.cjs`、`shell/db-pg.cjs`、`shell/storage/index.cjs` 及 storage-upgrade/db-failclosed 测试。审查者未参与实现，仅新增独立测试与本文，没有修改实现、依赖或共享入口。

**结论：FAIL，两个 PostgreSQL 错误分支仍泄漏未经处理的 driver message。** 实际执行：

```bash
node --test tests/regression/storage-review-test.mjs tests/regression/storage-upgrade-test.mjs tests/regression/db-failclosed-test.mjs
```

9 项，**7 PASS／2 FAIL，exit 1**。其中新增独立测试 4 项，2 通过／2 失败。首次独立夹具因误用 URL.pathname 没解码中文路径失败，已用 fileURLToPath 修正并重跑；不把该夹具错误登记成产品缺陷。

| 项 | 实跑证据与边界 |
|---|---|
| 独立 marker 写入失败 | 真 PGlite 中预建 schema_migrations CHECK 约束，禁止当前文件名；SQL 先 CREATE TABLE 并 INSERT 历史表，随后 INSERT marker 失败。验证新表不存在、历史表仍只原始行、marker 为 0；删除测试约束后重试两次，只新增一行与一个 marker。证明 marker 失败同样回滚 DDL／数据，不只测 SQL 自身失败 |
| 独立显式 PG 探活失败 | 隔离子进程用 PT_PG_LIB 指向本测试临时 fake driver，query 主动失败；实得 PG_CONNECTION_FAILED、无原始合成凭据标记，且 dataDir 未创建。证明失败不创建 PGlite fallback，不表示真实 PG 连接已验证 |
| 既有旧库升级 | 实际重跑 storage-upgrade 测试，真 PGlite 旧 001–006 升到完整迁移，保留用户、session、对话、归档、记忆与合成加密 Key；幂等重跑／重开、事务与close去重通过。B14 token 签发因未配内部 Key 被跳过；本轮不据此宣称 analytics 租户签发通过 |
| 既有 fail-closed | 显式 PG selectors、缺适配器不 fallback、SQL 失败原子回滚与修复重试均实际通过 |

## 需返工项

| 编号 | 已复现缺陷 | 最小修复方向 |
|---|---|---|
| SR01 | openPg 的 pool.query 失败后进入 catch，await pool.end 若也失败，则抛出 cleanup 原始错误，覆盖统一 PG_CONNECTION_FAILED。独立 fake driver 两处抛带合成凭据标记的 Error，子进程结果包含该标记 | 捕获清理失败，保持统一错误码与安全消息；清理失败仅记录固定安全 code，不能把 driver message／cause／连接串放回输出 |
| SR02 | pool.on('error') 回调直接 console.error(err.message)，独立 fake driver 触发 idle error 后 stderr 含合成凭据标记 | idle 错误日志输出固定类别与可信结构化字段，避免原始 message/stack；仍保留告警与不崩进程语义 |

合成标记不是真实凭据。fake driver 只注入行为和捕获 stdout/stderr，未联系数据库或网络，不能作为真实 PG、TLS、权限、锁冲突或连接池恢复验收。marker 事务语义目前真实验证仅 PGlite；真正 PostgreSQL 服务的迁移、恢复、启动失败／降权路径仍待后续独立环境验证。存储默认源已转向完整 db-migrations，但旧目录保留为历史兼容；不存在「目录内容必须逐字相同」这一生产条件。

本轮只确认上述范围；schema_migrations 并发启动锁、迁移缺目录／空目录、迁移校验和变更策略和初始化后失败清理等未在本轮得到完整运行证据，不将它们默认为已验证。

## 独立复验：本组存储边界通过

主 Agent 修复 SR01/SR02 后，审查者重新执行上述三文件联合命令：**9/9 PASS，exit 0**。查询失败并且 pool.end 也失败时仍得到 PG_CONNECTION_FAILED 安全错误，合成凭据标记不再出现在输出；idle error 也不再输出原始驱动消息。marker 失败原子回滚、修复重试、旧库升级及原 fail-closed 测试同时通过。当前结论更新为 **PASS（本组 PGlite 升级及 fake-driver 错误边界）**，历史 FAIL 保留。真实 PostgreSQL／TLS／生产连接池与恢复验证仍未完成，不能据此扩大验收范围。

## T02 Google-only 迁移后的口径校正

上述9项旧库升级独立复验发生在 Google-only 迁移政策加入之前，当时旧密码session按字节保留。随后 T02 明确退役密码登录并新增迁移删除**未绑定Google身份的旧sessions**；这一安全行为有意改变，不再要求旧密码cookie存活。主 Agent 已更新 `tests/regression/storage-upgrade-test.mjs` 与 T01-storage实施证据：用户、对话、记忆、加密Key保持；旧密码session清空；测试绑定Google身份后新建的session可跨重启保留。调整后 `node --test tests/regression/storage-upgrade-test.mjs tests/regression/google-session-upgrade-test.mjs tests/regression/google-auth-test.mjs` 为 **19/19 PASS**。该口径变化尚未由原T01独立验收者复核，T02集成独立审查仍进行中；不把T01旧的session保留结果套用到新的Google登录语义。

## 当前补充：Google-only 存储口径独立复核已完成

2026-10-16 后续复核见 [T01-google-policy-review.md](T01-google-policy-review.md)。新增真实磁盘PGlite升级→受控真实OIDC callback签发→磁盘重开验证；未绑定旧密码session失效、旧用户及资产保留、新Google callback session重启保留。与原Storage/PG错误边界联合 **10/10 PASS**。因此上节“该口径变化尚未复核”的时点状态已被本节取代；旧“密码session原样保留”结论作废，其余存储定向结论经本轮重跑仍成立。底层auth.login仍能构造session不等于产品开放密码登录，且它单独不能证明Google签发链路。真实Google／Web登录与真实PG不在此次放行范围。
