-- ============================================================================
-- 001_auth.sql —— 多租户身份库（U1）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：全部 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
--       配合 db.cjs 的 schema_migrations 记录，重复执行无副作用。
-- 范围：只做身份（tenants / users / sessions）。api_keys（U2）、
--       conversations（U3）不在本迁移内，避免越界。
-- ============================================================================

-- 租户：1 用户 = 1 租户（注册时自动建一个并绑定）；为将来「一公司多用户」留接口
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用户：username 唯一；email 可空但唯一；密码只存 scrypt 哈希，永不存明文
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,           -- 格式：scrypt$N$r$p$salt_hex$key_hex
  role          TEXT NOT NULL DEFAULT 'member',   -- member / admin
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话：服务端存「token 的 SHA-256 哈希」，明文 token 只下发到客户端 cookie。
--       重启不丢：会话在库里，不是内存 Map。
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,     -- sha256(会话 token)
  expires_at   TIMESTAMPTZ NOT NULL,     -- 会话过期时间（可过期）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant     ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
