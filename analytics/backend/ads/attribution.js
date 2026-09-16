"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SOURCE_PLATFORM_RULES = void 0;
exports.buildSourcePlatformCase = buildSourcePlatformCase;
exports.buildFunnelSql = buildFunnelSql;
exports.buildRoiSql = buildRoiSql;
exports.buildAttributionSql = buildAttributionSql;
exports.mapFunnelRow = mapFunnelRow;
exports.mapRoiRow = mapRoiRow;
exports.resolveRoi = resolveRoi;
exports.queryAttribution = queryAttribution;
const validate_1 = require("../collect/validate");
/**
 * 默认映射规则（§1.3 表）：含 google → google；含 facebook/meta/fb/instagram/ig → meta。
 * 不硬编码死映射——调用方可传自定义 rules 覆盖；本期只接 meta/google 两个平台，
 * 其它 / 空 → NULL（无归因）。
 */
exports.DEFAULT_SOURCE_PLATFORM_RULES = [
    { pattern: "google", platform: "google" },
    { pattern: "facebook", platform: "meta" },
    { pattern: "meta", platform: "meta" },
    { pattern: "instagram", platform: "meta" },
    { pattern: "fb", platform: "meta" },
    { pattern: "ig", platform: "meta" },
    { pattern: "x", platform: "x" },
];
/** SQL 字符串字面量转义（patterns 为代码常量，非用户输入；仍转义单引号防注入）。 */
function sqlLiteral(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
/**
 * 生成 `map_source_platform(expr)` 的 SQL CASE 展开（§1.3 占位符的落地）。
 * 输出形如：CASE WHEN expr ILIKE '%google%' THEN 'google'
 *             WHEN expr ILIKE '%facebook%' OR … THEN 'meta'
 *             ELSE NULL END
 * 注意：pattern 按字面子串匹配（ILIKE '%pattern%'），自定义规则若含 %/_ 通配符需自行转义。
 */
function buildSourcePlatformCase(expr, rules = exports.DEFAULT_SOURCE_PLATFORM_RULES) {
    const byPlatform = new Map();
    for (const r of rules) {
        const list = byPlatform.get(r.platform);
        if (list)
            list.push(r.pattern);
        else
            byPlatform.set(r.platform, [r.pattern]);
    }
    const clauses = [];
    for (const [platform, patterns] of byPlatform) {
        clauses.push(`WHEN ${patterns.map((p) => `${expr} ILIKE ${sqlLiteral(`%${p}%`)}`).join(" OR ")} THEN ${sqlLiteral(platform)}`);
    }
    if (clauses.length === 0)
        return "NULL";
    return `CASE ${clauses.join(" ")} ELSE NULL END`;
}
// ===========================================================================
// 参数累积 + 日期表达式辅助
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
/**
 * epoch 毫秒 → UTC 日 的 SQL 表达式（不依赖会话时区，AT TIME ZONE 'UTC' 自洽）。
 * 与 2.2 落库的 ad_performance_daily.date（UTC 日）对齐。
 */
const epochToUtcDate = (expr) => `(to_timestamp(${expr}::double precision / 1000.0) AT TIME ZONE 'UTC')::date`;
// ===========================================================================
// SQL 构建：共用 CTE ① 首触快照 ② 事件归因标签 + 逐事件折 USD ③ 行为聚合
// ===========================================================================
/**
 * 构建共用 CTE（user_attr / event_attr / behavior_agg，§3.4 ①②③）。
 * 参数顺序固定：tenantId, from, to, [utmSource, utmCampaign, utmContent, country]。
 * 返回 CTE 文本 + from/to 占位符（供查询 B 的 ad_spend 复用同一对日期参数）。
 */
function buildCommonCtes(q, p) {
    const tenantPh = p.add(q.tenantId);
    const fromPh = p.add(q.from);
    const toPh = p.add(q.to);
    // event_attr 的可选筛选（对归因后标签 COALESCE(e.*, ua.*) 精确过滤，§3.4 ②）
    const filters = [];
    const addEq = (expr, v) => {
        if (v === null || v === undefined)
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
    e.visitor_id,
    e.user_id,
    e.event_name,
    e.success,
    e.source,
    e.latency_ms,
    e.enabled,
    e.amount,
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
    END AS recharge_amount_usd,
    CASE WHEN e.event_name = 'recharge' AND e.status = 'success'
              AND e.currency IS DISTINCT FROM 'USD'
              AND fx.rate IS NULL
         THEN 1 ELSE 0 END AS recharge_fx_missing
  FROM pt_events e
  LEFT JOIN user_attr ua ON ua.user_id = e.user_id
  LEFT JOIN fx_rates fx
         ON e.event_name = 'recharge'
        AND fx.currency = e.currency
        AND fx.base = 'USD'
        AND fx.fx_date = ${epochToUtcDate("e.timestamp")}
  WHERE e.tenant_id = ${tenantPh}::uuid
    AND e.timestamp >= ${fromPh} AND e.timestamp <= ${toPh}${filterSql}
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
    SUM(recharge_fx_missing)                                                       AS recharge_fx_missing,
    COUNT(*) FILTER (WHERE event_name = 'auto_recharge_toggle' AND enabled)        AS auto_recharge_enabled_count
  FROM event_attr
  GROUP BY 1,2,3,4,5,6,7
)`;
    return { cte, fromPh, toPh };
}
/** 构建查询 A（§3.4 查询 A，逐字对齐；country 粒度只出行为，不出 ROI）。 */
function buildFunnelSql(q) {
    const p = new Params();
    const { cte } = buildCommonCtes(q, p);
    const sql = `WITH ${cte}
SELECT
  attr_source    AS utm_source,
  attr_campaign  AS utm_campaign,
  attr_content   AS utm_content,
  attr_country   AS country,
  SUM(visits)                      AS visits,
  SUM(signups)                     AS signups,
  SUM(key_created)                 AS key_created,
  SUM(key_users)                   AS key_users,
  SUM(model_calls)                 AS model_calls,
  SUM(success_calls)               AS success_calls,
  SUM(calls_playground)            AS calls_playground,
  SUM(calls_api)                   AS calls_api,
  CASE WHEN SUM(latency_cnt) > 0
       THEN SUM(latency_sum) / SUM(latency_cnt)
       ELSE NULL
  END                              AS avg_latency_ms,
  SUM(recharges)                   AS recharges,
  SUM(recharge_users)              AS recharge_users,
  SUM(recharge_amount)             AS recharge_amount,
  SUM(recharge_amount_usd)         AS recharge_amount_usd,
  SUM(auto_recharge_enabled_count) AS auto_recharge_enabled_count
FROM behavior_agg
GROUP BY 1,2,3,4
ORDER BY 1 NULLS LAST, 2 NULLS LAST, 3 NULLS LAST, 4 NULLS LAST`;
    return { sql, values: p.values };
}
// ===========================================================================
// 查询 B：归因 ROI（素材/系列粒度，不含 country，§3.6）
// ===========================================================================
/** 构建查询 B（§3.4 查询 B；花费在「素材/系列 × 日」粒度，不含 country，不重复计）。 */
function buildRoiSql(q, opts = {}) {
    const p = new Params();
    const { cte, fromPh, toPh } = buildCommonCtes(q, p);
    const wsPh = p.add(q.workspaceId);
    const mapSource = buildSourcePlatformCase("b.attr_source", opts.sourcePlatformRules ?? exports.DEFAULT_SOURCE_PLATFORM_RULES);
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
    AND p.date >= ${epochToUtcDate(fromPh)}
    AND p.date <= ${epochToUtcDate(toPh)}
),
attributed_entity AS (
  SELECT
    b.attr_source, b.attr_campaign, b.attr_content, b.attr_date,
    b.recharges, b.recharge_users, b.recharge_amount, b.recharge_amount_usd,
    a.platform, a.account_id, a.entity_id, a.level,
    a.amount_usd AS attr_spend_usd,
    a.spend     AS attr_spend_raw,
    a.currency  AS attr_spend_currency,
    a.roas      AS platform_roas
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
            AND a.platform = ${mapSource} )
        )
)
SELECT
  attr_source       AS utm_source,
  attr_campaign     AS utm_campaign,
  attr_content      AS utm_content,
  MAX(platform)     AS platform,
  MAX(account_id)   AS account_id,
  MAX(level)        AS level,
  MAX(entity_id)    AS entity_id,
  SUM(recharges)            AS recharges,
  SUM(recharge_users)       AS recharge_users,
  SUM(recharge_amount)      AS recharge_amount,
  SUM(recharge_amount_usd)  AS recharge_amount_usd,
  SUM(recharge_fx_missing)  AS fx_missing_recharges,
  SUM(attr_spend_usd)       AS attr_spend_usd,
  MAX(platform_roas)        AS platform_roas,
  COUNT(DISTINCT attr_date) FILTER (WHERE attr_spend_usd IS NOT NULL) AS spend_days,
  CASE
    WHEN SUM(attr_spend_usd) IS NULL OR SUM(attr_spend_usd) = 0
         THEN NULL
    ELSE SUM(recharge_amount_usd) / SUM(attr_spend_usd)
  END AS roi
FROM attributed_entity
WHERE attr_source IS NOT NULL
GROUP BY 1,2,3
ORDER BY SUM(attr_spend_usd) DESC NULLS LAST`;
    return { sql, values: p.values };
}
/** 一次性构建两条 SQL（查询 A + 查询 B），各自独立参数数组。 */
function buildAttributionSql(q, opts = {}) {
    return { funnel: buildFunnelSql(q), roi: buildRoiSql(q, opts) };
}
// ===========================================================================
// 序列化（pg 返回 bigint/numeric 为字符串，转 number；无数据保持 null 不补 0）
// ===========================================================================
/** 计数列（COUNT/COUNT DISTINCT）：pg 返回 bigint 字符串；null 兜底 0。 */
function toCount(v) {
    if (v === null || v === undefined)
        return 0;
    return typeof v === "string" ? Number(v) : v;
}
/** 求和/比值列（SUM numeric / 除法）：无数据为 null，不编造 0。 */
function toNumOrNull(v) {
    if (v === null || v === undefined)
        return null;
    return typeof v === "string" ? Number(v) : v;
}
/** 文本列：string 直通，否则 null。 */
function toStrOrNull(v) {
    return typeof v === "string" ? v : null;
}
/** 查询 A 行 → FunnelGroup。 */
function mapFunnelRow(row) {
    return {
        utm_source: toStrOrNull(row.utm_source),
        utm_campaign: toStrOrNull(row.utm_campaign),
        utm_content: toStrOrNull(row.utm_content),
        country: toStrOrNull(row.country),
        visits: toCount(row.visits),
        signups: toCount(row.signups),
        key_created: toCount(row.key_created),
        key_users: toCount(row.key_users),
        model_calls: toCount(row.model_calls),
        success_calls: toCount(row.success_calls),
        calls_playground: toCount(row.calls_playground),
        calls_api: toCount(row.calls_api),
        avg_latency_ms: toNumOrNull(row.avg_latency_ms),
        recharges: toCount(row.recharges),
        recharge_users: toCount(row.recharge_users),
        recharge_amount: toNumOrNull(row.recharge_amount),
        recharge_amount_usd: toNumOrNull(row.recharge_amount_usd),
        auto_recharge_enabled_count: toCount(row.auto_recharge_enabled_count),
    };
}
/** 查询 B 行 → RoiEntity。 */
function mapRoiRow(row) {
    return {
        utm_source: toStrOrNull(row.utm_source),
        utm_campaign: toStrOrNull(row.utm_campaign),
        utm_content: toStrOrNull(row.utm_content),
        platform: toStrOrNull(row.platform),
        account_id: toStrOrNull(row.account_id),
        level: toStrOrNull(row.level),
        entity_id: toStrOrNull(row.entity_id),
        recharges: toCount(row.recharges),
        recharge_users: toCount(row.recharge_users),
        recharge_amount: toNumOrNull(row.recharge_amount),
        recharge_amount_usd: toNumOrNull(row.recharge_amount_usd),
        fx_missing_recharges: toCount(row.fx_missing_recharges),
        attr_spend_usd: toNumOrNull(row.attr_spend_usd),
        platform_roas: toNumOrNull(row.platform_roas),
        spend_days: toCount(row.spend_days),
        roi: toNumOrNull(row.roi),
    };
}
// ===========================================================================
// §3.5 roi_note 应用层生成 + ROI 展示口径
// ===========================================================================
/**
 * 按 §3.5 边界表生成 ROI 展示口径（roi 值 + roi_note）。
 * SQL 只产原始数值；此函数把「roi 是否为 null、花费是否缺失/0、是否无充值、是否缺汇率」
 * 映射成最终展示值 + 人话说明（修订 #5：roi_note 由应用层/序列化层产出，不拼进 SQL）。
 *
 * 边界（§3.5 表）：
 *   未匹配到广告实体（platform 与花费均 null）→ roi null + "无归因（未匹配到广告实体）"
 *   花费缺失/为 0                              → roi null + "广告花费缺失/为0，ROI 无意义"
 *   有花费无充值                               → roi 0    + "有花费无充值"
 *   全部充值折 USD 缺失（recharge_amount_usd 为 null）→ roi null + "部分充值币种折算缺失"
 *   部分充值折 USD 缺失（fx_missing_recharges > 0）  → roi 可算值 + "部分充值币种折算缺失"
 *   正常                                            → roi = recharge_amount_usd / spend，无 note
 */
function resolveRoi(e) {
    // LEFT JOIN 未命中：platform 与 attr_spend_usd 同时为 null（无归因）
    if (e.platform === null && e.attr_spend_usd === null) {
        return { roi: null, roi_note: "无归因（未匹配到广告实体）" };
    }
    const spend = e.attr_spend_usd;
    if (spend === null || spend === 0) {
        return { roi: null, roi_note: "广告花费缺失/为0，ROI 无意义" };
    }
    if (e.recharges === 0) {
        return { roi: 0, roi_note: "有花费无充值" };
    }
    if (e.recharge_amount_usd === null) {
        return { roi: null, roi_note: "部分充值币种折算缺失" };
    }
    if (e.fx_missing_recharges > 0) {
        return { roi: e.recharge_amount_usd / spend, roi_note: "部分充值币种折算缺失" };
    }
    return { roi: e.recharge_amount_usd / spend, roi_note: null };
}
// ===========================================================================
// 查询核心（只读事务 + RLS 上下文 + 双保险）
// ===========================================================================
/**
 * 在「租户上下文 + RLS + READ ONLY」下执行归因查询（复用 events/query.ts §6 隔离入口）。
 * 事务内：
 *   1. BEGIN READ ONLY —— 只读铁律在 DB 层硬保证。
 *   2. SELECT set_config('app.current_tenant_id', $1, true) —— RLS 上下文（pt_events FORCE RLS）。
 *   3. 查询 A（漏斗）+ 查询 B（ROI）—— SQL 内显式 WHERE tenant_id = $1::uuid 双保险。
 * 全文件无 INSERT/UPDATE/DELETE。
 */
async function queryAttribution(pool, q) {
    // 入参校验（fail-fast；tenant 只认调用方注入，绝不读事件体）
    if (!(0, validate_1.isUuid)(q.tenantId)) {
        throw new Error("tenantId 非法（非 UUID）");
    }
    if (!Number.isSafeInteger(q.from) ||
        !Number.isSafeInteger(q.to) ||
        q.from < 0 ||
        q.to < 0 ||
        q.from > q.to) {
        throw new Error("from/to 非法（需非负安全整数，且 from <= to）");
    }
    const { funnel, roi } = buildAttributionSql(q);
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        try {
            await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
                q.tenantId,
            ]);
            const funnelRes = await client.query(funnel.sql, funnel.values);
            const roiRes = await client.query(roi.sql, roi.values);
            await client.query("COMMIT");
            return {
                funnel: funnelRes.rows.map(mapFunnelRow),
                roi_by_entity: roiRes.rows.map(mapRoiRow),
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
//# sourceMappingURL=attribution.js.map