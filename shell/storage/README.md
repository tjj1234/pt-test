# storage/ —— 存储接缝（Slice 1 + Slice 1.5 收口）

## 这层是什么

`storage/` 是「抽接缝」的最小落点：**只把现有存储模块包成统一入口 + 显式契约，不重写任何 SQL/迁移/业务逻辑。**

```
业务 Service（server.cjs 未来只依赖这里）
        ↓
Repository（auth / conversations / keys / memory，签名不变）
        ↓
StorageAdapter（query / transaction / close）
        ↓
db.cjs（PGlite / PostgreSQL，已由 open() 抽象成同一形状）
```

## 文件

| 文件 | 作用 |
|---|---|
| `contract.cjs` | 契约形状 + `assertAdapter`/`assertRepository` + `TRANSACTION_SEMANTICS` |
| `index.cjs` | `createStorage()` 薄适配：返回 `{adapter, repositories, db, ownsDb, migrate, close}` |
| `migrations/` | **唯一权威迁移目录**（001–006），`storage.migrate()` 幂等执行 |

## Slice 1.5 收口结果

### A · conversations 分叉已消除

权威实现唯一 = `conv/conversations-v2.cjs`（含 `setArchived`/`search`）。
- `shell/conversations.cjs` → 转发层指向权威 v2；
- `conv/conversations.cjs`（v1）→ 转发层指向权威 v2。
- 已验证：两个旧文件 `require` 回来的是**同一个** `initConversations` 函数（不是复制）。

### B · 迁移入口已统一

- `shell/storage/migrations/001-006` 是唯一权威来源（001–003 原在 `shell/db-migrations/`，004–006 原在 `conv/`）。
- 执行语义（沿用 db.cjs 稳定逻辑，未重写执行器）：
  - **谁执行**：`createStorage()` 内部 `initAuth` 调 `dbmod.migrate()`；也可 `await storage.migrate()` 幂等重跑（升级用）。
  - **顺序**：按文件名排序（`schema_migrations` 表记录已应用名，重复启动跳过）。
  - **幂等**：`CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`，叠加 `schema_migrations` 双保险。
  - **PGlite 与 PG 同一份**：`db.open()` 对两者返回同一 `{db, close}` 形状，`migrate(db, dir)` 对两者通用。

### C · 连接所有权已明确

- `auth.cjs` 打开并**拥有** db 连接；`createStorage()` 返回 `ownsDb: false`。
- storage 复用 `auth.db`，**不重复打开第二个 PGlite 实例**。
- `close()` 唯一所有权：storage 的 `close` 委托给 `auth.close()`，绝不重复关闭。

### D · transaction 语义已固化

`contract.cjs` 的 `TRANSACTION_SEMANTICS` 声明六条（commit-on-resolve / rollback-on-reject / 可复用 / 无状态泄漏 / 仓储用 tx / PGlite=PG）。
`seam-test.mjs` 用 mock db 验证了成功路径 commit、抛错路径 rollback、rollback 后连接可用。

## 剩余技术债（不在本切片做）

1. **`auth.cjs` 仍自己开库**（不接收注入 db）——未来可改为「Storage Manager 拥有 DB，auth 借用」。
2. **仓储尚未事务化**——`TRANSACTION_SEMANTICS.repoUsesTx` 是声明，当前仓储方法内部仍用外部 `db.query`，未接收 `tx`。要真正事务化需重构各仓储签名（后续切片）。
3. **tracked `shell/` 树仍陈旧**——`shell/server.cjs`（旧单对话，用 `load/save`）、`shell/tenant.cjs`、`shell/public/*` 是旧单对话时代版本；权威树在 `conv/`，靠 `run-local-v12.cjs` 构建时覆盖。本切片只收了 conversations，**未收 server/tenant/public 的同步**（超出「只收口 conversations + 迁移」范围，需单独决策）。

## 验收状态

- [x] `createStorage()` 返回 `adapter` 满足 `assertAdapter`
- [x] 四仓储满足各自 `assertRepository`（含 setArchived/search）
- [x] 旧 conversations 文件不再分叉（转发层指向同一 v2）
- [x] 004–006 有唯一迁移入口 `shell/storage/migrations/`
- [x] transaction commit/rollback 有测试（mock 级）
- [x] `ownsDb: false` + close 唯一所有权有文档
- [ ] **真实 DB 冒烟**：`tests/regression/seam-smoke.mjs` 因沙箱 PGlite WASM `Array buffer allocation failed`（环境内存限制）未跑通；「模块导出通过」≠「DB 集成通过」，待资源充足环境补跑。
- [x] 无新增 SQL（迁移 001–006 是原样复制，未改动内容）
