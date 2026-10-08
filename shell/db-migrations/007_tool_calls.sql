-- ============================================================================
-- 007_tool_calls.sql —— 工具调用日志（M1 · 工具调用接线 + 用户隔离）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 语义：
--   · 每次 executeTool() 真实分发前后各落库一次：先 INSERT（status='started'，
--     记录 input_summary 与调用时间戳），再 UPDATE（补 output_summary / duration_ms /
--     token_count，并把 status 置为 'completed' 或 'failed'）。
--   · workspace_id / tenant_id 是隔离红线：查询接口永远按当前 workspace 过滤，
--     不提供跨 workspace 读取。
--   · user_id 关联 users；tenant_id 关联 tenants；workspace_id 为派生字符串
--     （当前约定 "ws_" + tenant_id，见 server.cjs 的 createWorkspace）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_calls (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name      TEXT NOT NULL,
  input_summary  TEXT,
  output_summary TEXT,
  duration_ms    INTEGER,
  token_count    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'started'
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON tool_calls(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant    ON tool_calls(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_user      ON tool_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts        ON tool_calls("timestamp");
