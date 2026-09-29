-- ============================================================================
-- 002_api_keys.sql —— PT key（BYOK）加密落盘表（U2）
-- ----------------------------------------------------------------------------
-- 目标库：PGlite 0.5.8（真 PostgreSQL 16 编译成 WASM）
-- 幂等：CREATE TABLE IF NOT EXISTS。配合 db.cjs 的 schema_migrations 记录，
--       重复执行无副作用。user_id 唯一：1 用户 = 1 把 PT key（覆盖更新）。
-- 范围：只建 api_keys（U2）。conversations（U3）不在本迁移内，避免越界。
-- 说明：ciphertext / iv 存 base64 文本（规范允许 BYTEA，但 base64 便于
--       grep 审计「密文 ≠ 明文」）。ciphertext = AES-256-GCM 密文 ‖ 16 字节
--       auth tag；iv = 12 字节随机数。明文 PT key 绝不进这张表的任何列。
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  ciphertext  TEXT NOT NULL,           -- AES-256-GCM 密文 + auth tag，base64
  iv          TEXT NOT NULL,           -- 12 字节随机 IV，base64
  key_last4   TEXT NOT NULL,           -- 只存末 4 位，用于展示「已存 …abcd」
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
