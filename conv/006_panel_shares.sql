-- ============================================================================
-- 006_panel_shares.sql —— 归因面板分享（只读 + 整面板）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 语义：
--   · owner_user_id：分享发起人（1 用户 = 1 租户；可跨租户分享只读整面板）；
--   · token：分享链接里的唯一凭据（随机 48 位 hex）；
--   · expires_at：NULL = 永久；否则为到期时间；
--   · revoked_at：NULL = 未撤销；否则为撤销时间；
--   · last_accessed_at：最近一次被访问（落地页 / 校验 / 只读代理）的时间。
-- ============================================================================

CREATE TABLE IF NOT EXISTS panel_shares (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token            TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_panel_shares_owner ON panel_shares(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_panel_shares_token ON panel_shares(token);
