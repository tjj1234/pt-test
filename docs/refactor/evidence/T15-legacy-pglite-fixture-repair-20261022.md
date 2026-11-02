# T15：旧版 PGlite fixture 升级路径修正（2026-10-22）

结论：`storage-google-policy-review-test.mjs` 与 `storage-upgrade-test.mjs` 的失败来自过期的测试 fixture 构造，不是默认初始化/迁移链回归。两项测试先用 `shell/storage/migrations` 构造旧 schema，却调用当前 `conversations.create()` 写入新列 `model_preference`；该列仅由默认迁移目录中的 `018_conversation_model_preference.sql` 添加。修复只限测试 fixture 与快照比较，没有改产品运行时代码或迁移。

## 证据与改动

- `shell/storage/index.cjs:23-40`：默认迁移目录为 `shell/db-migrations`，`createStorage` 将其传入 `initAuth`；传入 `migrationsDir` 时按测试要求使用指定目录。
- `shell/db-migrations/018_conversation_model_preference.sql:1-13`：新列允许 `NULL`，注释定义 `NULL` 为旧记录/尚未快照。
- `tests/regression/storage-google-policy-review-test.mjs:35-46`：测试明确用旧迁移目录初始化，并在重开默认存储前制造旧数据。现在通过 adapter 直接插入旧 schema 可接受的 `user_id,title,messages`，不调用会写新列的当前 `create()`。
- `tests/regression/storage-upgrade-test.mjs:47-68`：同样以旧迁移目录构造数据库；改为直接插入旧兼容行，再用现有仓库写入旧 schema 已支持的消息、标题和归档数据。
- 两项测试的资产快照分别在 `storage-google-policy-review-test.mjs:19-26` 和 `storage-upgrade-test.mjs:22-31` 忽略新增的 `model_preference` 字段。首轮修正后升级已成功，但原有 `SELECT *` 深比较因升级后行多出 `model_preference: null` 而失败；忽略该新增字段后，旧资产仍逐字段比较，符合此测试验证的“旧资产保留”范围。

## 本地验证

执行命令：

```sh
env -i PATH="$PATH" HOME=/tmp/northstar-t15-home TMPDIR=/tmp LANG=C.UTF-8 node --test tests/regression/storage-google-policy-review-test.mjs tests/regression/storage-upgrade-test.mjs
```

最终退出码 `0`；3 个测试通过、0 失败：独立 Google-only 策略与旧资产重开测试、默认完整迁移源断言、真实旧版 PGlite 升级/幂等重开测试。测试自行在 `/tmp` 创建带专属前缀的临时 DB/master-key 目录，并在 `finally` 中递归清除；输出中可见的两条权限警告不影响结果。环境使用 `env -i`，未向测试传入 `PT_PG_*`，测试另外会断言显式 PG 配置缺席。

## 边界与状态

这是两份定向本地回归，不是全量 CI，也没有触发 GitHub Actions、执行远端写操作、部署或修改共享运行时。T15 总体仍为 **blocked**：此前完整本地回归记录在 `T15-local-ci-execution-20261022.md`，本次修复未重跑全量 101-suite，也未消除其中其他失败；须依总证据继续处理。此处只证明指定两个旧 fixture 测试通过，不能推出 Actions 运行通过、branch protection 已核验或生产迁移已验收。
