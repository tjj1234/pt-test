-- ============================================================================
-- 003_conversations.sql —— 对话历史持久化（P1 硬化 #5）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：CREATE TABLE IF NOT EXISTS。配合 db.cjs 的 schema_migrations 记录，
--       重复执行无副作用。
-- 范围：只建 conversations（P1 #5）。1 用户 = 1 条对话历史（user_id 唯一，
--       ON CONFLICT (user_id) 覆盖更新），按 user_id 隔离，互不可见。
-- 安全：messages 只存 user/assistant 消息文本（[{role, text}]），
--       明文 PT key 绝不进这张表（key 只在 api_keys 表里以 AES-256-GCM 密文存在）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{role:"user"|"assistant", text:"..."}]
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- user_id 的 UNIQUE 约束已自带索引，无需再建非唯一索引。
