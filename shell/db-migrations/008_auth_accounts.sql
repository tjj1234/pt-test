-- ============================================================================
-- 008_auth_accounts.sql —— 账户授权（非 GA）（M7 后端）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 契约（与 shell/public/settings.js M7 区块对齐）：
--   GET    /api/auth-accounts      -> [{id,tenantId,accountType,status,scope,updatedAt}]
--   DELETE /api/auth-accounts/:id  -> 解除该账户授权
--   accountType ∈ {SS-GTM, Meta, MCP}；status ∈ {有效, 即将过期, 需重验}
--
-- 隔离红线：tenant_id 关联 tenants，查询/删除永远按当前登录租户过滤，
--           不提供跨租户读取。
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL,               -- SS-GTM / Meta / MCP
  status       TEXT NOT NULL DEFAULT '有效', -- 有效 / 即将过期 / 需重验
  scope        TEXT,                        -- 授权范围（可空）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_accounts_tenant ON auth_accounts(tenant_id);
