-- ============================================================================
-- 005_archive_memory.sql —— 归档 + 跨对话轻量记忆（形态 B 功能扩展）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS，配合 db.cjs 的
--       schema_migrations 记录（按文件名顺序执行），重复执行无副作用。
--
-- 变更点：
--   1) conversations 加 archived（0=进行中，1=已归档）；
--   2) 新建 user_memory（user_id + key 联合主键），存跨对话长期记忆与
--      「所选模型」（内部保留键 $model，不出现在用户记忆列表）。
-- ============================================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_memory (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);
