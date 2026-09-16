-- ============================================================================
-- 北极星 · 数据库迁移 003_add_x_platform.sql（PostgreSQL）
-- 单元 X：补齐 X（Twitter）广告平台支持 —— 放宽 ad_* 五表的 platform CHECK 约束
--
-- ★ 本迁移**只放宽约束，不造数据**。
--   X（Twitter）的广告侧数据（ad_accounts / ad_campaigns / … / ad_performance_daily）
--   仍要靠真实采集管道（Ryze / meta_official / csv）按 platform='x' 写进来；
--   本文件只是让这些行**能落库**，不再被 CHECK 约束拒绝。
--
-- 背景（为什么必须修）：
--   前端筛选栏按 3 个平台做（"Google Ads" / "Meta Ads" / "X Ads"），
--   后端却只认 2 个平台，5 张 ad_* 表的 CHECK 约束写死 IN ('meta','google')。
--   X 是真实在跑的渠道（~15.5% 流量：693 访问 / 175 注册 / 12 充值 / $1,188），
--   且种子数据里的 X 场景是故意设计的归因边界用例（"有花费无充值" / "无广告实体→未命中"）。
--   不放宽这 5 个约束，X 的广告侧数据永远落不了库。
--
-- 约束名（已由 PGlite 真库实测，PG 自动命名，非猜测）：
--   ad_accounts_platform_check        ad_campaigns_platform_check
--   ad_adgroups_platform_check        ad_creatives_platform_check
--   ad_performance_daily_platform_check
--
-- 幂等性：全部用 DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT，
--   重复执行不报错（每次都先删同名旧约束再重建为 3 平台版本）。
--
-- 编号说明：本文件沿用 backend/db 的 001/002 序列，取下一个未占用的号 003。
--   注意与交付版 schema/003_delivery.sql（交付层：应用角色/鉴权表/安全自检）无关，
--   两者是不同目录、不同层级的两个"003"。
--
-- 用法（与 001/002 同风格，psql 执行，UP/DOWN 用变量 migrate_down 切换）：
--   正向放宽 (UP)  ： psql "$DATABASE_URL" -f 003_add_x_platform.sql
--   回滚收紧 (DOWN)： psql "$DATABASE_URL" -v migrate_down=1 -f 003_add_x_platform.sql
--   ⚠️ DOWN 会把约束收紧回 ('meta','google')；若已 ingest 过 platform='x' 的行，
--      DOWN 会因既有数据违反新约束而失败 —— 这是**故意**的 fail-safe（收紧前须先清 X 数据）。
-- ============================================================================

\if :{?migrate_down}

\echo '==> 003_add_x_platform DOWN (rollback to meta/google) start <=='
ALTER TABLE ad_accounts           DROP CONSTRAINT IF EXISTS ad_accounts_platform_check;
ALTER TABLE ad_accounts           ADD CONSTRAINT ad_accounts_platform_check           CHECK (platform IN ('meta','google'));
ALTER TABLE ad_campaigns          DROP CONSTRAINT IF EXISTS ad_campaigns_platform_check;
ALTER TABLE ad_campaigns          ADD CONSTRAINT ad_campaigns_platform_check          CHECK (platform IN ('meta','google'));
ALTER TABLE ad_adgroups           DROP CONSTRAINT IF EXISTS ad_adgroups_platform_check;
ALTER TABLE ad_adgroups           ADD CONSTRAINT ad_adgroups_platform_check           CHECK (platform IN ('meta','google'));
ALTER TABLE ad_creatives          DROP CONSTRAINT IF EXISTS ad_creatives_platform_check;
ALTER TABLE ad_creatives          ADD CONSTRAINT ad_creatives_platform_check          CHECK (platform IN ('meta','google'));
ALTER TABLE ad_performance_daily  DROP CONSTRAINT IF EXISTS ad_performance_daily_platform_check;
ALTER TABLE ad_performance_daily  ADD CONSTRAINT ad_performance_daily_platform_check  CHECK (platform IN ('meta','google'));
\echo '==> 003_add_x_platform DOWN done <=='

\else

\echo '==> 003_add_x_platform UP (add x) start <=='
ALTER TABLE ad_accounts           DROP CONSTRAINT IF EXISTS ad_accounts_platform_check;
ALTER TABLE ad_accounts           ADD CONSTRAINT ad_accounts_platform_check           CHECK (platform IN ('meta','google','x'));
ALTER TABLE ad_campaigns          DROP CONSTRAINT IF EXISTS ad_campaigns_platform_check;
ALTER TABLE ad_campaigns          ADD CONSTRAINT ad_campaigns_platform_check          CHECK (platform IN ('meta','google','x'));
ALTER TABLE ad_adgroups           DROP CONSTRAINT IF EXISTS ad_adgroups_platform_check;
ALTER TABLE ad_adgroups           ADD CONSTRAINT ad_adgroups_platform_check           CHECK (platform IN ('meta','google','x'));
ALTER TABLE ad_creatives          DROP CONSTRAINT IF EXISTS ad_creatives_platform_check;
ALTER TABLE ad_creatives          ADD CONSTRAINT ad_creatives_platform_check          CHECK (platform IN ('meta','google','x'));
ALTER TABLE ad_performance_daily  DROP CONSTRAINT IF EXISTS ad_performance_daily_platform_check;
ALTER TABLE ad_performance_daily  ADD CONSTRAINT ad_performance_daily_platform_check  CHECK (platform IN ('meta','google','x'));
\echo '==> 003_add_x_platform UP done <=='

\endif
