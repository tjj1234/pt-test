-- ============================================================================
-- 004_conversations_v2.sql —— 对话窗口化改造（1 用户 = 多对话）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：ALTER ... IF EXISTS / CREATE INDEX IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 变更点：
--   1) conversations 加 title（标题）、created_at（创建时间）两列；
--   2) 去掉 user_id 的唯一约束（旧：1 用户 = 1 条对话；新：1 用户 = 多对话）；
--   3) 加 (user_id, updated_at DESC) 索引，支撑「最近更新倒序」列表。
--
-- 消息结构升级为 {role, text, ts}（ts = ISO8601 时间戳字符串）。
-- 旧单对话数据迁移：不清空，由 conversations.cjs 的 initConversations()
--   在启动时一次性「补 ts + 按首条用户消息生成 title」（幂等）。
-- ============================================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title      TEXT NOT NULL DEFAULT '新对话';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 内联 UNIQUE 的自动约束名固定为 conversations_user_id_key
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user_id_key;

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON conversations (user_id, updated_at DESC);
