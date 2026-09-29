-- ============================================================================
-- 北极星 · 交付版迁移 003_delivery.sql（PostgreSQL）
--
-- 本文件是「完整可运行交付包」独有的一层，解决三件原有脚本没做的事：
--
--   ① 【安全·必须】创建**非超级用户**应用角色 pt_app
--      —— 根因：PostgreSQL 的超级用户与 BYPASSRLS 角色**无条件绕过 RLS**，
--         即使表上写了 FORCE ROW LEVEL SECURITY 也照样绕过。
--         经真库实测：以 postgres（超级用户）连接时，不设租户上下文也能插数据 ——
--         pt_events 的租户隔离策略**静默失效**；换成 pt_app 后立刻 fail-closed。
--         原 001/002 从未创建应用角色，部署必然拿管理员连接 → RLS 等于没开。
--
--   ② 【功能】补两张原本就不存在、但代码早已需要的表：
--      analytics_tokens（verifyAnalyticsToken 的数据源）
--      webhook_endpoints（resolveEndpoint 的数据源）
--      此前这两个依赖只有"内存实现"，没有落库结构。
--
--   ③ 【运维】提供安全自检函数，应用启动时调用；不通过就拒绝启动（fail-closed）。
--
-- 幂等：全部 IF NOT EXISTS / DO 块，可重复执行。
-- 用法： psql "$DATABASE_URL" -f 003_delivery.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ① 应用角色：非超级用户、不可绕过 RLS
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_app') THEN
        CREATE ROLE pt_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        RAISE NOTICE '已创建应用角色 pt_app（NOSUPERUSER / NOBYPASSRLS）';
    ELSE
        -- 若已存在，强制纠正其属性，避免被人改回超级用户
        ALTER ROLE pt_app NOSUPERUSER NOBYPASSRLS;
        RAISE NOTICE '应用角色 pt_app 已存在，已确保 NOSUPERUSER / NOBYPASSRLS';
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO pt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pt_app;

-- 之后新建的表/序列也自动授权（否则将来加表又要手工 GRANT）
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO pt_app;

-- ---------------------------------------------------------------------------
-- ② 补两张缺失的表
-- ---------------------------------------------------------------------------

-- 只读分析 token（GET /api/analytics/* 的鉴权数据源）
-- 设计：只存 SHA-256 哈希，绝不存明文 —— 与 001 里 key_id_hash 的处理方式一致。
-- 注意：本表**不加 RLS**。因为校验时尚未知道 tenant（正是要靠 token 反查 tenant），
--       所以必须允许无租户上下文按 token_hash 精确命中一行。
CREATE TABLE IF NOT EXISTS analytics_tokens (
    token_hash   CHAR(64)    PRIMARY KEY,          -- SHA-256(token)，十六进制小写
    tenant_id    UUID        NOT NULL,
    label        TEXT,                             -- 用途备注，如「看板只读」
    scopes       TEXT[]      NOT NULL DEFAULT ARRAY['analytics:read'],
    status       TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','revoked')),
    expires_at   TIMESTAMPTZ,                      -- NULL = 永不过期
    last_used_at TIMESTAMPTZ,                      -- 便于运维排查（可选写）
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_tokens_tenant ON analytics_tokens (tenant_id);

-- Webhook 接入端点（POST /api/v1/collect/:webhookId 的鉴权数据源）
-- 同理只存 secret 的 SHA-256 哈希，不加 RLS（校验时还不知道 tenant）。
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    webhook_id   TEXT        PRIMARY KEY,
    tenant_id    UUID        NOT NULL,
    secret_hash  CHAR(64)    NOT NULL,             -- SHA-256(secret)，十六进制小写
    label        TEXT,
    status       TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','disabled')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id);

-- ---------------------------------------------------------------------------
-- ②b 审计数据源两表（让「打点健康度」真正从库里读，而不是内存）
--
--     设计原文说 SS-GTM Debug 日志「生产由容器访问凭证界定租户；若实现为查库，
--     则必须在事务内 set_config + 显式 WHERE tenant_id 双保险」。
--     交付版选择**查库**这条路，于是需要这两张落地表。
--     它们**带 tenant_id，因此开启 RLS**（与 pt_events 同等对待，fail-closed）。
-- ---------------------------------------------------------------------------

-- SS-GTM Debug 日志落地（审计的输入）
CREATE TABLE IF NOT EXISTS ss_gtm_debug_logs (
    tenant_id     UUID        NOT NULL,
    log_id        BIGSERIAL   PRIMARY KEY,
    event_name    TEXT        NOT NULL,        -- credit_purchase / balance_recharge / token_consume
    event_id      TEXT,                        -- 缺失/非法都由审计判分，故可空
    timestamp     BIGINT      NOT NULL,        -- 事件时间，epoch 毫秒（UTC）
    transport     TEXT,                        -- Measurement Protocol / GA4 / custom
    event_source  TEXT,                        -- 服务端标记
    x_pt_source   TEXT,                        -- 客户端标记
    user_agent    TEXT,
    ip_override   TEXT,
    client_name   TEXT,
    raw           JSONB,                       -- 原始日志备查
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ss_gtm_tenant_ts ON ss_gtm_debug_logs (tenant_id, timestamp);

ALTER TABLE ss_gtm_debug_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss_gtm_debug_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ss_gtm_debug_logs;
CREATE POLICY tenant_isolation ON ss_gtm_debug_logs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- GTM 静态配置审计发现（手段二辅助，只作建议、不改变 score）
CREATE TABLE IF NOT EXISTS gtm_config_findings (
    tenant_id   UUID        NOT NULL,
    finding_id  BIGSERIAL   PRIMARY KEY,
    check_name  TEXT        NOT NULL,
    detail      TEXT        NOT NULL,
    severity    TEXT        NOT NULL CHECK (severity IN ('high','medium','low')),
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtm_findings_tenant ON gtm_config_findings (tenant_id);

ALTER TABLE gtm_config_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtm_config_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON gtm_config_findings;
CREATE POLICY tenant_isolation ON gtm_config_findings
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- ②c 租户 ↔ 广告库工作区映射
--
--     pt_events 用 tenant_id（UUID），ad_* 五表用 workspace_id（TEXT）——
--     两者此前没有任何对应关系，归因查询因此拿不到 ad_* 数据。
--     交付版按「一租户一工作区」约定落这张映射表。
--     ★ 待决项：若真实环境一个租户对应多工作区（多平台/多账户分账），
--       此处需扩展为按平台+账户解析，而不是 LIMIT 1。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_workspaces (
    tenant_id    UUID        PRIMARY KEY,
    workspace_id TEXT        NOT NULL,
    label        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 不加 RLS：本表只做标识映射，不含业务数据；且解析发生在拿到 tenant 之后，无泄漏面。

-- ---------------------------------------------------------------------------
-- ②d 【安全·必须】修正 RLS 策略的 `::uuid` 空串崩溃缺陷
--
--     001_init.sql 里的策略写法是：
--         tenant_id = current_setting('app.current_tenant_id', true)::uuid
--
--     真库实测发现的缺陷：
--       · 该 GUC **从未被设置**时，current_setting(..., true) 返回 NULL → NULL::uuid → 不匹配任何行（正常）
--       · 但一旦被 set_config(..., true) 设过、且事务结束复位后，
--         它返回的是**空字符串 ''**（不是 NULL）→ ''::uuid **直接抛异常**
--           "invalid input syntax for type uuid: """
--
--     后果：任何「没设租户上下文就去查租户表」的代码路径，
--           不是干净地返回 0 行，而是直接 **500 报错**。
--           （不造成数据泄漏 —— 它报错而不是放行；但会让健康检查、
--             管理查询、以及任何漏写 set_config 的分支变成线上故障。）
--
--     正确写法是 PostgreSQL 官方推荐的标准模式：先 NULLIF 掉空串再转 uuid。
--     这里对三张启用了 RLS 的表统一重写策略（DROP + CREATE，幂等）。
--     ★ 001_init.sql 本体未改（沙箱不允许改既有文件），本段即为等效修正；
--       若将来 001 就地修好，本段因 DROP IF EXISTS + CREATE 仍会覆盖成正确版本，无副作用。
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON pt_events;
CREATE POLICY tenant_isolation ON pt_events
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON ss_gtm_debug_logs;
CREATE POLICY tenant_isolation ON ss_gtm_debug_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON gtm_config_findings;
CREATE POLICY tenant_isolation ON gtm_config_findings
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- ③b 【安全·必须】真实执行一次 fail-closed 探针（不是"看文本猜结论"）
-- ---------------------------------------------------------------------------
-- 为什么要有这个函数：
--   旧版自检第 10 项的条件是 `qual NOT LIKE '%::uuid%'`，而**修 bug 前和修 bug 后
--   的策略表达式都含 `::uuid`**（区别只在有没有 NULLIF）—— 所以那一项**永远通过**，
--   区分不了好坏，是个给人虚假信心的检查。（由独立验收方指出，属实，已替换。）
--
-- 现在改成**真去执行一次**，并且精确复现那个崩溃场景：
--   把 app.current_tenant_id 显式设成**空字符串**（这正是 set_config 在事务结束后
--   复位所留下的状态），然后不带任何 WHERE 裸查 pt_events：
--     · 策略正确（带 NULLIF）→ 干净返回 0 行，不报错
--     · 策略有缺陷（缺 NULLIF）→ 抛 invalid input syntax for type uuid: ""
-- 这是行为级证据，比读 pg_policies 的文本强得多。
--
-- 注意：必须定义在 pt_security_selfcheck 之前 —— 后者是 LANGUAGE sql，
--       创建时就会校验函数体，引用未定义的函数会直接报错。
CREATE OR REPLACE FUNCTION pt_probe_rls_failclosed()
RETURNS TABLE(ok boolean, detail text) AS $$
DECLARE
    n bigint;
BEGIN
    BEGIN
        PERFORM set_config('app.current_tenant_id', '', true);
        SELECT count(*) INTO n FROM pt_events;   -- 故意不带 WHERE
        -- 两个条件都要满足：
        --   ① 不抛异常（策略带 NULLIF 才能做到）
        --   ② 返回 0 行（RLS 真的在拦）
        -- 只判①是不够的：若以超级用户连接，RLS 会被整体绕过、策略根本不求值，
        -- 于是既不报错、还会把全部行都返回来 —— 只判①会给出虚假的"通过"。
        ok := (n = 0);
        IF ok THEN
            detail := '空串上下文下裸查 pt_events 返回 0 行且未报错（RLS 真实拦截）';
        ELSE
            detail := format('空串上下文下裸查返回了 %s 行（应为 0）—— RLS 被绕过或策略失效', n);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        ok := false;
        detail := format('空串上下文下裸查抛异常：%s（说明策略缺 NULLIF）', SQLERRM);
    END;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- ③ 安全自检：应用启动时调用，任一不通过就应拒绝启动
--    返回 (item, ok, detail)；ok 全为 true 才允许起服务。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pt_security_selfcheck()
RETURNS TABLE (item TEXT, ok BOOLEAN, detail TEXT) AS $$
    SELECT '当前连接角色', TRUE,
           'current_user=' || current_user || ' / session_user=' || session_user
    UNION ALL
    SELECT '连接角色不是超级用户',
           COALESCE((SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user), TRUE),
           'rolsuper=' || COALESCE((SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user), 'unknown')
    UNION ALL
    SELECT '连接角色不能绕过 RLS',
           COALESCE((SELECT NOT rolbypassrls FROM pg_roles WHERE rolname = current_user), TRUE),
           'rolbypassrls=' || COALESCE((SELECT rolbypassrls::text FROM pg_roles WHERE rolname = current_user), 'unknown')
    UNION ALL
    SELECT 'pt_events 已开启 RLS',
           (SELECT relrowsecurity FROM pg_class WHERE relname = 'pt_events'),
           'relrowsecurity=' || COALESCE((SELECT relrowsecurity::text FROM pg_class WHERE relname = 'pt_events'), 'unknown')
    UNION ALL
    SELECT 'pt_events 已强制 RLS（对表属主也生效）',
           (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'pt_events'),
           'relforcerowsecurity=' || COALESCE((SELECT relforcerowsecurity::text FROM pg_class WHERE relname = 'pt_events'), 'unknown')
    UNION ALL
    SELECT '租户隔离策略存在',
           EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'pt_events'::regclass AND polname = 'tenant_isolation'),
           'policy=tenant_isolation'
    UNION ALL
    SELECT 'ss_gtm_debug_logs 已开启并强制 RLS',
           (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'ss_gtm_debug_logs'),
           'relrowsecurity/forcerowsecurity'
    UNION ALL
    SELECT 'gtm_config_findings 已开启并强制 RLS',
           (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'gtm_config_findings'),
           'relrowsecurity/forcerowsecurity'
    UNION ALL
    SELECT '两张鉴权表已就位（analytics_tokens / webhook_endpoints）',
           to_regclass('public.analytics_tokens') IS NOT NULL
           AND to_regclass('public.webhook_endpoints') IS NOT NULL,
           'verifyAnalyticsToken / resolveEndpoint 的数据源'
    UNION ALL
    SELECT '缺失租户上下文时 RLS 必须挡住（fail-closed）',
           p.ok, p.detail
    FROM pt_probe_rls_failclosed() p
    UNION ALL
    SELECT 'RLS 策略已用 NULLIF 修正空串崩溃',
           EXISTS (
               SELECT 1 FROM pg_policies
               WHERE tablename = 'pt_events'
                 AND COALESCE(qual, '') LIKE '%current_setting%'
                 AND COALESCE(qual, '') LIKE '%NULLIF%'
           ),
           '策略须为 NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid'
           || ' —— 缺 NULLIF 时事务复位后 GUC 变空串，''''::uuid 会抛异常';
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- ④ 便捷视图：一眼看清两张新表的现状（不含任何明文）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_token_overview AS
SELECT t.tenant_id, t.label, t.status, t.expires_at,
       left(t.token_hash, 12) || '…' AS token_hash_prefix
FROM analytics_tokens t
ORDER BY t.created_at DESC;

CREATE OR REPLACE VIEW v_endpoint_overview AS
SELECT e.tenant_id, e.webhook_id, e.label, e.status,
       left(e.secret_hash, 12) || '…' AS secret_hash_prefix
FROM webhook_endpoints e
ORDER BY e.created_at DESC;

GRANT SELECT ON v_token_overview, v_endpoint_overview TO pt_app;

-- ---------------------------------------------------------------------------
-- ⑤ 收尾再授一次权
--    本文件里 GRANT 语句在前、新表创建在后，靠 ALTER DEFAULT PRIVILEGES 兜底；
--    这里再显式授一遍，保证无论语句顺序如何，pt_app 都有权限（幂等）。
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO pt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pt_app;
