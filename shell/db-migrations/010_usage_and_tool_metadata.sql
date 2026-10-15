-- ============================================================================
-- 010_usage_and_tool_metadata.sql —— 用量与日志子系统（任务包 A）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 改动 1：tool_calls 增加分类（Workflow/Skill/MCP）与「调用的模型」两个元数据列。
--         category 来自工具注册时的 type；model_name 由 media 类工具在生成后回填
--         （如 seedream-5-0-260128 / wan2.7-i2v）。
-- 改动 2：新增 chat_usage 表，记录「主对话轮次」的真实 token 用量与所选模型。
--         与 tool_calls 的子工具调用日志分开，互不混同。
-- ============================================================================

ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS model_name TEXT;

CREATE TABLE IF NOT EXISTS chat_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_usage_workspace ON chat_usage(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_usage_tenant    ON chat_usage(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chat_usage_user      ON chat_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_usage_ts        ON chat_usage("timestamp");
