# PG 切换说明（PGlite → 真实 PostgreSQL）

## 目标
把业务壳的数据库从 PGlite（PostgreSQL 的 WASM 单文件版）切到真实 PostgreSQL，但**对外接口不变**：
`db.query(text, params)`、`db.exec(sql)`、`db.transaction(cb)`、`close()`，以及上层
`conversations.get/list/create/saveMessages/rename/remove`、`auth`、`keys` 的方法签名全部不变。

因此上层 `server-v3.cjs`、`auth.cjs`、`keys.cjs`、`conversations.cjs` **基本零改动**。

## 文件改动清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `conv/db-pg.cjs` | **新增** | 真实 PG 适配层（node-postgres/pg），实现与 PGlite 一致的 `{ db, close }` 接口 |
| `shell/db.cjs` | 修改 | 加「可切换」：检测到 `PT_PG_*` 配置就走 PG，否则走原 PGlite（不改 PGlite 逻辑） |
| `conv/PG切换说明.md` | **新增** | 本文档 |

> 未改动 `auth.cjs` / `keys.cjs` / `conversations.cjs` / `server-v3.cjs` / 迁移 SQL。
> 现有 8099 服务（PGlite）不受影响：它由 `run-local-v10.cjs` 复制到临时目录运行，且未设 `PT_PG_*`。

## 连接配置（环境变量）

| 变量 | 含义 | 默认 |
|------|------|------|
| `PT_PG_DSN` | 完整连接串，优先级最高。例 `postgres://user:pass@host:5432/db?sslmode=require` | 无 |
| `PT_PG_HOST` | 主机 | `127.0.0.1` |
| `PT_PG_PORT` | 端口 | `5432` |
| `PT_PG_USER`（或 `PT_PG_USERNAME`） | 用户名 | `postgres` |
| `PT_PG_PASSWORD` | 密码 | 空 |
| `PT_PG_DATABASE`（或 `PT_PG_DB`） | 库名 | `northstar` |
| `PT_PG_SSL` | TLS：`require`=强制TLS且校验证书；`no-verify`=强制TLS不校验证书（自签/内网）；不设/`off`/`0`=`false`=不启 TLS | 不启 |
| `PT_PG_POOL_MAX` | 连接池上限 | `10` |
| `PT_PG_CONNECT_TIMEOUT_MS` | 连接超时（毫秒） | `5000` |
| `PT_PG_LIB` | 覆盖 pg 包入口（`lib/index.js` 绝对路径，找不到依赖时用） | 无 |

- 判定「要用 PG」：只要 `PT_PG_DSN` / `PT_PG_HOST` / `PT_PG_DATABASE` / `PT_PG_DB` / `PT_PG_USER` 任一被设置。
- 判定「用 PGlite（回退）」：以上全为空 —— 与现在行为一致，现有测试/8099 服务不动。

## 表结构（与 PGlite 对齐，SQL 完全兼容）

建表仍复用现有迁移文件（`shell/db-migrations/*.sql` + `conv/004_conversations_v2.sql`），
这些 SQL 就是标准 PostgreSQL 语法（`CREATE TABLE IF NOT EXISTS`、`UUID` 主键
`DEFAULT gen_random_uuid()`、`JSONB`、`TIMESTAMPTZ`），在真 PG 上直接可跑，**无需改写**。

最终表：

- `schema_migrations`（db.cjs 的 migrate 自己建，记录已应用迁移文件名）
- `tenants(id uuid PK, name text, created_at timestamptz)`
- `users(id uuid PK, tenant_id uuid FK, username text UNIQUE, email text UNIQUE, password_hash text, role text, created_at timestamptz)`
- `sessions(id uuid PK, user_id uuid FK, token_hash text UNIQUE, expires_at timestamptz, created_at timestamptz, last_seen_at timestamptz)`
- `api_keys(id uuid PK, user_id uuid UNIQUE FK, ciphertext text, iv text, key_last4 text, created_at timestamptz, updated_at timestamptz)`
- `conversations(id uuid PK, user_id uuid FK, title text, messages jsonb, created_at timestamptz, updated_at timestamptz)`

## 兼容性要点（已做处理）

1. **JSONB 参数**：`conversations.cjs` 原本就 `JSON.stringify(arr)` 后 `$1::jsonb`，pg 同样支持文本→jsonb 强转，无需改。
2. **JSONB 返回**：pg 会自动把 json/jsonb 解析成 JS 对象/数组；`conversations.cjs` 的 `normalize()` 已兼容「数组 / 字符串」两种形态，直接可用。
3. **时间戳**：pg 返回 `Date`，`conversations.cjs` 的 `iso()` 已处理 `instanceof Date`。
4. **UUID**：pg 与 PGlite 都返回字符串，`users.id`/`tenant.id` 等直接可用。
5. **事务**：`auth.cjs` 用 `db.transaction(async (tx) => { await tx.query(...) })`；适配层用真实 `BEGIN/COMMIT/ROLLBACK` 实现同签名。
6. **`db.exec`（跑迁移多语句 SQL）**：不带参数走 pg 的「简单查询协议」，一条字符串可含多条语句（真实 PG 语义）。

## 启动真实 PG 后的验证步骤

前提：`pg` 已可用（本仓库 `pt-test/analytics/node_modules/pg` 已有 8.23.0；或在 shell 目录 `npm install pg`）。

```powershell
# 0) 确认 pg 依赖可用（任选其一满足即可）
#    本仓库已装：pt-test\analytics\node_modules\pg（8.23.0）
#    或： cd pt-test/shell; npm install pg

# 1) 起一个 PostgreSQL（例如 Docker）
docker run --name northstar-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=northstar -p 5432:5432 -d postgres:16

# 2) 设连接环境变量并启动业务壳（以 run-local-v10.cjs 为例，环境变量会透传给子进程）
$env:PT_PG_DSN = "postgres://postgres:postgres@127.0.0.1:5432/northstar"
node pt-test/conv/run-local-v10.cjs   # 或按你的启动方式

# 3) 观察启动日志出现：
#    [db] 检测到 PT_PG_* 配置，切换到真实 PostgreSQL（忽略 dataDir：...）

# 4) 登录后验证：
#    注册/登录 -> 建对话 -> 发消息 -> 刷新页面对话还在 -> 改标题 -> 删除对话
#    重启服务后登录态与对话应仍存在（数据落真 PG）

# 5) 直接查库确认（可选）
docker exec -it northstar-pg psql -U postgres -d northstar -c "select id, username from users;"
docker exec -it northstar-pg psql -U postgres -d northstar -c "select id, title, messages from conversations;"
```

## 未测 / 边界说明（诚实声明）

- 本机**无运行中的 PostgreSQL**（`Get-NetTCPConnection -LocalPort 5432` 无监听），故 **PG 分支未做端到端实测**。
- 已通过：`node --check` 语法检查（`db-pg.cjs` 与 `db.cjs`）+ 非网络逻辑走查（`pgConfigured`/`buildConfig`/`resolvePg` 能正确解析出本仓库的 pg 包并生成连接配置）。
- 需在真实 PG 上最终确认的点：`db.exec` 多语句迁移、`transaction` 提交/回滚、JSONB 往返、scrypt 会话落库（这些是 pg 的标准能力，预期正常，但未实测）。
