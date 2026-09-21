"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInMemoryTokenVerifier = void 0;
exports.buildFunnelSql = buildFunnelSql;
exports.serializeFunnelGroup = serializeFunnelGroup;
exports.resolveRoiNote = resolveRoiNote;
exports.serializeRoiEntity = serializeRoiEntity;
exports.parseFunnelParams = parseFunnelParams;
exports.queryFunnelScoped = queryFunnelScoped;
exports.buildFunnelServer = buildFunnelServer;
exports.startFunnelServer = startFunnelServer;
/**
 * 北极星项目 · 广告归因层 · 单元 2.4 漏斗查询 API —— GET /api/analytics/funnel
 *
 * 依据：《北极星开发/2-广告归因/2.4-funnel查询API-fixed3.md》（fixed3 版，三次返工后落点）
 *   §0   返工修订记录（三个坑：SQL 语法错 / 空 vs 零 / recharge_fx_missing 漏透传）
 *   §1.2 查询参数（from/to/granularity/country/platform/utm_source/campaign/content/conversion_window_days/limit）
 *   §2.2 granularity 时间桶（day/week/month/total；total 用哨兵日 1970-01-01 折叠）
 *   §3.1 groups（漏斗行为，country 粒度 + bucket，纯行为）
 *   §3.2 roi_by_entity（素材/系列 ROI，不含 country）
 *   §3.3 roi 取值 + roi_note 生成规则（三分支落 SQL，文案应用层映射）
 *   §4.1-4.5 归因 JOIN SQL（日级匹配 → 每实体一行 → 普通聚合，无窗口函数）
 *   §5   只读 token 鉴权（复用 1.4 query.ts §4）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只读：全文件只有 SELECT，无 INSERT / UPDATE / DELETE（事务显式 BEGIN READ ONLY）。
 *   2. tenant 只从只读 token 派生，绝不读查询参数 / 请求头里的身份字段。
 *   3. 不编造指标：空 vs 零严格区分 —— 无数据 SUM=NULL 保留 NULL，有数据为 0 才是 0，
 *      绝不 COALESCE(SUM(...), 0) 把 NULL 糊成 0。
 *   4. ROI 与平台自报 ROAS 严格分离：roi（行为侧真实充值 USD / amount_usd）与
 *      platform_roas（ad_performance_daily.roas 参考列）两个字段两个名。
 *   5. 运行时永不 DISABLE RLS（pt_events 为 FORCE ROW LEVEL SECURITY，fail-closed）。
 *
 * 三个坑的规避（对齐设计 §0）：
 *   [坑1 语法] 不用 `COUNT(DISTINCT …) OVER()`（窗口函数里禁止 DISTINCT）。改为：
 *     日级匹配 → 每实体一行（普通 GROUP BY）→ 普通聚合 COUNT(*) + array_agg(...)
 *     + bool_or(...)。granularity 只在最终 GROUP BY 参与，归因匹配始终日级 a.date=b.attr_date。
 *   [坑2 空 vs 零] 空集 SUM 返回 NULL。用 CASE WHEN COALESCE(SUM(recharges),0)=0 THEN 0
 *     把「无充值」归 0（真实「没回收」）；但「有充值无汇率」的 recharge_amount_usd 保持 NULL；
 *     attr_spend_usd 绝不 COALESCE，NULL（无花费数据）与 0（花费为 0）严格分开。
 *   [坑3 fx_missing 透传] recharge_fx_missing 在查询 A（groups）与查询 B（roi_by_entity）
 *     的 SELECT 里**都**透出（fixed3 曾漏在查询 B，导致应用层无法区分「全部/部分无汇率」）。
 *
 * 依赖注入（对齐 collect/ingest.ts、events/query.ts、ads/attribution.ts 风格）：
 *   - pool：pg 连接池（调用方 new Pool({ connectionString: DATABASE_URL }) 注入）。
 *   - verifyAnalyticsToken：只反查「只读分析 token」签发表，返回 AnalyticsAuth | null。
 *   - resolveWorkspaceId：tenant_id(UUID) → ad_* 的 workspace_id(TEXT) 映射（默认恒等）。
 *
 * 注意（schema 事实，与 2.3 attribution.ts 一致的修正）：
 *   - pt_events.tenant_id 为 UUID，ad_*.workspace_id 为 TEXT，类型不同；本期无租户→工作区
 *     映射表，默认取 workspace_id = tenant_id（同值不同型），可通过 resolveWorkspaceId 覆盖。
 *   - pt_events 有 FORCE RLS，查询必须在事务内 set_config('app.current_tenant_id', …)。
 */
const fastify_1 = __importDefault(require("fastify"));
const validate_1 = require("../collect/validate");
const query_1 = require("../events/query");
Object.defineProperty(exports, "createInMemoryTokenVerifier", { enumerable: true, get: function () { return query_1.createInMemoryTokenVerifier; } });
const attribution_1 = require("./attribution");
// ===========================================================================
// 参数累积 + 表达式辅助
// ===========================================================================
/** 参数累积器：add() 返回下一个 $N 占位符并记录值。 */
class Params {
    arr = [];
    add(v) {
        this.arr.push(v);
        return `$${this.arr.length}`;
    }
    get values() {
        return this.arr;
    }
}
/** epoch 毫秒 → UTC 日 的 SQL 表达式（不依赖会话时区，AT TIME ZONE 'UTC' 自洽）。 */
const epochToUtcDate = (expr) => `(to_timestamp(${expr}::double precision / 1000.0) AT TIME ZONE 'UTC')::date`;
/** epoch 毫秒 → 'YYYY-MM-DD'（UTC），用于传 DATE 参数（from/to 回填后）。 */
function epochMsToUtcDateString(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
/**
 * granularity → 时间桶表达式（§2.2，P2 修正）。
 *   day   = attr_date
 *   week  = date_trunc('week',  attr_date)::date  （ISO 周，周一起点）
 *   month = date_trunc('month', attr_date)::date
 *   total = DATE '1970-01-01'（哨兵日，JOIN 非空，序列化层省略 bucket）
 * 归因匹配**始终**日级 `a.date = b.attr_date`；bucket 只在最终 GROUP BY 参与。
 */
function bucketExpr(attrDate, g) {
    switch (g) {
        case "day":
            return attrDate;
        case "week":
            return `date_trunc('week', ${attrDate})::date`;
        case "month":
            return `date_trunc('month', ${attrDate})::date`;
        case "total":
            return `DATE '1970-01-01'`;
    }
}
// ===========================================================================
// §4.1-4.2 共用 CTE（user_attr / event_attr / behavior_agg）
// ===========================================================================
/**
 * 构建共用 CTE（user_attr / event_attr / behavior_agg，§4.2 ①②③）。
 * 参数顺序：tenantId, from, to, toPlusW, fromDate, toDate, [utmSource, utmCampaign, utmContent, country]。
 * 返回 CTE 文本 + fromDate/toDate 占位符（查询 B 的 ad_spend 复用同一对日期参数）。
 */
function buildCommonCtes(q, p) {
    const tenantPh = p.add(q.tenantId);
    const fromPh = p.add(q.from);
    const toPh = p.add(q.to);
    // 转化回溯窗口（§4.3）：充值累计放宽到 to + W 天；分母（ad_spend）仍锚定 [from, to]
    const toPlusWPh = p.add(q.to + q.conversionWindowDays * 86400000);
    const fromDatePh = p.add(epochMsToUtcDateString(q.from));
    const toDatePh = p.add(epochMsToUtcDateString(q.to));
    // event_attr 的可选筛选（对归因后标签 COALESCE(e.*, ua.*) 精确过滤，§2.3/§2.4）
    const filters = [];
    const addEq = (expr, v) => {
        if (v === null)
            return;
        const t = v.trim();
        if (t.length === 0)
            return;
        const ph = p.add(t);
        filters.push(`${expr} = ${ph}`);
    };
    addEq("COALESCE(e.utm_source, ua.utm_source)", q.utmSource);
    addEq("COALESCE(e.utm_campaign, ua.utm_campaign)", q.utmCampaign);
    addEq("COALESCE(e.utm_content, ua.utm_content)", q.utmContent);
    addEq("COALESCE(e.country, ua.country)", q.country);
    const filterSql = filters.length > 0 ? `\n    AND ${filters.join("\n    AND ")}` : "";
    // 时间过滤（§4.3）：默认 W=0 所有事件 timestamp ∈ [from, to]；W>0 时充值事件放宽到
    // to+W 且要求其 acquisition_date ∈ [from, to]（纳入滞后转化，分母不变）。
    const timeFilter = q.conversionWindowDays > 0
        ? `AND e.timestamp >= ${fromPh}
    AND (
          ( e.event_name <> 'recharge' AND e.timestamp <= ${toPh} )
       OR ( e.event_name = 'recharge'
            AND e.timestamp <= ${toPlusWPh}
            AND ua.acquisition_date >= ${fromDatePh}::date
            AND ua.acquisition_date <= ${toDatePh}::date )
    )`
        : `AND e.timestamp >= ${fromPh} AND e.timestamp <= ${toPh}`;
    const cte = `
user_attr AS (
  SELECT DISTINCT ON (user_id)
         user_id,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         gclid, fbclid, click_id,
         country,
         ${epochToUtcDate("timestamp")} AS acquisition_date
  FROM pt_events
  WHERE tenant_id = ${tenantPh}::uuid
    AND user_id IS NOT NULL
    AND event_name = 'signup'
  ORDER BY user_id, timestamp ASC
),
event_attr AS (
  SELECT
    e.visitor_id, e.user_id, e.event_name, e.success, e.source,
    e.latency_ms, e.enabled, e.amount, e.model, e.status,
    COALESCE(e.utm_source,   ua.utm_source)   AS attr_source,
    COALESCE(e.utm_medium,   ua.utm_medium)   AS attr_medium,
    COALESCE(e.utm_campaign, ua.utm_campaign) AS attr_campaign,
    COALESCE(e.utm_term,     ua.utm_term)     AS attr_term,
    COALESCE(e.utm_content,  ua.utm_content)  AS attr_content,
    COALESCE(e.country,      ua.country)      AS attr_country,
    CASE WHEN e.event_name = 'visit'
         THEN ${epochToUtcDate("e.timestamp")}
         ELSE COALESCE(ua.acquisition_date, ${epochToUtcDate("e.timestamp")})
    END AS attr_date,
    CASE WHEN e.event_name = 'recharge' AND e.status = 'success' THEN
           CASE
             WHEN e.currency = 'USD' THEN e.amount
             WHEN fx.rate IS NOT NULL THEN e.amount * fx.rate
             ELSE NULL
           END
         ELSE NULL
    END AS recharge_amount_usd
  FROM pt_events e
  LEFT JOIN user_attr ua ON ua.user_id = e.user_id
  LEFT JOIN fx_rates fx
         ON e.event_name = 'recharge'
        AND fx.currency = e.currency
        AND fx.base = 'USD'
        AND fx.fx_date = ${epochToUtcDate("e.timestamp")}
  WHERE e.tenant_id = ${tenantPh}::uuid
    ${timeFilter}${filterSql}
),
behavior_agg AS (
  SELECT
    attr_source, attr_medium, attr_campaign, attr_term, attr_content,
    attr_country, attr_date,
    COUNT(DISTINCT visitor_id) FILTER (WHERE event_name = 'visit')                AS visits,
    COUNT(DISTINCT user_id)    FILTER (WHERE event_name = 'signup')               AS signups,
    COUNT(DISTINCT user_id)    FILTER (WHERE event_name = 'key_created')          AS key_users,
    COUNT(*)                   FILTER (WHERE event_name = 'key_created')          AS key_created,
    COUNT(*)                   FILTER (WHERE event_name = 'model_call')           AS model_calls,
    COUNT(*)                   FILTER (WHERE event_name = 'model_call' AND success) AS success_calls,
    SUM(latency_ms)            FILTER (WHERE event_name = 'model_call' AND success) AS latency_sum,
    COUNT(latency_ms)          FILTER (WHERE event_name = 'model_call' AND success) AS latency_cnt,
    COUNT(*)                   FILTER (WHERE event_name = 'model_call' AND source = 'playground') AS calls_playground,
    COUNT(*)                   FILTER (WHERE event_name = 'model_call' AND source = 'api')         AS calls_api,
    COUNT(DISTINCT user_id) FILTER (WHERE event_name = 'recharge' AND status = 'success') AS recharge_users,
    COUNT(*)                FILTER (WHERE event_name = 'recharge' AND status = 'success') AS recharges,
    SUM(amount)             FILTER (WHERE event_name = 'recharge' AND status = 'success') AS recharge_amount,
    SUM(recharge_amount_usd)                                                       AS recharge_amount_usd,
    -- fixed2/fixed3：充值成功但折算 USD 缺失（无当日汇率）的事件条数
    COUNT(*) FILTER (WHERE event_name = 'recharge' AND status = 'success'
                          AND recharge_amount_usd IS NULL)                        AS recharge_fx_missing,
    COUNT(*) FILTER (WHERE event_name = 'auto_recharge_toggle' AND enabled)        AS auto_recharge_enabled_count
  FROM event_attr
  GROUP BY 1,2,3,4,5,6,7
)`;
    return { cte, fromDatePh, toDatePh };
}
/**
 * 构建查询 A（§4.5 查询 A）。
 * 注意：recharge_fx_missing 必须在此 SELECT 透出（坑3），供应用层区分「全部/部分无汇率」。
 * by_model 用单独 CTE（jsonb_object_agg）产出，不在主 GROUP BY 加 model 维度，避免粒度爆炸。
 */
function buildGroupsSql(q, p, rules) {
    const { cte } = buildCommonCtes(q, p);
    const bk = bucketExpr("ba.attr_date", q.granularity);
    const bkEvent = bucketExpr("attr_date", q.granularity);
    const whereParts = [];
    if (q.platform !== null) {
        // groups 无 platform 列：平台过滤按 §2.4 走 utm_source→platform 映射（L3 兜底近似）；P0-6 多值 → IN
        const arr = Array.isArray(q.platform) ? q.platform : [q.platform];
        const phs = arr.map((x) => p.add(x));
        whereParts.push(`${(0, attribution_1.buildSourcePlatformCase)("ba.attr_source", rules)} IN (${phs.join(", ")})`);
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const limitPh = p.add(q.limit);
    const sql = `WITH ${cte},
model_counts AS (
  SELECT attr_source, attr_campaign, attr_content, attr_country,
         ${bkEvent} AS bucket,
         model, COUNT(*) AS cnt
  FROM event_attr
  WHERE event_name = 'model_call'
  GROUP BY attr_source, attr_campaign, attr_content, attr_country, ${bkEvent}, model
),
model_agg AS (
  SELECT attr_source, attr_campaign, attr_content, attr_country, bucket,
         jsonb_object_agg(COALESCE(model, '(unknown)'), cnt) AS by_model
  FROM model_counts
  GROUP BY attr_source, attr_campaign, attr_content, attr_country, bucket
)
SELECT
  ${bk}::text AS bucket,
  ba.attr_source   AS utm_source,
  ba.attr_campaign AS utm_campaign,
  ba.attr_content  AS utm_content,
  ba.attr_country  AS country,
  COALESCE(SUM(ba.visits), 0)          AS visits,
  COALESCE(SUM(ba.signups), 0)         AS signups,
  COALESCE(SUM(ba.key_created), 0)     AS key_created,
  COALESCE(SUM(ba.key_users), 0)       AS key_users,
  COALESCE(SUM(ba.model_calls), 0)     AS model_calls,
  COALESCE(SUM(ba.success_calls), 0)   AS success_calls,
  COALESCE(SUM(ba.calls_playground), 0) AS calls_playground,
  COALESCE(SUM(ba.calls_api), 0)       AS calls_api,
  CASE WHEN COALESCE(SUM(ba.latency_cnt), 0) > 0
       THEN SUM(ba.latency_sum) / SUM(ba.latency_cnt)
       ELSE NULL
  END                                   AS avg_latency_ms,
  COALESCE(SUM(ba.recharges), 0)        AS recharges,
  COALESCE(SUM(ba.recharge_users), 0)   AS recharge_users,
  -- fixed2：无充值 → 金额归 0（真实「没回收」）；有充值但金额/汇率缺失 → 保持 NULL（空 vs 零）
  CASE WHEN COALESCE(SUM(ba.recharges), 0) = 0 THEN 0 ELSE SUM(ba.recharge_amount)     END AS recharge_amount,
  CASE WHEN COALESCE(SUM(ba.recharges), 0) = 0 THEN 0 ELSE SUM(ba.recharge_amount_usd) END AS recharge_amount_usd,
  COALESCE(SUM(ba.recharge_fx_missing), 0) AS recharge_fx_missing,
  COALESCE(SUM(ba.auto_recharge_enabled_count), 0) AS auto_recharge_enabled_count,
  COALESCE(ma.by_model, '{}'::jsonb)    AS by_model
FROM behavior_agg ba
LEFT JOIN model_agg ma
  ON ma.attr_source   IS NOT DISTINCT FROM ba.attr_source
 AND ma.attr_campaign IS NOT DISTINCT FROM ba.attr_campaign
 AND ma.attr_content  IS NOT DISTINCT FROM ba.attr_content
 AND ma.attr_country  IS NOT DISTINCT FROM ba.attr_country
 AND ma.bucket = ${bk}
${whereSql}
GROUP BY ${bk}, ba.attr_source, ba.attr_campaign, ba.attr_content, ba.attr_country, ma.by_model
ORDER BY ${bk} DESC, ba.attr_source NULLS LAST, ba.attr_campaign NULLS LAST, ba.attr_content NULLS LAST, ba.attr_country NULLS LAST
LIMIT ${limitPh}`;
    return sql;
}
// ===========================================================================
// §4.2/§4.5 查询 B：归因 ROI（roi_by_entity，素材/系列 + bucket，不含 country）
// ===========================================================================
/**
 * 构建查询 B（§4.2 完整归因解析 SQL + §4.5 查询 B）。
 * 无窗口函数：日级匹配 → entity_candidates 每实体一行（普通 GROUP BY）→ resolved 普通聚合
 * COUNT(*) + array_agg + bool_or。recharge_fx_missing 在此 SELECT 透出（坑3）。
 */
function buildRoiSql(q, p, rules) {
    const { cte, fromDatePh, toDatePh } = buildCommonCtes(q, p);
    const wsPh = p.add(q.workspaceId);
    const bkEvent = bucketExpr("attr_date", q.granularity);
    // L3 兜底：utm_source → platform 映射（仅 account 级）
    const mapSourceB = (0, attribution_1.buildSourcePlatformCase)("b.attr_source", rules);
    // 平台过滤：ad_spend 只认该平台的花费（§2.4 主要用于 roi_by_entity）；P0-6 多值 → IN
    const platArr = q.platform !== null ? (Array.isArray(q.platform) ? q.platform : [q.platform]) : [];
    const platPhs = platArr.map((x) => p.add(x)); // 占位符只计算一次，避免重复 add
    const platIn = platPhs.join(", ");
    const spendPlatform = platArr.length ? `\n    AND p.platform IN (${platIn})` : "";
    // 最终过滤：排除 direct/other；平台过滤时只保留「认领实体 platform 等于该值」的行
    const whereParts = ["r.attr_source IS NOT NULL"];
    if (platArr.length) {
        whereParts.push(`CASE WHEN r.cnt = 1 THEN r.platform ELSE NULL END IN (${platIn})`);
    }
    const whereSql = `WHERE ${whereParts.join(" AND ")}`;
    const limitPh = p.add(q.limit);
    const sql = `WITH ${cte},
behavior_entity_date AS (
  SELECT
    attr_source, attr_campaign, attr_content, attr_date,
    SUM(recharges)           AS recharges,
    SUM(recharge_users)      AS recharge_users,
    SUM(recharge_amount)     AS recharge_amount,
    SUM(recharge_amount_usd) AS recharge_amount_usd,
    SUM(recharge_fx_missing) AS recharge_fx_missing
  FROM behavior_agg
  GROUP BY 1,2,3,4
),
ad_spend AS (
  SELECT
    p.platform, p.account_id, p.entity_id, p.level, p.date,
    p.amount_usd, p.spend, p.currency, p.roas,
    c.name  AS campaign_name,
    cr.name AS creative_name
  FROM ad_performance_daily p
  LEFT JOIN ad_campaigns c
         ON c.workspace_id = p.workspace_id AND c.platform = p.platform
        AND c.account_id = p.account_id AND p.level = 'campaign'
        AND c.campaign_id = p.entity_id
  LEFT JOIN ad_creatives cr
         ON cr.workspace_id = p.workspace_id AND cr.platform = p.platform
        AND cr.account_id = p.account_id AND p.level = 'creative'
        AND cr.creative_id = p.entity_id
  WHERE p.workspace_id = ${wsPh}
    AND p.date >= ${fromDatePh}::date
    AND p.date <= ${toDatePh}::date${spendPlatform}
),
attributed_day AS (
  SELECT
    b.attr_source, b.attr_campaign, b.attr_content, b.attr_date,
    a.platform, a.account_id, a.entity_id, a.level,
    a.amount_usd AS day_spend_usd, a.spend AS day_spend_raw,
    a.currency AS day_spend_currency, a.roas AS day_platform_roas
  FROM behavior_entity_date b
  LEFT JOIN ad_spend a
         ON a.date = b.attr_date
        AND (
          ( b.attr_content IS NOT NULL AND a.level = 'creative'
            AND ( a.entity_id = b.attr_content OR a.creative_name = b.attr_content ) )
          OR
          ( b.attr_content IS NULL AND b.attr_campaign IS NOT NULL AND a.level = 'campaign'
            AND ( a.entity_id = b.attr_campaign OR a.campaign_name = b.attr_campaign ) )
          OR
          ( b.attr_content IS NULL AND b.attr_campaign IS NULL AND a.level = 'account'
            AND a.platform = ${mapSourceB} )
        )
),
behavior_bucket AS (
  SELECT
    attr_source, attr_campaign, attr_content,
    ${bkEvent} AS bucket,
    COALESCE(SUM(recharges), 0)      AS recharges,
    COALESCE(SUM(recharge_users), 0) AS recharge_users,
    -- fixed2：无充值（SUM(recharges)=0）→ 金额归 0；有充值才取 SUM（USD 可能因汇率缺失为 NULL）
    CASE WHEN COALESCE(SUM(recharges), 0) = 0 THEN 0 ELSE SUM(recharge_amount)     END AS recharge_amount,
    CASE WHEN COALESCE(SUM(recharges), 0) = 0 THEN 0 ELSE SUM(recharge_amount_usd) END AS recharge_amount_usd,
    COALESCE(SUM(recharge_fx_missing), 0) AS recharge_fx_missing
  FROM behavior_entity_date
  GROUP BY 1,2,3,4
),
entity_candidates AS (
  SELECT b.attr_source, b.attr_campaign, b.attr_content, b.bucket,
         d.platform, d.account_id, d.entity_id, d.level,
         SUM(d.day_spend_usd) AS entity_spend_usd,
         SUM(d.day_spend_raw) AS entity_spend_raw,
         MAX(d.day_spend_currency) AS entity_spend_currency,
         MAX(d.day_platform_roas) AS entity_platform_roas,
         -- 普通聚合，无窗口函数（坑1）
         COUNT(DISTINCT d.attr_date) FILTER (WHERE d.day_spend_usd IS NOT NULL) AS entity_spend_days,
         bool_or((b.attr_content IS NOT NULL AND d.entity_id = b.attr_content)
              OR (b.attr_content IS NULL AND b.attr_campaign IS NOT NULL
                  AND d.entity_id = b.attr_campaign)) AS is_id_match
  FROM behavior_bucket b
  JOIN attributed_day d
    ON d.attr_source   = b.attr_source
   AND d.attr_campaign = b.attr_campaign
   AND d.attr_content  = b.attr_content
   AND ${bucketExpr("d.attr_date", q.granularity)} = b.bucket
   AND d.entity_id IS NOT NULL
  GROUP BY 1,2,3,4, d.platform, d.account_id, d.entity_id, d.level
),
resolved AS (
  SELECT
    b.attr_source, b.attr_campaign, b.attr_content, b.bucket,
    b.recharges, b.recharge_users, b.recharge_amount, b.recharge_amount_usd,
    b.recharge_fx_missing,
    COALESCE(c.cnt, 0) AS cnt,
    c.has_id_match,
    COALESCE(c.matched_entities, ARRAY[]::text[]) AS matched_entities,
    c.platform, c.account_id, c.entity_id, c.level,
    c.spend_usd, c.spend_raw, c.spend_currency, c.platform_roas, c.spend_days
  FROM behavior_bucket b
  LEFT JOIN (
    SELECT attr_source, attr_campaign, attr_content, bucket,
           COUNT(*) AS cnt,
           array_agg(entity_id ORDER BY entity_id) AS matched_entities,
           bool_or(is_id_match) AS has_id_match,
           MAX(platform) AS platform, MAX(account_id) AS account_id,
           MAX(entity_id) AS entity_id, MAX(level) AS level,
           SUM(entity_spend_usd) AS spend_usd,
           SUM(entity_spend_raw) AS spend_raw,
           MAX(entity_spend_currency) AS spend_currency,
           MAX(entity_platform_roas) AS platform_roas,
           SUM(entity_spend_days) AS spend_days
    FROM entity_candidates
    GROUP BY attr_source, attr_campaign, attr_content, bucket
  ) c
    ON c.attr_source   = b.attr_source
   AND c.attr_campaign = b.attr_campaign
   AND c.attr_content  = b.attr_content
   AND c.bucket        = b.bucket
)
SELECT
  r.bucket::text AS bucket,
  r.attr_source   AS utm_source,
  r.attr_campaign AS utm_campaign,
  r.attr_content  AS utm_content,
  CASE WHEN r.cnt = 1 THEN r.platform   ELSE NULL END AS platform,
  CASE WHEN r.cnt = 1 THEN r.account_id ELSE NULL END AS account_id,
  CASE WHEN r.cnt = 1 THEN r.level      ELSE NULL END AS level,
  CASE WHEN r.cnt = 1 THEN r.entity_id  ELSE NULL END AS entity_id,
  CASE
    WHEN r.cnt = 0 THEN 'no_match'
    WHEN r.cnt = 1 THEN CASE WHEN r.level = 'account' THEN 'account'
                             WHEN r.has_id_match   THEN 'id'
                             ELSE 'name_unique' END
    ELSE 'ambiguous_name'
  END AS match,
  r.matched_entities,
  r.recharges, r.recharge_users, r.recharge_amount, r.recharge_amount_usd,
  r.recharge_fx_missing,
  CASE WHEN r.cnt = 1 THEN r.spend_usd      ELSE NULL END AS attr_spend_usd,
  CASE WHEN r.cnt = 1 THEN r.spend_raw      ELSE NULL END AS attr_spend_raw,
  CASE WHEN r.cnt = 1 THEN r.spend_currency ELSE NULL END AS attr_spend_currency,
  CASE WHEN r.cnt = 1 THEN r.platform_roas  ELSE NULL END AS platform_roas,
  CASE WHEN r.cnt = 1 THEN r.spend_days     ELSE NULL END AS spend_days,
  -- fixed3：roi 三分支，显式区分「无充值→0」「有充值全无汇率→NULL」「分母缺失→NULL」
  CASE
    WHEN r.cnt <> 1                            THEN NULL
    WHEN r.spend_usd IS NULL OR r.spend_usd = 0 THEN NULL
    WHEN r.recharges = 0                       THEN 0
    WHEN r.recharge_amount_usd IS NULL         THEN NULL
    ELSE r.recharge_amount_usd / r.spend_usd
  END AS roi
FROM resolved r
${whereSql}
ORDER BY attr_spend_usd DESC NULLS LAST
LIMIT ${limitPh}`;
    return sql;
}
/**
 * 收口：剔除「传了但 SQL 里没引用」的参数，并按首次出现顺序重新编号。
 *
 * 为什么必须做（真库实测缺陷，2026-09-11 交付版发现）：
 *   buildCommonCtes 被 groups 与 roi 共用，它一次性分配了 $1..$6，
 *   但 $4（转化回溯窗口）、$5/$6（日期字符串）只有 roi 用得上。
 *   groups 的 values 于是带着 3 个「多余参数」发给了 PostgreSQL。
 *   PostgreSQL 无法推断未被引用参数的类型 → 直接报
 *     "could not determine data type of parameter $4"
 *   于是**归因漏斗在任何真库上都查不出来**（此前只有内存假池，SQL 从未真正执行，故未暴露）。
 *
 * 变换的正确性：
 *   · 未被 SQL 文本引用的参数不可能影响结果，丢掉它们是语义等价的；
 *   · 重编号是 $N → 新 $M 的一一映射，所有引用同步替换，引用关系完全保持。
 */
function compactBuiltSql(built) {
    const usedInOrder = [];
    const seen = new Set();
    const re = /\$(\d+)/g;
    let m;
    while ((m = re.exec(built.sql)) !== null) {
        const n = Number(m[1]);
        if (!seen.has(n)) {
            seen.add(n);
            usedInOrder.push(n);
        }
    }
    // 已是最简（每个位置都被引用且无空洞）→ 原样返回，避免无谓改动
    const isTight = usedInOrder.length === built.values.length &&
        usedInOrder.every((n, i) => n === i + 1);
    if (isTight)
        return built;
    const rank = new Map();
    usedInOrder.forEach((n, i) => rank.set(n, i + 1));
    const sql = built.sql.replace(/\$(\d+)/g, (_all, d) => `$${rank.get(Number(d))}`);
    const values = usedInOrder.map((n) => built.values[n - 1]);
    return { sql, values };
}
/** 一次性构建两条 SQL（查询 A + 查询 B），各自独立参数数组。 */
function buildFunnelSql(q, opts = {}) {
    const rules = opts.sourcePlatformRules ?? attribution_1.DEFAULT_SOURCE_PLATFORM_RULES;
    const gp = new Params();
    const rp = new Params();
    return {
        groups: compactBuiltSql({ sql: buildGroupsSql(q, gp, rules), values: gp.values }),
        roi: compactBuiltSql({ sql: buildRoiSql(q, rp, rules), values: rp.values }),
    };
}
// ===========================================================================
// 序列化（pg 返回 bigint/numeric 为字符串；空 vs 零：金额/spend 绝不把 NULL 当 0）
// ===========================================================================
/** 计数列（COUNT/COUNT DISTINCT）：pg 返回 numeric 字符串；null 兜底 0。 */
function toNum(v) {
    if (v === null || v === undefined)
        return 0;
    return typeof v === "string" ? Number(v) : v;
}
/** 求和/比值列（SUM numeric / 除法）：无数据为 null，不编造 0（空 vs 零关键）。 */
function toNumOrNull(v) {
    if (v === null || v === undefined)
        return null;
    return typeof v === "string" ? Number(v) : v;
}
/** 文本列：string 直通，否则 null。 */
function toStrOrNull(v) {
    return typeof v === "string" ? v : null;
}
/** text[] → string[]（pg 返回 JS 数组；非数组兜底空数组）。 */
function toStrArray(v) {
    if (Array.isArray(v)) {
        return v.map((x) => (typeof x === "string" ? x : String(x)));
    }
    return [];
}
/** jsonb by_model → Record<string, number>（jsonb_object_agg 结果）。 */
function toModelMap(v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = typeof val === "string" ? Number(val) : val;
        }
        return out;
    }
    return {};
}
/** 查询 A 行 → FunnelGroup。 */
function serializeFunnelGroup(row, granularity) {
    const visits = toNum(row.visits);
    const signups = toNum(row.signups);
    const keyUsers = toNum(row.key_users);
    const rechargeUsers = toNum(row.recharge_users);
    const group = {
        ...(granularity !== "total" ? { bucket: toStrOrNull(row.bucket) ?? undefined } : {}),
        utm_source: toStrOrNull(row.utm_source),
        utm_campaign: toStrOrNull(row.utm_campaign),
        utm_content: toStrOrNull(row.utm_content),
        country: toStrOrNull(row.country),
        funnel: {
            visits,
            signups,
            key_created: toNum(row.key_created),
            key_users: keyUsers,
            recharges: toNum(row.recharges),
            recharge_users: rechargeUsers,
            recharge_amount: toNumOrNull(row.recharge_amount),
            recharge_amount_usd: toNumOrNull(row.recharge_amount_usd),
            recharge_fx_missing: toNum(row.recharge_fx_missing),
        },
        rates: {
            // 链式转化率（§3.1 示例 0.20/0.75/0.25 = signups/visits · key_users/signups · recharge_users/key_users）
            signup_rate: visits > 0 ? signups / visits : 0,
            key_rate: signups > 0 ? keyUsers / signups : 0,
            recharge_rate: keyUsers > 0 ? rechargeUsers / keyUsers : 0,
        },
        calls: {
            model_calls: toNum(row.model_calls),
            success_calls: toNum(row.success_calls),
            avg_latency_ms: toNumOrNull(row.avg_latency_ms),
            by_source: {
                playground: toNum(row.calls_playground),
                api: toNum(row.calls_api),
            },
            by_model: toModelMap(row.by_model),
        },
        auto_recharge_enabled_count: toNum(row.auto_recharge_enabled_count),
    };
    return group;
}
/** §3.3 roi_note 映射（应用层生成；SQL 只产原始值）。判定顺序先 match 再分母再分子。 */
function resolveRoiNote(e) {
    if (e.match === "no_match")
        return "有 UTM 但未匹配到广告实体";
    if (e.match === "ambiguous_name")
        return "素材/系列名重名，无法唯一归因（建议埋点改存 creative_id）";
    if (e.attr_spend_usd === null || e.attr_spend_usd === 0) {
        return e.recharges === 0
            ? "广告花费缺失/为0（且无充值），ROI 无意义"
            : "广告花费缺失/为0，ROI 无意义";
    }
    if (e.recharges === 0)
        return "有花费无充值";
    if (e.recharge_amount_usd === null)
        return "充值币种折算缺失";
    if (e.recharge_fx_missing > 0 && e.recharge_fx_missing < e.recharges)
        return "部分充值币种折算缺失";
    return null;
}
/** 查询 B 行 → RoiEntity。 */
function serializeRoiEntity(row, granularity) {
    const base = {
        utm_source: toStrOrNull(row.utm_source),
        utm_campaign: toStrOrNull(row.utm_campaign),
        utm_content: toStrOrNull(row.utm_content),
        platform: toStrOrNull(row.platform),
        account_id: toStrOrNull(row.account_id),
        level: toStrOrNull(row.level),
        entity_id: toStrOrNull(row.entity_id),
        match: toStrOrNull(row.match),
        matched_entities: toStrArray(row.matched_entities),
        recharges: toNum(row.recharges),
        recharge_users: toNum(row.recharge_users),
        recharge_amount: toNumOrNull(row.recharge_amount),
        recharge_amount_usd: toNumOrNull(row.recharge_amount_usd),
        recharge_fx_missing: toNum(row.recharge_fx_missing),
        attr_spend_usd: toNumOrNull(row.attr_spend_usd),
        attr_spend_raw: toNumOrNull(row.attr_spend_raw),
        attr_spend_currency: toStrOrNull(row.attr_spend_currency),
        platform_roas: toNumOrNull(row.platform_roas),
        spend_days: toNumOrNull(row.spend_days),
        roi: toNumOrNull(row.roi),
    };
    return {
        ...(granularity !== "total" ? { bucket: toStrOrNull(row.bucket) ?? undefined } : {}),
        ...base,
        roi_note: resolveRoiNote(base),
    };
}
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;
const GRANULARITIES = ["total", "day", "week", "month"];
const PLATFORMS = ["meta", "google", "x"];
/** 是否合法非负整数（十进制，无符号/空格/小数）。 */
function isNonNegativeInt(s) {
    return /^\d+$/.test(s);
}
/**
 * 解析并校验查询参数（§1.2 / §1.4 / §2.5）。
 * - from/to：非负安全整数 epoch 毫秒；from > to → 400。
 * - granularity：total/day/week/month（默认 total），非法 → 400。
 * - platform：meta/google（空串视同不过滤），非法 → 400。
 * - limit：>0；>1000 截断 1000（不报错）。
 * - conversion_window_days：>=0，非法 → 400。
 * 注意：本函数绝不读取 / 使用任何 tenant_id 入参（§5）。
 */
function parseFunnelParams(query) {
    const q = (query ?? {});
    const get = (key) => {
        const v = q[key];
        if (typeof v === "string")
            return v;
        if (Array.isArray(v) && typeof v[0] === "string")
            return v[0];
        return undefined;
    };
    let from = null;
    let to = null;
    const fromRaw = get("from");
    const toRaw = get("to");
    if (fromRaw !== undefined) {
        if (!isNonNegativeInt(fromRaw)) {
            return { ok: false, message: "from 需为非负整数（epoch 毫秒）" };
        }
        from = Number(fromRaw);
        if (!Number.isSafeInteger(from)) {
            return { ok: false, message: "from 超出安全整数范围" };
        }
    }
    if (toRaw !== undefined) {
        if (!isNonNegativeInt(toRaw)) {
            return { ok: false, message: "to 需为非负整数（epoch 毫秒）" };
        }
        to = Number(toRaw);
        if (!Number.isSafeInteger(to)) {
            return { ok: false, message: "to 超出安全整数范围" };
        }
    }
    if (from !== null && to !== null && from > to) {
        return { ok: false, message: "from 不能大于 to" };
    }
    const granularityRaw = get("granularity");
    let granularity = "total";
    if (granularityRaw !== undefined && granularityRaw.length > 0) {
        if (!GRANULARITIES.includes(granularityRaw)) {
            return { ok: false, message: "granularity 需为 total/day/week/month 之一" };
        }
        granularity = granularityRaw;
    }
    const strOrNull = (raw) => raw !== undefined && raw.length > 0 ? raw : null;
    // P0-6：支持逗号分隔多值（前端多选筛选）→ 数组；空串/空数组视同不过滤
    const strListOrNull = (raw) => {
        if (raw === undefined || raw === null || String(raw).length === 0) return null;
        const arr = String(raw).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        return arr.length > 0 ? arr : null;
    };
    const platformRaw = get("platform");
    let platform = null;
    if (platformRaw !== undefined && platformRaw.length > 0) {
        const arr = String(platformRaw).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (arr.length === 0 || arr.some((p) => !PLATFORMS.includes(p))) {
            return { ok: false, message: "platform 需为 meta/google/x 之一" };
        }
        platform = arr;
    }
    let conversionWindowDays = 0;
    const cwdRaw = get("conversion_window_days");
    if (cwdRaw !== undefined) {
        if (!isNonNegativeInt(cwdRaw)) {
            return { ok: false, message: "conversion_window_days 需为非负整数" };
        }
        conversionWindowDays = Number(cwdRaw);
        if (!Number.isSafeInteger(conversionWindowDays)) {
            return { ok: false, message: "conversion_window_days 超出安全整数范围" };
        }
    }
    let limit = DEFAULT_LIMIT;
    const limitRaw = get("limit");
    if (limitRaw !== undefined) {
        if (!isNonNegativeInt(limitRaw)) {
            return { ok: false, message: "limit 需为非负整数" };
        }
        limit = Number(limitRaw);
        if (limit <= 0) {
            return { ok: false, message: "limit 需大于 0" };
        }
        if (limit > MAX_LIMIT)
            limit = MAX_LIMIT; // 超上限截断，不报错（§1.2）
    }
    return {
        ok: true,
        params: {
            from,
            to,
            granularity,
            country: strListOrNull(get("country")),
            platform,
            utmSource: strListOrNull(get("utm_source")),
            utmCampaign: strListOrNull(get("utm_campaign")),
            utmContent: strListOrNull(get("utm_content")),
            conversionWindowDays,
            limit,
        },
    };
}
async function queryFreshness(client, tenantId, workspaceId, platform) {
    const eventsRes = await client.query("SELECT MAX(seq)::text AS m FROM pt_events WHERE tenant_id = $1::uuid", [tenantId]);
    // P1 修复：workspaceId 为 null/空（未知租户在 tenant_workspaces 无映射）时，绝不查询 ad_performance_daily，
    // 直接置 ads_synced_through = null —— 杜绝跨租户广告数据水位泄漏（此前回落演示工作区会泄出演示租户的 MAX(date)）。
    let adsSyncedThrough = null;
    if (workspaceId !== null && workspaceId !== undefined && workspaceId !== "") {
        // P0-6：platform 可能是数组（多选），这里做 IN 展开（$1 = workspaceId）
        const platArr = platform === null || platform === undefined ? [] : (Array.isArray(platform) ? platform : [platform]);
        const phs = platArr.map((_, i) => `$${2 + i}`);
        const platformClause = platArr.length ? ` AND platform IN (${phs.join(", ")})` : "";
        const adsValues = platArr.length ? [workspaceId, ...platArr] : [workspaceId];
        const adsRes = await client.query(`SELECT MAX(date)::text AS m FROM ad_performance_daily WHERE workspace_id = $1${platformClause}`, adsValues);
        adsSyncedThrough = adsRes.rows[0]?.m ?? null;
    }
    return {
        events_max_seq: eventsRes.rows[0]?.m ?? null,
        ads_synced_through: adsSyncedThrough,
    };
}
/**
 * 在「租户上下文 + RLS + READ ONLY」下执行漏斗查询（复用 events/query.ts §6 隔离入口）。
 * 事务内：
 *   1. BEGIN READ ONLY —— 只读铁律在 DB 层硬保证。
 *   2. set_config('app.current_tenant_id', $1, true) —— RLS 上下文（pt_events FORCE RLS）。
 *   3. 缺省回填 from（事件表最早时间）。
 *   4. 查询 A（groups）+ 查询 B（roi_by_entity）+ 数据水位。
 * 全文件无 INSERT/UPDATE/DELETE。
 */
async function queryFunnelScoped(pool, tenantId, workspaceId, params, opts = {}) {
    if (!(0, validate_1.isUuid)(tenantId)) {
        throw new Error("tenantId 非法（非 UUID）");
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        try {
            await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
                tenantId,
            ]);
            const to = params.to ?? Date.now();
            let from = params.from;
            if (from === null) {
                const minRes = await client.query("SELECT MIN(timestamp)::text AS m FROM pt_events WHERE tenant_id = $1::uuid", [tenantId]);
                const m = minRes.rows[0]?.m;
                from = m !== null && m !== undefined ? Number(m) : 0;
            }
            const effective = { ...params, tenantId, workspaceId, from, to };
            const { groups, roi } = buildFunnelSql(effective, opts);
            const groupsRes = await client.query(groups.sql, groups.values);
            const roiRes = await client.query(roi.sql, roi.values);
            const freshness = await queryFreshness(client, tenantId, workspaceId, params.platform);
            await client.query("COMMIT");
            // 分组 SQL 内部按 bucket 倒序取（见 buildGroupsSql 的 ORDER BY 注释）：
            // 这样一旦命中 LIMIT，被丢掉的是**最老**的数据，而不是最新的。
            // 对外仍按时间升序返回，保持契约不变，所以这里翻回来。
            const groupRows = [...groupsRes.rows].reverse();
            // 截断信号：调用方拿到的条数正好等于 limit，说明可能还有更多没返回。
            // 以前这里没有任何提示，产品会看到"合计对不上"却找不到原因。
            const groupsTruncated = groupRows.length >= effective.limit;
            const roiTruncated = roiRes.rows.length >= effective.limit;
            // 截断绝不能是静默的。
            // 放在这里（而不是各个 HTTP 路由里）是为了对**所有调用方**都生效 ——
            // 统一入口和独立 funnel 路由各自都构造了一份响应，路由层容易漏。
            if (groupsTruncated || roiTruncated) {
                const payload = {
                    tenant_id: tenantId,
                    granularity: effective.granularity,
                    limit: effective.limit,
                    groups: groupRows.length,
                    roi_by_entity: roiRes.rows.length,
                };
                if (opts.logger) {
                    opts.logger.warn(payload, "funnel 结果被 limit 截断（已保留最新数据）");
                }
                else {
                    // 没有 logger 也不能吞掉 —— 至少打到 stderr，线上能捞出来
                    console.warn("[funnel] 结果被 limit 截断（已保留最新数据）：" + JSON.stringify(payload));
                }
            }
            return {
                from,
                to,
                groups: groupRows,
                roi: roiRes.rows,
                freshness,
                groupsTruncated,
                roiTruncated,
            };
        }
        catch (err) {
            await client.query("ROLLBACK").catch(() => {
                /* 回滚失败不掩盖原始错误 */
            });
            throw err;
        }
    }
    finally {
        client.release();
    }
}
function errorBody(code, message) {
    return { ok: false, error: { code, message } };
}
function toError(err) {
    return err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : "unknown error");
}
/**
 * 构建漏斗查询服务（§1.1）。
 * 路由：GET /api/analytics/funnel。
 * 鉴权完全复用 1.4 query.ts §4：只读 token → tenant_id；读写 key/webhook Secret → 403。
 */
function buildFunnelServer(options) {
    const { pool, verifyAnalyticsToken, resolveWorkspaceId = (tenantId) => tenantId, sourcePlatformRules = attribution_1.DEFAULT_SOURCE_PLATFORM_RULES, now = Date.now, logger = true, } = options;
    const app = (0, fastify_1.default)({ logger });
    app.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "funnel query failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        reply
            .status(statusCode)
            .send(errorBody(statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", statusCode >= 500 ? "internal error" : "bad request"));
    });
    app.get("/api/analytics/funnel", async (request, reply) => {
        // ① 解析凭证（§5）：缺失 / 非法 → 401
        const authHeader = request.headers["authorization"];
        const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token = (0, query_1.parseAuthorization)(raw);
        if (token === null) {
            return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
        }
        // ② 只反查只读分析 token；查询出错 → 500
        let auth;
        try {
            auth = await verifyAnalyticsToken(token);
        }
        catch (err) {
            request.log.error({ err: toError(err) }, "token verification failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ③ 可识别但非只读 token（读写 key / webhook Secret / 未知）→ 403
        if (auth === null) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ④ 过期只读 token → 401
        if (auth.expires_at !== null && auth.expires_at <= now()) {
            return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
        }
        // ⑤ scope 不足（不含 analytics:read）→ 403
        if (!Array.isArray(auth.scopes) || !auth.scopes.includes("analytics:read")) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ⑥ tenant 只从 token 派生（§5）；非法 UUID 是服务端配置错误 → 500
        const tenantId = auth.tenant_id;
        if (!(0, validate_1.isUuid)(tenantId)) {
            request.log.error({ tenant_id: tenantId }, "token tenant_id is not a UUID");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑦ 参数校验前置（§2.5）：from>to / granularity / platform / limit / window → 400
        const parsed = parseFunnelParams(request.query);
        if (!parsed.ok) {
            return reply
                .status(400)
                .send(errorBody("INVALID_QUERY", parsed.message));
        }
        // ⑧ workspace_id 映射（默认恒等，可注入覆盖）
        let workspaceId;
        try {
            workspaceId = await resolveWorkspaceId(tenantId);
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "resolveWorkspaceId failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑨ 查询（SET LOCAL RLS 上下文 + 显式 WHERE 双保险）
        let result;
        try {
            result = await queryFunnelScoped(pool, tenantId, workspaceId, parsed.params, {
                sourcePlatformRules,
            });
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "query failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑩ 序列化：bucket 仅在 granularity != total 时出现；空 vs 零在 SQL+序列化双重保持
        const response = {
            from: result.from,
            to: result.to,
            granularity: parsed.params.granularity,
            platform: parsed.params.platform,
            country: parsed.params.country,
            groups: result.groups.map((r) => serializeFunnelGroup(r, parsed.params.granularity)),
            roi_by_entity: result.roi.map((r) => serializeRoiEntity(r, parsed.params.granularity)),
            data_freshness: {
                ...result.freshness,
                generated_at: new Date(now()).toISOString(),
            },
            // 截断提示：以前截断是完全静默的，产品只看到"数字对不上"却查不出原因。
            // 现在显式告知 —— 调用方可以据此提示用户，或自行提高 limit 重查。
            truncated: {
                groups: result.groupsTruncated,
                roi_by_entity: result.roiTruncated,
                limit: parsed.params.limit,
                note: result.groupsTruncated
                    ? "结果条数达到 limit，已保留最新的数据；如需完整结果请提高 limit（上限 1000）或缩小时间窗"
                    : null,
            },
        };
        return reply.status(200).send(response);
    });
    return app;
}
/** 构建并监听，返回已启动的服务与关闭句柄。 */
async function startFunnelServer(options) {
    const app = buildFunnelServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3001);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
//# sourceMappingURL=funnel.js.map