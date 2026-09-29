-- ============================================================================
-- 007_tenant_analytics_tokens.sql —— 租户分析 token 关联（B14）
-- ----------------------------------------------------------------------------
-- 目标：为每个真实租户签发独立的分析 token，实现 /api/business/ 和 /api/analytics/
--       反代按租户隔离。token 明文不落盘，只存 SHA-256 哈希（与 analytics_tokens 表一致）。
-- 范围：新建关联表 tenant_analytics_tokens，关联 tenants.id 和 analytics_tokens.token_hash。
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenant_analytics_tokens (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE, -- 对应 analytics_tokens.token_hash
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引：通过 token_hash 快速反查 tenant_id（反代路由需要）
CREATE INDEX IF NOT EXISTS idx_tenant_analytics_tokens_hash ON tenant_analytics_tokens(token_hash);