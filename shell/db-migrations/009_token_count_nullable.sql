-- ============================================================================
-- 009_token_count_nullable.sql —— 工具调用日志：token_count 允许为 NULL
-- ----------------------------------------------------------------------------
-- 背景：DSH 协议不返回「每个工具调用单独」的 token 消耗数据，之前把 token_count
--       写死为 0，会让用量页把「没有数据」误读成「真的零消耗」。改为 NULL 以区分
--       「无数据」与「0」，前端据 NULL 显示占位（如 “—”）。
-- 幂等：ALTER COLUMN DROP NOT NULL / SET DEFAULT NULL 重复执行无副作用。
-- ============================================================================

ALTER TABLE tool_calls ALTER COLUMN token_count DROP NOT NULL;
ALTER TABLE tool_calls ALTER COLUMN token_count SET DEFAULT NULL;
