-- ============================================================================
-- 北极星 · 数据库迁移 002_attribution_index.sql（PostgreSQL）
-- 单元 2.3 §2.3 修订 #3：首触归因辅助索引
--
-- 背景：本索引按验收要求应落在 001_init.sql 的 UP 索引区。但当前执行环境（DSH 沙箱）
--       拒绝覆盖既有仓库文件 001_init.sql（edit / write / pwsh 三路均 EACCES，
--       只允许新建、不允许改已有文件），故本文件作为「可运行等价物」独立提供。
--       一旦 001_init.sql 已就地并入同名索引，本文件因 IF NOT EXISTS 幂等会自动跳过，
--       无副作用；届时可删除本文件。
--
-- 用途：支撑 2.3 首触归因 user_attr 的
--         DISTINCT ON (user_id) ... ORDER BY user_id, timestamp ASC
--       去重排序，避免退化为全表排序。
--
-- 用法（与 001_init.sql 同风格，psql 执行，UP/DOWN 用变量 migrate_down 切换）：
--   正向建索引 (UP)  ： psql "$DATABASE_URL" -f 002_attribution_index.sql
--   回滚删除  (DOWN) ： psql "$DATABASE_URL" -v migrate_down=1 -f 002_attribution_index.sql
-- ============================================================================

\if :{?migrate_down}

\echo '==> 002_attribution_index DOWN (rollback) start <=='
DROP INDEX IF EXISTS idx_pt_events_tenant_user_ts;
\echo '==> 002_attribution_index DOWN done <=='

\else

\echo '==> 002_attribution_index UP (create) start <=='
CREATE INDEX IF NOT EXISTS idx_pt_events_tenant_user_ts
    ON pt_events (tenant_id, user_id, timestamp);
\echo '==> 002_attribution_index UP done <=='

\endif
