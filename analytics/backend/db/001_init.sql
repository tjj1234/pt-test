-- ============================================================================
-- 北极星 · 数据库初始化迁移 001_init.sql（PostgreSQL）
-- 覆盖：数据接入层 pt_events + 广告归因层 ad_* 五表 + fx_rates 汇率快照表
--
-- 依据（严格对齐，不自行增删字段）：
--   1.1-事件表结构.md          —— pt_events 通用字段 + 6 事件专属字段
--   1.3-幂等落库-rev4.md §3.2  —— tenant_id + seq + 复合主键 + RLS + 索引
--   2.2-广告数据清洗落库.md §6  —— ad_* 五表 + fx_rates + 索引
--
-- 用法（psql 执行，UP/DOWN 用变量 migrate_down 切换）：
--   正向建表 (UP)  ： psql "$DATABASE_URL" -f 001_init.sql
--   回滚     (DOWN)： psql "$DATABASE_URL" -v migrate_down=1 -f 001_init.sql
--
-- 说明：本文件用 psql 的 \if 元命令按变量 migrate_down 是否“已定义”切换
--       UP / DOWN 两段；不传 migrate_down = 默认执行 UP（建表）。
-- ============================================================================

\if :{?migrate_down}

\echo '==> 001_init DOWN (rollback) start <=='

-- ---------------------------------------------------------------------------
-- DOWN：按依赖逆序回滚（DROP 全部对象）
-- ---------------------------------------------------------------------------

-- pt_events 的 RLS 策略
DROP POLICY IF EXISTS tenant_isolation ON pt_events;

-- fx_rates（汇率快照）
DROP TABLE IF EXISTS fx_rates;

-- ad_* 五表（无跨表物理外键，逆序删）
DROP TABLE IF EXISTS ad_performance_daily;
DROP TABLE IF EXISTS ad_creatives;
DROP TABLE IF EXISTS ad_adgroups;
DROP TABLE IF EXISTS ad_campaigns;
DROP TABLE IF EXISTS ad_accounts;

-- pt_events：其拥有的序列 pt_events_seq 随 DROP TABLE 自动级联删除，
-- 下面 DROP SEQUENCE IF EXISTS 仅作兜底（正常情况为 no-op）
DROP TABLE IF EXISTS pt_events;
DROP SEQUENCE IF EXISTS pt_events_seq;

\echo '==> 001_init DOWN (rollback) done <=='

\else

\echo '==> 001_init UP (create) start <=='

-- ===========================================================================
-- 一、数据接入层：pt_events（append-only，只 INSERT，不 UPDATE / DELETE）
-- ===========================================================================

-- seq 全局单调落库序号（下游 1.4 增量游标锚点）。
-- 注意：不用 BIGSERIAL（其自动序列名会是 pt_events_seq_seq），
--       显式建序列并统一命名为 pt_events_seq（对齐 1.3 rev4 §3.2）。
CREATE SEQUENCE IF NOT EXISTS pt_events_seq;

CREATE TABLE IF NOT EXISTS pt_events (

    -- ---------- ⓪ 多租户归属（1.3 新增，硬要求）----------
    tenant_id       UUID        NOT NULL,   -- 归属租户 uid，由 Secret 反查注入，绝不读事件体

    -- ---------- ⓪.5 落库序号（1.3 rev4 新增，下游增量游标锚点）----------
    seq             BIGINT      NOT NULL UNIQUE DEFAULT nextval('pt_events_seq'),  -- 全局单调落库序号，DB 序列分配

    -- ---------- ① 通用字段（每个事件都带，契约 §1.1）----------
    event_id        UUID        NOT NULL,   -- 同一租户内唯一事件 id，幂等键之一
    event_name      TEXT        NOT NULL,   -- 原始事件名（6 白名单：visit/signup/key_created/model_call/recharge/auto_recharge_toggle）
    timestamp       BIGINT      NOT NULL,   -- 事件发生时间，epoch 毫秒（UTC）
    visitor_id      TEXT,                   -- 匿名访客 id，落地生成
    user_id         TEXT,                   -- 注册后有，未注册为 NULL

    utm_source      TEXT,                   -- UTM 五件套（快照）
    utm_medium      TEXT,
    utm_campaign    TEXT,
    utm_term        TEXT,
    utm_content     TEXT,                   -- utm_content 对应「素材」

    gclid           TEXT,                   -- 广告平台自动标记（Google）
    fbclid          TEXT,                   -- 广告平台自动标记（Facebook）
    click_id        TEXT,                   -- 其他广告平台 click_id

    country         TEXT,                   -- 只存国家，不存原始 IP
    region          TEXT,

    user_agent      TEXT,                   -- 设备与浏览器
    device_type     TEXT,
    os              TEXT,
    browser         TEXT,

    page_url        TEXT,                   -- 页面与来源
    referrer        TEXT,

    -- ---------- ② visit（落地 / 页面浏览）----------
    page_path       TEXT,
    page_title      TEXT,
    session_id      TEXT,
    dwell_time_ms   BIGINT,

    -- ---------- ③ signup（注册）----------
    registration_method TEXT,               -- email / google_oauth / github / 其他
    email_verified  BOOLEAN,

    -- ---------- Key 脱敏字段（key_created / model_call 共用）----------
    -- 禁止存完整 Key 明文；只存「前 8 位」+「完整 Key 的 SHA-256 哈希」
    key_id_prefix   VARCHAR(8),             -- Key 前 8 位（人工/日志定位）
    key_id_hash     CHAR(64),               -- 完整 Key 的 SHA-256 哈希（十六进制）

    -- ---------- ④ key_created（创建 Key）----------
    create_page     TEXT,
    key_type        TEXT,                   -- public / private

    -- ---------- ⑤ model_call（模型调用）----------
    model           TEXT,                   -- 模型名
    source          TEXT,                   -- playground（网站内）| api
    caller          TEXT,                   -- 调用方工具/客户端
    request_time    BIGINT,                 -- 请求时间（ms）
    response_time   BIGINT,                 -- 返回时间（ms）
    latency_ms      BIGINT,                 -- 延迟 = response_time - request_time
    success         BOOLEAN,                -- 是否成功
    http_status     INTEGER,                -- 失败时的 HTTP 状态码
    error_code      TEXT,                   -- 失败时的错误码
    request_id      TEXT,                   -- 平台生成的请求 id（用于关联）
    response_id     TEXT,                   -- 平台生成的返回 id（用于关联）
    provider        TEXT,                   -- 上游模型供应商
    endpoint        TEXT,                   -- 调用的具体路由（可选）
    prompt_tokens     BIGINT,               -- token 用量（算成本）
    completion_tokens BIGINT,
    total_tokens      BIGINT,
    cost            NUMERIC(20, 8),         -- 本次调用估算费用

    -- ---------- ⑥ recharge（充值）----------
    recharge_id     TEXT,
    amount          NUMERIC(18, 8),
    currency        TEXT,
    payment_method  TEXT,                   -- card / paypal / crypto / 其他
    status          TEXT,                   -- success / failed（recharge 专用）

    -- ---------- ⑦ auto_recharge_toggle（自动充值开关）----------
    enabled         BOOLEAN,                -- true=开启 / false=关闭

    -- 幂等唯一键：同一租户内 event_id 唯一（复合主键，1.3 §2）
    PRIMARY KEY (tenant_id, event_id)
);

-- 序列归属：pt_events.seq 拥有序列，DROP TABLE 时自动级联删除
ALTER SEQUENCE pt_events_seq OWNED BY pt_events.seq;

-- 时间索引（查询永远带租户，故租户前缀）
CREATE INDEX IF NOT EXISTS idx_pt_events_tenant_ts
    ON pt_events (tenant_id, timestamp);

-- 漏斗/事件名查询辅助（租户 + 事件名 + 时间，最常用组合）
CREATE INDEX IF NOT EXISTS idx_pt_events_tenant_event_ts
    ON pt_events (tenant_id, event_name, timestamp);

-- 落库序号索引（下游 1.4 增量游标 ORDER BY seq 的主序）
CREATE INDEX IF NOT EXISTS idx_pt_events_tenant_seq
    ON pt_events (tenant_id, seq);

-- ---------------------------------------------------------------------------
-- RLS：按 tenant_id 行级隔离（读写共用一条策略，fail-closed）
-- ---------------------------------------------------------------------------
ALTER TABLE pt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pt_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pt_events
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ===========================================================================
-- 二、广告归因层：ad_* 五表 + fx_rates（UPSERT 语义，非 append-only）
-- ===========================================================================

-- ── ① 账户 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_accounts (
  workspace_id     TEXT        NOT NULL,                -- 租户隔离
  platform         TEXT        NOT NULL CHECK (platform IN ('meta','google')),
  account_id       TEXT        NOT NULL,                -- 去前缀：act_123→123
  name             TEXT,
  currency         TEXT        NOT NULL,                -- 账户本位币
  timezone         TEXT        NOT NULL,                -- IANA 时区
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  raw_status       TEXT,                                -- 平台原始状态备查
  last_metric_date DATE,                                -- 增量游标：上次指标同步到的 UTC 日
  data_source      TEXT        NOT NULL DEFAULT 'ryze',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id)
);

-- ── ② 系列 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_campaigns (
  workspace_id  TEXT        NOT NULL,
  platform      TEXT        NOT NULL CHECK (platform IN ('meta','google')),
  account_id    TEXT        NOT NULL,
  campaign_id   TEXT        NOT NULL,
  name          TEXT,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  raw_status    TEXT,
  objective     TEXT,
  data_source   TEXT        NOT NULL DEFAULT 'ryze',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id, campaign_id)
);

-- ── ③ ad set / ad group 统一层 ──────────────────────────
CREATE TABLE IF NOT EXISTS ad_adgroups (
  workspace_id  TEXT        NOT NULL,
  platform      TEXT        NOT NULL CHECK (platform IN ('meta','google')),
  account_id    TEXT        NOT NULL,
  campaign_id   TEXT        NOT NULL,
  adgroup_id    TEXT        NOT NULL,
  level         TEXT        NOT NULL CHECK (level IN ('adset','adgroup')),  -- Meta=adset, Google=adgroup
  name          TEXT,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  raw_status    TEXT,
  data_source   TEXT        NOT NULL DEFAULT 'ryze',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id, adgroup_id)
);

-- ── ④ 素材（JOIN 键） ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_creatives (
  workspace_id  TEXT        NOT NULL,
  platform      TEXT        NOT NULL CHECK (platform IN ('meta','google')),
  account_id    TEXT        NOT NULL,
  creative_id   TEXT        NOT NULL,               -- 行为侧 utm_content 的 JOIN 键
  campaign_id   TEXT,
  adgroup_id    TEXT,
  name          TEXT,
  title         TEXT,
  body          TEXT,
  image_url     TEXT,
  video_url     TEXT,
  link          TEXT,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  raw_status    TEXT,
  data_source   TEXT        NOT NULL DEFAULT 'ryze',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id, creative_id)
);

-- ── ⑤ 每日指标（任意层级，按日聚合，UPSERT 覆盖） ─────────
CREATE TABLE IF NOT EXISTS ad_performance_daily (
  workspace_id     TEXT           NOT NULL,
  platform         TEXT           NOT NULL CHECK (platform IN ('meta','google')),
  account_id       TEXT           NOT NULL,
  entity_id        TEXT           NOT NULL,             -- account_id / campaign_id / adgroup_id / creative_id
  level            TEXT           NOT NULL CHECK (level IN ('account','campaign','adgroup','creative')),
  date             DATE           NOT NULL,             -- UTC 日期（与 pt_events 对齐）
  local_date       DATE,                                -- 账户本地日期（备查/还原）
  spend            NUMERIC(18,6)  NOT NULL DEFAULT 0,   -- 原始本位币
  impressions      BIGINT         NOT NULL DEFAULT 0,
  clicks           BIGINT         NOT NULL DEFAULT 0,
  conversions      NUMERIC(18,6)  NOT NULL DEFAULT 0,   -- 平台自报转化（参考列）
  ctr              NUMERIC(18,6),                       -- 除数为 0 → NULL
  cpm              NUMERIC(18,6),
  cpc              NUMERIC(18,6),
  roas             NUMERIC(18,6),
  currency         TEXT           NOT NULL,             -- 原始币种
  amount_usd       NUMERIC(18,6),                       -- 折算 USD（汇率缺失 NULL）
  fx_rate          NUMERIC(18,10),
  fx_date          DATE,
  data_source      TEXT           NOT NULL DEFAULT 'ryze',
  idempotency_key  TEXT,                                -- 本轮拉取的幂等键（溯源，非去重主键）
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account_id, entity_id, level, date)
);

-- ── ⑥ 汇率快照 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fx_rates (
  currency   TEXT           NOT NULL,            -- 原始币种，如 EUR
  base       TEXT           NOT NULL DEFAULT 'USD',
  rate       NUMERIC(18,10) NOT NULL,            -- 1 单位 currency = rate 单位 base(USD)
  fx_date    DATE           NOT NULL,            -- 快照日
  source     TEXT           NOT NULL,            -- ecb | openexchangerates | manual | identity
  created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, base, fx_date)
);

-- ---------------------------------------------------------------------------
-- 索引（按归因查询路径，对齐 2.2 §6.2）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_perf_date     ON ad_performance_daily (workspace_id, platform, account_id, date);
CREATE INDEX IF NOT EXISTS idx_perf_entity   ON ad_performance_daily (workspace_id, platform, entity_id);
CREATE INDEX IF NOT EXISTS idx_creative_key  ON ad_creatives (workspace_id, platform, account_id, creative_id);
CREATE INDEX IF NOT EXISTS idx_campaign_acct ON ad_campaigns (workspace_id, platform, account_id);
CREATE INDEX IF NOT EXISTS idx_adgroup_acct  ON ad_adgroups  (workspace_id, platform, account_id);

\echo '==> 001_init UP (create) done <=='

\endif
