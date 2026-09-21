# storage/ —— 存储接缝（Slice 1）

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
| `contract.cjs` | 契约形状声明 + `assertAdapter`/`assertRepository` 运行时自检 |
| `index.cjs` | `createStorage()` 薄适配：包住现有模块，返回 `{adapter, repositories, db, close}` |

## 现状（已经比预想好）

`conv/server-v5.cjs` **已经**不直接 `db.query`，链路是：

```js
auth = await initAuth({...});                       // 自己开库 + 迁移 + 种子
keys = await initKeys({ db: auth.db, ... });        // 复用 auth.db
conversations = await initConversations(auth.db);   // 复用 auth.db
memory = await initMemory(auth.db);                 // 复用 auth.db
```

所以「业务只依赖 Repository」**基本已成立**，本切片只是把它显式化 + 加契约断言。

## 已知接缝隐患（Slice 1 首个子任务要收口）

1. **conversations 三处分叉，权威版是 `conv/conversations-v2.cjs`**（含 `setArchived`/`search`，是 server-v5.cjs 真正要的接口）：
   - `shell/conversations.cjs` = 旧版单对话（`{load, save}`），已废弃；
   - `conv/conversations.cjs` = v1 多对话（无归档/搜索），已被 v2 取代；
   - `conv/conversations-v2.cjs` = **权威版**（`{list,create,get,rename,remove,saveMessages,setArchived,search}`）。
   - `run-local-v12.cjs:36` 明确 `conversations-v2.cjs → conversations.cjs` 复制改名。
   - `index.cjs` 已显式引用 `conv/conversations-v2.cjs`；收口时应让 `shell/conversations.cjs` 变成转发层指向权威版，消除分叉。
2. **`auth.cjs` 自己开库**（不是接收外部 db），导致 `auth` 是连接的「所有者」，其余仓储只能借它的 `auth.db`。这是当前接缝的形状；要不要让 `auth` 也改成「接收 db」是后续可选项，本切片不动它。
3. **`transaction` 语义**：PGlite 的 `db.transaction(cb)` 与 PG adapter（`conv/db-pg.cjs`）需要对齐——Contract 已声明 `transaction(callback)`，未来 PG Adapter 要实现同一形状（这是 PG 兼容测试的一部分，不在本切片做）。

## 验收（本切片）

- [ ] `createStorage()` 返回的 `adapter` 满足 `assertAdapter`（query/transaction/close 都在）
- [ ] 四个仓储满足各自 `assertRepository`
- [ ] 现有 PGlite 行为不变（登录/对话/key/记忆走同一套代码）
- [ ] 没有新增任何 SQL / 迁移
