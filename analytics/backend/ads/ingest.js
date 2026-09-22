"use strict";
/**
 * 北极星项目 · 广告归因层 · 单元 2.2 广告数据清洗 + 标准化落库（Node.js + TypeScript + PostgreSQL）
 *
 * 依据：《北极星开发/2-广告归因/2.2-广告数据清洗落库.md》
 *   §3.1/§6.1 五表自然键（ad_accounts / ad_campaigns / ad_adgroups / ad_creatives / ad_performance_daily）+ fx_rates
 *   §3.2    字段映射（Meta/Google → 统一字段）
 *   §3.3    十条清洗规则（去前缀 / 金额换算 / 币种折算 / 日期 UTC / 状态归一 / PII / 来源标记 / 去重）
 *   §5      日期转 UTC（DST 感知，禁止硬编码偏移）
 *   §7      UPSERT 语义（维度表刷新可变列；指标表覆盖指标列；区别于 pt_events 的 append-only）
 *   §7.3    自然键补 workspace_id；idempotency_key 与自然键两层各司其职
 *   §10 待定项 1（workspace_id 进自然键）、2（汇率可插拔）、4（country 不拆）、5（近 3 天回填）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只写我方自己的 ad_* 五表；对 Meta / Google / Ryze 零写操作（无任何 mutate/启停/改预算）。
 *   2. 不编造数据：汇率缺失 → amount_usd/fx_rate/fx_date 置 NULL（记 fx_missing），绝不拍脑袋估汇率。
 *   3. 除数为 0 的比率（ctr/cpm/cpc/roas）→ NULL，不写 0（0 是「没量」与「除零」语义不同）。
 *   4. 全有或全无：结构校验 / 字段映射任一失败 → 整批丢弃并抛错，不落半批（§2 ①②）。
 *   5. country 不拆到 ad 表（§10 待定项 4）；本期无 conversion_value → roas 置 NULL（§3.2）。
 *
 * 输入契约（与单元 2.1 ryze-client.ts 对齐）：
 *   - 2.1 的 client 只返回原始载荷 PullResult.raw（MCP tools/call 的 result 主体：content[] /
 *     structuredContent / 或直接数组/对象）。本文件负责把原始载荷解析成记录、映射成统一字段、
 *     清洗、UPSERT 落库。raw 的精确 JSON 形态随 Ryze server 版本波动，故原始解析层（extractRecords
 *     + map*）是防御式的多路径探测，核心清洗 / UPSERT 接受「统一记录」强类型输入，可独立测试。
 *
 * 依赖注入：pool 由调用方注入（new Pool({ connectionString: DATABASE_URL })），与 collect/ingest.ts 同风格。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestValidationError = void 0;
exports.stripPlatformPrefix = stripPlatformPrefix;
exports.nonNegNumber = nonNegNumber;
exports.nonNegInt = nonNegInt;
exports.microsToUnits = microsToUnits;
exports.normalizeStatus = normalizeStatus;
exports.computeCtr = computeCtr;
exports.computeCpm = computeCpm;
exports.computeCpc = computeCpc;
exports.computeRoas = computeRoas;
exports.isIanaTimezone = isIanaTimezone;
exports.resolveTimezone = resolveTimezone;
exports.toUtcDate = toUtcDate;
exports.scrubPii = scrubPii;
exports.buildIdempotencyKey = buildIdempotencyKey;
exports.normalizeDate = normalizeDate;
exports.extractRecords = extractRecords;
exports.mapAccount = mapAccount;
exports.mapCampaign = mapCampaign;
exports.mapAdgroup = mapAdgroup;
exports.mapCreative = mapCreative;
exports.mapDailyMetric = mapDailyMetric;
exports.resolveFx = resolveFx;
exports.aggregateMetrics = aggregateMetrics;
exports.getLastMetricDate = getLastMetricDate;
exports.advanceMetricCursor = advanceMetricCursor;
exports.computeSyncWindow = computeSyncWindow;
exports.ingestPullResult = ingestPullResult;
exports.ingestDailyMetrics = ingestDailyMetrics;
exports.upsertDailyMetric = upsertDailyMetric;
const node_crypto_1 = require("node:crypto");
// ===========================================================================
// §1 错误类型（全有或全无：映射失败 → 抛错，整批丢弃）
// ===========================================================================
/** 结构校验 / 字段映射失败（§2 ①② → 丢弃整批，不落半批）。 */
class IngestValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "IngestValidationError";
    }
}
exports.IngestValidationError = IngestValidationError;
// ===========================================================================
// §2 清洗原语（纯函数，可独立测试）
// ===========================================================================
/** 去掉平台前缀（§3.3 规则 1）：act_123 → 123；customers/456 → 456；resource_name → 末段。 */
function stripPlatformPrefix(id, platform) {
    const s = id.trim();
    if (platform === "meta") {
        return s.startsWith("act_") ? s.slice(4) : s;
    }
    // google：customers/456 或 customers/456/campaigns/789 → 取最后一段（实体裸 id）
    if (s.includes("/")) {
        const parts = s.split("/").filter(Boolean);
        if (parts.length > 0)
            return parts[parts.length - 1];
    }
    return s;
}
/** 严格有限数；非法/空 → null。 */
function toFiniteNumber(v) {
    if (v === null || v === undefined)
        return null;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}
/** 非负金额（§3.3 规则 3：NULL/负数 → 0）。 */
function nonNegNumber(v) {
    const n = toFiniteNumber(v);
    return n !== null && n >= 0 ? n : 0;
}
/** 非负整数（§3.3 规则 3：NULL/负数 → 0，展示/点击为整数）。 */
function nonNegInt(v) {
    const n = toFiniteNumber(v);
    return n !== null && n >= 0 ? Math.trunc(n) : 0;
}
/** Google cost_micros ÷ 1e6 得本位币（§3.3 规则 2 / §3.2 ①）。 */
function microsToUnits(micros) {
    const n = toFiniteNumber(micros);
    return n !== null && n >= 0 ? n / 1_000_000 : 0;
}
/** 归一化状态枚举（§3.3 规则 6）：无法归一 → 回退 active，原始值存 raw_status 备查。 */
function normalizeStatus(raw, platform) {
    const rawStatus = asStr(raw);
    if (rawStatus === undefined)
        return { status: "active", rawStatus: null };
    const up = rawStatus.toUpperCase().trim();
    const map = platform === "google"
        ? { ENABLED: "active", PAUSED: "paused", REMOVED: "archived" }
        : {
            ACTIVE: "active",
            PAUSED: "paused",
            ARCHIVED: "archived",
            DELETED: "archived",
        };
    return { status: map[up] ?? "active", rawStatus };
}
/** 除数为 0 → NULL（§3.3 规则 3 铁律）。 */
function computeCtr(clicks, impressions) {
    return impressions > 0 && Number.isFinite(clicks) && Number.isFinite(impressions)
        ? clicks / impressions
        : null;
}
function computeCpm(spend, impressions) {
    return impressions > 0 && Number.isFinite(spend) && Number.isFinite(impressions)
        ? (spend * 1000) / impressions
        : null;
}
function computeCpc(spend, clicks) {
    return clicks > 0 && Number.isFinite(spend) && Number.isFinite(clicks)
        ? spend / clicks
        : null;
}
function computeRoas(conversionValue, spend) {
    return spend > 0 && Number.isFinite(conversionValue) && Number.isFinite(spend)
        ? conversionValue / spend
        : null;
}
/** IANA 时区是否可被 Intl 识别（DST 感知换算的前提）。 */
function isIanaTimezone(tz) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 解析账户时区（§5.2）：优先 opts.timezone，缺失回查 ad_accounts.timezone（由调用方传入
 * accountTimezone）；任一缺失/非法 → 回退 UTC 且 missing=true（回退必须记 timezone_missing，
 * 不静默）。注意：显式传入的合法 "UTC" 是「账户本就 UTC」，missing=false，不算回退。
 */
function resolveTimezone(provided, accountTimezone) {
    const tz = (provided !== undefined && provided !== "" ? provided : accountTimezone) ?? undefined;
    if (tz === undefined || tz === "" || !isIanaTimezone(tz)) {
        return { timezone: "UTC", missing: true };
    }
    return { timezone: tz, missing: false };
}
/**
 * 账户本地日 00:00 起点 → 该时刻所落 UTC 日历日（§5.2，DST 感知，禁止硬编码偏移）。
 * 用 Intl.DateTimeFormat(timeZone) 迭代求偏移（Node 内置 full-ICU，等价 date-fns-tz 的
 * zonedTimeToUtc 算法），夏令时切换按「具体日期」取当时偏移，不写死常量。
 * 时区非法 → 回退 UTC（审计记 timezone_missing，由上层判断）。
 */
function toUtcDate(localDate, timezone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate))
        return localDate;
    const tz = isIanaTimezone(timezone) ? timezone : "UTC";
    const [y, m, d] = localDate.split("-").map(Number);
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const wallclock = (ts) => {
        const p = {};
        for (const part of fmt.formatToParts(new Date(ts)))
            p[part.type] = part.value;
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    };
    const target = Date.UTC(y, m - 1, d, 0, 0, 0); // 本地日 00:00 的「墙钟」当作 UTC 毫秒
    let ts = target;
    for (let i = 0; i < 3; i++) {
        const offset = wallclock(ts) - ts; // 本地墙钟 - UTC（毫秒）
        ts = target - offset;
    }
    return new Date(ts).toISOString().slice(0, 10);
}
/** PII 疑似模式（邮箱 / 电话 / 门牌地址，§3.3 规则 7）。命中 → 丢字段 + scrubbed 标记。 */
const PII_PATTERNS = [
    { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    {
        name: "phone",
        re: /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)|\d{2,4})[-.\s]?\d{3,4}[-.\s]?\d{3,4}/,
    },
    {
        name: "address",
        re: /\b\d{1,5}\s+[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff\s,.-]{3,}\b(?:street|st|road|rd|avenue|ave|address|路|街|号)/i,
    },
];
/** PII 剔除：疑似个人线索 → 返回 undefined 并 scrubbed=true，绝不落原始值。 */
function scrubPii(value) {
    const s = asStr(value);
    if (s === undefined)
        return { value: undefined, scrubbed: false };
    for (const p of PII_PATTERNS) {
        if (p.re.test(s))
            return { value: undefined, scrubbed: true };
    }
    return { value: s, scrubbed: false };
}
/** 幂等键：sha256(部分拼接)，确定性、可溯源（§7.3 拉取层）。 */
function buildIdempotencyKey(...parts) {
    return (0, node_crypto_1.createHash)("sha256").update(parts.join("|"), "utf8").digest("hex");
}
/** 数值 → 定点字符串（避免 JS 浮点精度损失，对齐 collect/ingest.ts 的 numeric 风格）。 */
function round6(n) {
    return n.toFixed(6);
}
function round10(n) {
    return n.toFixed(10);
}
/** 严格日期校验 + 归一为 YYYY-MM-DD（§3.3 规则 5）。 */
function normalizeDate(v) {
    const s = asStr(v);
    if (s === undefined)
        throw new IngestValidationError("每日指标记录缺日期");
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
    if (!m)
        throw new IngestValidationError(`非法日期「${s.slice(0, 20)}」`);
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (dt.getUTCFullYear() !== +m[1] ||
        dt.getUTCMonth() !== +m[2] - 1 ||
        dt.getUTCDate() !== +m[3]) {
        throw new IngestValidationError(`非法日期「${s.slice(0, 20)}」`);
    }
    return `${m[1]}-${m[2]}-${m[3]}`;
}
// ===========================================================================
// §3 原始载荷解析（PullResult.raw → 记录数组）
// ===========================================================================
/** 宽松字符串：string / number / boolean 直转；数组取首个可转字符串；其余 undefined。 */
function asStr(v) {
    if (v === null || v === undefined)
        return undefined;
    if (typeof v === "string")
        return v;
    if (Array.isArray(v)) {
        for (const e of v) {
            const s = asStr(e);
            if (s !== undefined)
                return s;
        }
        return undefined;
    }
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    return undefined;
}
/** 是否「记录对象」（非 null、非数组的对象）。 */
function isRecord(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
/** 扫描文本里的 JSON 对象/数组片段（处理 MCP text 块里拼接/夹杂的 JSON）。 */
function scanJsonFragments(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch !== "{" && ch !== "[") {
            i += 1;
            continue;
        }
        const open = ch;
        const close = ch === "{" ? "}" : "]";
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = i;
        for (; j < text.length; j += 1) {
            const c = text[j];
            if (inStr) {
                if (esc)
                    esc = false;
                else if (c === "\\")
                    esc = true;
                else if (c === '"')
                    inStr = false;
                continue;
            }
            if (c === '"') {
                inStr = true;
                continue;
            }
            if (c === open)
                depth += 1;
            else if (c === close) {
                depth -= 1;
                if (depth === 0)
                    break;
            }
        }
        const frag = text.slice(i, j + 1);
        try {
            const v = JSON.parse(frag);
            if (v !== null)
                out.push(v);
        }
        catch {
            /* 非完整 JSON，忽略 */
        }
        i = j + 1;
    }
    return out;
}
/** 从一段文本解析 JSON（优先整段解析，失败则扫描片段）。 */
function parseJsonText(text) {
    const trimmed = text.trim();
    if (trimmed === "")
        return [];
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed))
            return parsed;
        if (isRecord(parsed))
            return [parsed];
        return [];
    }
    catch {
        return scanJsonFragments(trimmed);
    }
}
/** 常见包裹键（数组值 = 记录列表）。 */
const WRAPPER_KEYS = [
    "data",
    "items",
    "rows",
    "results",
    "records",
    "accounts",
    "campaigns",
    "adgroups",
    "creatives",
    "metrics",
];
/** 对象是否「本身就像一条记录」（含可识别 id 字段）。 */
function looksLikeRecord(o) {
    return [
        "account_id",
        "id",
        "resource_name",
        "campaign_id",
        "adgroup_id",
        "adset_id",
        "creative_id",
        "customer_id",
        "date_start",
    ].some((k) => o[k] !== undefined);
}
/**
 * 从 PullResult.raw 提取记录数组（防御式：兼容 content[].text、structuredContent、
 * 直接数组/对象、以及 {data|items|rows|results|accounts|...} 包裹）。
 */
function extractRecords(raw) {
    if (Array.isArray(raw))
        return raw.filter(isRecord);
    if (raw === null || typeof raw !== "object")
        return [];
    const o = raw;
    // ① structuredContent（数组 / 包裹对象 / 单记录）
    if (o.structuredContent !== undefined) {
        return extractRecords(o.structuredContent);
    }
    // ② content[].text 里的 JSON
    if (Array.isArray(o.content)) {
        const out = [];
        for (const block of o.content) {
            if (isRecord(block) && typeof block.text === "string") {
                out.push(...parseJsonText(block.text));
            }
        }
        if (out.length > 0)
            return out.filter(isRecord);
    }
    // ③ 直接记录（含 id 字段）优先
    if (looksLikeRecord(o))
        return [o];
    // ④ 常见包裹键（数组值 = 记录列表；空数组 → 「该类别无数据」，非异常）
    for (const key of WRAPPER_KEYS) {
        const v = o[key];
        if (Array.isArray(v))
            return v.filter(isRecord);
    }
    // ⑤ 兜底：无 id 的裸对象当作单条记录（后续 map* 若缺必填字段会抛错，符合全有或全无）
    if (Object.keys(o).length === 0)
        return [];
    return [o];
}
/** 多路径取字段（点路径下钻），取首个非空值。 */
function pick(rec, ...paths) {
    for (const p of paths) {
        let cur = rec;
        for (const seg of p.split(".")) {
            if (cur === null || typeof cur !== "object") {
                cur = undefined;
                break;
            }
            cur = cur[seg];
        }
        if (cur !== undefined && cur !== null && cur !== "")
            return cur;
    }
    return undefined;
}
// ===========================================================================
// §4 字段映射（Meta / Google 原始字段 → 统一记录，§3.2）
// ===========================================================================
/** 解析账户裸 id：优先记录内，缺失回退 ctx（§3.2 account_id）。 */
function resolveAccountId(rec, platform, fallback) {
    const raw = pick(rec, "account_id", "customer_id", "customer.id", "account.id", "id");
    if (raw !== undefined)
        return stripPlatformPrefix(asStr(raw), platform);
    if (fallback)
        return fallback;
    throw new IngestValidationError("记录缺 account id");
}
/** 可选实体 id（缺失返回 null；不编造）。 */
function optionalId(rec, platform, ...paths) {
    const v = pick(rec, ...paths);
    if (v === undefined)
        return null;
    return stripPlatformPrefix(asStr(v), platform);
}
/** 必填实体 id（缺失抛错，§2 全有或全无）。 */
function requiredId(rec, platform, label, ...paths) {
    const v = pick(rec, ...paths);
    if (v === undefined)
        throw new IngestValidationError(`${label} 记录缺 id`);
    return stripPlatformPrefix(asStr(v), platform);
}
function mapAccount(rec, platform) {
    const accountId = requiredId(rec, platform, "account", "account_id", "id", "resource_name", "customer.id", "customer_id");
    const currency = asStr(pick(rec, "currency", "account_currency", "currency_code", "customer.currency_code"));
    if (currency === undefined) {
        throw new IngestValidationError("account 记录缺币种 currency");
    }
    const timezone = asStr(pick(rec, "timezone", "timezone_name", "time_zone")) ?? "UTC";
    const st = normalizeStatus(pick(rec, "status", "account_status"), platform);
    return {
        accountId,
        name: asStr(pick(rec, "name", "account_name", "descriptive_name")) ?? null,
        currency: currency.toUpperCase(),
        timezone,
        status: st.status,
        rawStatus: st.rawStatus,
    };
}
function mapCampaign(rec, platform, accountId) {
    const accId = resolveAccountId(rec, platform, accountId);
    const campaignId = requiredId(rec, platform, "campaign", "campaign_id", "id", "campaign.id");
    const st = normalizeStatus(pick(rec, "status", "campaign.status"), platform);
    return {
        accountId: accId,
        campaignId,
        name: asStr(pick(rec, "name", "campaign.name")) ?? null,
        status: st.status,
        rawStatus: st.rawStatus,
        objective: asStr(pick(rec, "objective", "campaign.objective", "advertising_channel_type")) ?? null,
    };
}
function mapAdgroup(rec, platform, accountId) {
    const accId = resolveAccountId(rec, platform, accountId);
    const adgroupId = requiredId(rec, platform, "adgroup", "adgroup_id", "adset_id", "ad_group_id", "id", "ad_group.id");
    const campaignId = requiredId(rec, platform, "adgroup.campaign", "campaign_id", "campaign.id", "campaign", "ad_group.campaign");
    const st = normalizeStatus(pick(rec, "status", "adset.status", "ad_group.status"), platform);
    return {
        accountId: accId,
        campaignId,
        adgroupId,
        level: platform === "meta" ? "adset" : "adgroup",
        name: asStr(pick(rec, "name", "adset.name", "ad_group.name")) ?? null,
        status: st.status,
        rawStatus: st.rawStatus,
    };
}
function mapCreative(rec, platform, accountId) {
    const accId = resolveAccountId(rec, platform, accountId);
    const creativeId = requiredId(rec, platform, "creative", "creative_id", "creative.id", "id", "ad_group_ad.ad.id", "ad_id", "asset_id");
    const st = normalizeStatus(pick(rec, "status", "creative.status", "ad_group_ad.status"), platform);
    const fields = [
        ["name", pick(rec, "name", "creative.name", "ad_group_ad.ad.name", "asset_name")],
        ["title", pick(rec, "title", "headline", "object_story_spec.title")],
        ["body", pick(rec, "body", "description", "object_story_spec.link_data.message")],
        ["image_url", pick(rec, "image_url", "thumbnail_url", "image_asset", "object_story_spec.link_data.image_url")],
        ["video_url", pick(rec, "video_url", "youtube_video_asset")],
        ["link", pick(rec, "link", "link_url", "final_urls", "ad_group_ad.ad.final_urls", "object_story_spec.link_data.link")],
    ];
    const cleaned = {};
    const scrubbed = [];
    for (const [field, raw] of fields) {
        const r = scrubPii(raw);
        if (r.scrubbed)
            scrubbed.push(field);
        cleaned[field] = r.value ?? null;
    }
    return {
        accountId: accId,
        creativeId,
        campaignId: optionalId(rec, platform, "campaign_id", "campaign.id", "campaign"),
        adgroupId: optionalId(rec, platform, "adgroup_id", "adset_id", "ad_group_id", "ad_group.id", "ad_group"),
        name: cleaned.name,
        title: cleaned.title,
        body: cleaned.body,
        imageUrl: cleaned.image_url,
        videoUrl: cleaned.video_url,
        link: cleaned.link,
        status: st.status,
        rawStatus: st.rawStatus,
        scrubbed,
    };
}
/** Meta actions[] 里 conversion/omni 类 action 的 value 求和（§3.2 ③）。 */
function sumMetaConversions(actions) {
    if (!Array.isArray(actions))
        return 0;
    let sum = 0;
    for (const a of actions) {
        if (!isRecord(a))
            continue;
        const type = asStr(a.action_type) ?? "";
        if (/(conversion|omni|offsite)/i.test(type)) {
            sum += nonNegNumber(a.value);
        }
    }
    return sum;
}
/** 按层级解析每日指标的实体 id。 */
function resolveEntityId(rec, platform, level, fallback) {
    if (level === "account")
        return resolveAccountId(rec, platform, fallback);
    const paths = level === "campaign"
        ? ["campaign_id", "campaign.id", "campaign"]
        : level === "adgroup"
            ? ["adgroup_id", "adset_id", "ad_group_id", "ad_group.id", "ad_group"]
            : ["creative_id", "creative.id", "ad_id", "ad_group_ad.ad.id", "asset_id"];
    const v = pick(rec, ...paths);
    if (v !== undefined)
        return stripPlatformPrefix(asStr(v), platform);
    if (fallback)
        return fallback;
    throw new IngestValidationError(`每日指标记录缺 ${level} 实体 id`);
}
function mapDailyMetric(rec, platform, ctx) {
    const level = ctx.level ?? "account";
    const entityId = resolveEntityId(rec, platform, level, ctx.entityId ?? (level === "account" ? ctx.accountId : undefined));
    const localDate = normalizeDate(pick(rec, "date_start", "segments.date", "date", "day"));
    const currencyRaw = asStr(pick(rec, "account_currency", "currency", "customer.currency_code", "currency_code"));
    const currency = (currencyRaw ?? ctx.currency)?.toUpperCase();
    if (currency === undefined || currency === "") {
        throw new IngestValidationError("每日指标记录缺币种（且无账户币种兜底）");
    }
    const spend = platform === "google"
        ? microsToUnits(pick(rec, "metrics.cost_micros", "cost_micros", "costMicros"))
        : nonNegNumber(pick(rec, "spend", "metrics.cost", "cost"));
    const impressions = nonNegInt(pick(rec, "impressions", "metrics.impressions"));
    const clicks = nonNegInt(pick(rec, "clicks", "metrics.clicks"));
    const conversions = platform === "google"
        ? nonNegNumber(pick(rec, "conversions", "metrics.conversions"))
        : sumMetaConversions(pick(rec, "actions", "insights.actions"));
    return { entityId, level, localDate, spend, impressions, clicks, conversions, currency };
}
// ===========================================================================
// §5 币种折算（fx_rates 快照，§4）
// ===========================================================================
/** 查当日汇率快照（currency → USD）。USD 返回 identity；缺快照返回 null（不编造）。 */
async function resolveFx(pool, currency, fxDate) {
    const cur = currency.toUpperCase();
    if (cur === "USD")
        return { rate: null, date: null }; // 由 build 层按 identity 处理
    const res = await pool.query(`SELECT rate::text AS rate FROM fx_rates
      WHERE currency = $1 AND base = 'USD' AND fx_date = $2::date
      LIMIT 1`, [cur, fxDate]);
    if (res.rows.length === 0)
        return { rate: null, date: null };
    return { rate: String(res.rows[0].rate), date: fxDate };
}
/** 同 (entityId, level, localDate) 折叠 SUM（§7.1）；currency 取组内首个（同账户应一致）。 */
function aggregateMetrics(metrics) {
    const map = new Map();
    for (const m of metrics) {
        const key = `${m.entityId}\u0000${m.level}\u0000${m.localDate}`;
        const g = map.get(key);
        if (!g) {
            map.set(key, { ...m });
        }
        else {
            g.spend += m.spend;
            g.impressions += m.impressions;
            g.clicks += m.clicks;
            g.conversions += m.conversions;
        }
    }
    return [...map.values()];
}
/** 聚合组 → 落库行（UTC 转换 + 派生指标重算 + 币种折算，§7.1 / §5 / §4）。 */
function buildDailyMetricRow(group, workspaceId, platform, accountId, timezone, timezoneMissing, fx, dataSource, idempotencyKey) {
    const date = toUtcDate(group.localDate, timezone);
    const spend = round6(group.spend);
    const ctr = computeCtr(group.clicks, group.impressions);
    const cpm = computeCpm(group.spend, group.impressions);
    const cpc = computeCpc(group.spend, group.clicks);
    const roas = null; // 本期无 conversion_value（§3.2 ① roas 行：不编造）
    let amountUsd;
    let fxRate;
    let fxDate;
    let fxMissing = false;
    if (group.currency === "USD") {
        amountUsd = spend;
        fxRate = null;
        fxDate = null;
    }
    else if (fx.rate !== null) {
        amountUsd = round6(group.spend * Number(fx.rate));
        fxRate = fx.rate;
        fxDate = fx.date;
    }
    else {
        amountUsd = null;
        fxRate = null;
        fxDate = null;
        fxMissing = true;
    }
    const row = {
        workspaceId,
        platform,
        accountId,
        entityId: group.entityId,
        level: group.level,
        date,
        localDate: group.localDate,
        spend,
        impressions: group.impressions,
        clicks: group.clicks,
        conversions: round6(group.conversions),
        ctr: ctr === null ? null : round6(ctr),
        cpm: cpm === null ? null : round6(cpm),
        cpc: cpc === null ? null : round6(cpc),
        roas,
        currency: group.currency,
        amountUsd,
        fxRate,
        fxDate,
        dataSource,
        // §7.3：优先编排层传入的「请求级」幂等键（溯源本轮拉取）；缺省降级为「行级备用键」（自然键哈希，仅兜底去重，非请求级溯源）
        idempotencyKey: idempotencyKey ??
            buildIdempotencyKey(workspaceId, platform, accountId, group.entityId, group.level, date),
    };
    return { row, fxMissing, timezoneMissing };
}
// ===========================================================================
// §7 UPSERT（§6.1 自然键 + §7.2 语义；只写 ad_* 五表）
// ===========================================================================
/** 事务包装（全有或全无：任一步失败回滚，§2）。 */
async function withTx(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        try {
            const r = await fn(client);
            await client.query("COMMIT");
            return r;
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
async function upsertAccount(client, workspaceId, platform, acc, dataSource) {
    await client.query(`INSERT INTO ad_accounts
       (workspace_id, platform, account_id, name, currency, timezone, status, raw_status, data_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, platform, account_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       currency = EXCLUDED.currency,
       timezone = EXCLUDED.timezone,
       status = EXCLUDED.status,
       raw_status = EXCLUDED.raw_status,
       updated_at = now()`, [
        workspaceId,
        platform,
        acc.accountId,
        acc.name,
        acc.currency,
        acc.timezone,
        acc.status,
        acc.rawStatus,
        dataSource,
    ]);
}
async function upsertCampaign(client, workspaceId, platform, c, dataSource) {
    await client.query(`INSERT INTO ad_campaigns
       (workspace_id, platform, account_id, campaign_id, name, status, raw_status, objective, data_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, platform, account_id, campaign_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       raw_status = EXCLUDED.raw_status,
       objective = EXCLUDED.objective,
       updated_at = now()`, [
        workspaceId,
        platform,
        c.accountId,
        c.campaignId,
        c.name,
        c.status,
        c.rawStatus,
        c.objective,
        dataSource,
    ]);
}
async function upsertAdgroup(client, workspaceId, platform, a, dataSource) {
    await client.query(`INSERT INTO ad_adgroups
       (workspace_id, platform, account_id, campaign_id, adgroup_id, level, name, status, raw_status, data_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id, platform, account_id, adgroup_id)
     DO UPDATE SET
       campaign_id = EXCLUDED.campaign_id,
       level = EXCLUDED.level,
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       raw_status = EXCLUDED.raw_status,
       updated_at = now()`, [
        workspaceId,
        platform,
        a.accountId,
        a.campaignId,
        a.adgroupId,
        a.level,
        a.name,
        a.status,
        a.rawStatus,
        dataSource,
    ]);
}
async function upsertCreative(client, workspaceId, platform, c, dataSource) {
    await client.query(`INSERT INTO ad_creatives
       (workspace_id, platform, account_id, creative_id, campaign_id, adgroup_id,
        name, title, body, image_url, video_url, link, status, raw_status, data_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (workspace_id, platform, account_id, creative_id)
     DO UPDATE SET
       campaign_id = EXCLUDED.campaign_id,
       adgroup_id = EXCLUDED.adgroup_id,
       name = EXCLUDED.name,
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       image_url = EXCLUDED.image_url,
       video_url = EXCLUDED.video_url,
       link = EXCLUDED.link,
       status = EXCLUDED.status,
       raw_status = EXCLUDED.raw_status,
       updated_at = now()`, [
        workspaceId,
        platform,
        c.accountId,
        c.creativeId,
        c.campaignId,
        c.adgroupId,
        c.name,
        c.title,
        c.body,
        c.imageUrl,
        c.videoUrl,
        c.link,
        c.status,
        c.rawStatus,
        dataSource,
    ]);
}
async function upsertDailyMetric(client, row) {
    await client.query(`INSERT INTO ad_performance_daily
       (workspace_id, platform, account_id, entity_id, level, date, local_date,
        spend, impressions, clicks, conversions, ctr, cpm, cpc, roas,
        currency, amount_usd, fx_rate, fx_date, data_source, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (workspace_id, platform, account_id, entity_id, level, date)
     DO UPDATE SET
       spend = EXCLUDED.spend,
       impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       conversions = EXCLUDED.conversions,
       ctr = EXCLUDED.ctr,
       cpm = EXCLUDED.cpm,
       cpc = EXCLUDED.cpc,
       roas = EXCLUDED.roas,
       currency = EXCLUDED.currency,
       amount_usd = EXCLUDED.amount_usd,
       fx_rate = EXCLUDED.fx_rate,
       fx_date = EXCLUDED.fx_date,
       local_date = EXCLUDED.local_date,
       idempotency_key = EXCLUDED.idempotency_key,
       updated_at = now()`, [
        row.workspaceId,
        row.platform,
        row.accountId,
        row.entityId,
        row.level,
        row.date,
        row.localDate,
        row.spend,
        row.impressions,
        row.clicks,
        row.conversions,
        row.ctr,
        row.cpm,
        row.cpc,
        row.roas,
        row.currency,
        row.amountUsd,
        row.fxRate,
        row.fxDate,
        row.dataSource,
        row.idempotencyKey,
    ]);
}
// ===========================================================================
// §8 增量游标 + 近 3 天回填窗口（§10 待定项 5 / §5.3）
// ===========================================================================
/** 回查账户上下文（timezone / currency），供时区与币种兜底（§5.2：时区取自 ad_accounts.timezone）。 */
async function loadAccountContext(pool, workspaceId, platform, accountId) {
    const res = await pool.query(`SELECT timezone, currency FROM ad_accounts
      WHERE workspace_id = $1 AND platform = $2 AND account_id = $3`, [workspaceId, platform, accountId]);
    const r = res.rows[0];
    return {
        timezone: typeof r?.timezone === "string" ? r.timezone : null,
        currency: typeof r?.currency === "string" ? r.currency : null,
    };
}
/** 读增量游标（ad_accounts.last_metric_date，UTC 日，未同步过为 null）。 */
async function getLastMetricDate(pool, workspaceId, platform, accountId) {
    const res = await pool.query(`SELECT last_metric_date::text AS d FROM ad_accounts
      WHERE workspace_id = $1 AND platform = $2 AND account_id = $3`, [workspaceId, platform, accountId]);
    const d = res.rows[0]?.d;
    return typeof d === "string" ? d : null;
}
/** 前移游标（GREATEST 保证单调不回退：回填的旧日不会把游标拉低）。 */
async function advanceMetricCursor(client, workspaceId, platform, accountId, date) {
    await client.query(`UPDATE ad_accounts
       SET last_metric_date = GREATEST(COALESCE(last_metric_date, $4::date), $4::date), updated_at = now()
      WHERE workspace_id = $1 AND platform = $2 AND account_id = $3`, [workspaceId, platform, accountId, date]);
}
function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/**
 * 计算本轮的指标拉取窗口（§5.3 增量游标 + §10 待定项 5 近 3 天回填）。
 * - 增量：lastMetricDate == null → 首次全量回填 initialDays（默认 90 天，2.1 §5.3）；
 *         否则从 lastMetricDate + 1 天开始。
 * - 回填：每次额外回补最近 backfillDays（默认 3）天，UPSERT 覆盖修正（平台延迟）。
 * - 说明：设计 §10 写「[date-3, date]」（含端点即 4 天）；此处按「近 N 天 = N 个自然日」
 *   实现（[today-(N-1), today]）。如需对齐字面，把 backfillDays 设 4 即可。
 */
function computeSyncWindow(lastMetricDate, todayUtc, opts) {
    const { backfillDays = 3, initialDays = 90 } = opts ?? {};
    const today = todayUtc;
    const incrementalStart = lastMetricDate
        ? addDays(lastMetricDate, 1)
        : addDays(today, -(initialDays - 1));
    const backfillStart = addDays(today, -(backfillDays - 1));
    // 合并 [incrementalStart, today] 与 [backfillStart, today] 为不重叠连续区间
    const start = incrementalStart < backfillStart ? incrementalStart : backfillStart;
    const ranges = [];
    if (start <= today) {
        ranges.push({ start, end: today });
    }
    return { ranges, incrementalStart, backfillStart, today };
}
/**
 * 按类别分发：解析 raw → 映射统一记录（全有或全无，任一失败整批抛错）→ 事务 UPSERT。
 * 只写 ad_* 五表（§8.1 只读铁律：对广告平台零写）。
 */
async function ingestPullResult(pool, workspaceId, platform, pull, opts = {}) {
    const logger = opts.logger ?? console;
    const dataSource = pull.dataSource ?? "ryze";
    const records = extractRecords(pull.raw).filter(isRecord);
    const base = {
        category: pull.category,
        extracted: records.length,
        mapped: 0,
        upserted: 0,
        fxMissing: 0,
        timezoneMissing: 0,
        scrubbed: [],
    };
    switch (pull.category) {
        case "account": {
            const accounts = records.map((r) => mapAccount(r, platform)); // 抛错 = 整批丢弃
            await withTx(pool, async (c) => {
                for (const a of accounts)
                    await upsertAccount(c, workspaceId, platform, a, dataSource);
            });
            return { ...base, mapped: accounts.length, upserted: accounts.length };
        }
        case "campaign": {
            const campaigns = records.map((r) => mapCampaign(r, platform, opts.accountId));
            await withTx(pool, async (c) => {
                for (const x of campaigns)
                    await upsertCampaign(c, workspaceId, platform, x, dataSource);
            });
            return { ...base, mapped: campaigns.length, upserted: campaigns.length };
        }
        case "adgroup": {
            const adgroups = records.map((r) => mapAdgroup(r, platform, opts.accountId));
            await withTx(pool, async (c) => {
                for (const x of adgroups)
                    await upsertAdgroup(c, workspaceId, platform, x, dataSource);
            });
            return { ...base, mapped: adgroups.length, upserted: adgroups.length };
        }
        case "creative": {
            const creatives = records.map((r) => mapCreative(r, platform, opts.accountId));
            await withTx(pool, async (c) => {
                for (const x of creatives)
                    await upsertCreative(c, workspaceId, platform, x, dataSource);
            });
            const scrubbed = [...new Set(creatives.flatMap((x) => x.scrubbed))];
            if (scrubbed.length > 0)
                logger.warn({ scrubbed }, "PII scrubbed fields");
            return { ...base, mapped: creatives.length, upserted: creatives.length, scrubbed };
        }
        case "daily_metric": {
            const accountId = opts.accountId;
            if (accountId === undefined || accountId === "") {
                throw new IngestValidationError("daily_metric 类别需提供 opts.accountId");
            }
            // 币种兜底：记录缺币种且未显式传入时，回查 ad_accounts.currency（账户已知币种，非编造）
            let currency = opts.currency;
            if (currency === undefined || currency === "") {
                const acct = await loadAccountContext(pool, workspaceId, platform, accountId);
                if (acct.currency !== null)
                    currency = acct.currency;
            }
            const ctx = {
                accountId,
                level: opts.level ?? "account",
                entityId: opts.entityId,
                currency,
            };
            const metrics = records.map((r) => mapDailyMetric(r, platform, ctx)); // 抛错 = 整批丢弃
            const res = await ingestDailyMetrics(pool, workspaceId, platform, metrics, {
                accountId,
                timezone: opts.timezone, // 缺失时由 ingestDailyMetrics 回查 ad_accounts.timezone（§5.2）
                dataSource,
                idempotencyKey: opts.idempotencyKey,
                logger,
            });
            return { ...base, mapped: metrics.length, ...res };
        }
        default:
            throw new IngestValidationError(`未知数据类别 ${String(pull.category)}`);
    }
}
/**
 * 每日指标落库：聚合 → 币种折算 → UTC → UPSERT → 前移游标（同一事务，原子）。
 * 幂等：重跑同自然键覆盖，不重复；游标 GREATEST 单调不回退。
 */
async function ingestDailyMetrics(pool, workspaceId, platform, metrics, opts) {
    const dataSource = opts.dataSource ?? "ryze";
    const logger = opts.logger ?? console;
    // 时区解析（§5.2）：opts.timezone 缺失 → 回查 ad_accounts.timezone；回退 UTC 必记 timezone_missing
    const providedTz = opts.timezone;
    const accountTz = providedTz !== undefined && providedTz !== ""
        ? null
        : (await loadAccountContext(pool, workspaceId, platform, opts.accountId)).timezone;
    const tz = resolveTimezone(providedTz, accountTz);
    const timezone = tz.timezone;
    const timezoneMissing = tz.missing;
    if (timezoneMissing) {
        logger.warn({ accountId: opts.accountId, timezone }, "timezone_missing (fallback UTC)");
    }
    const groups = aggregateMetrics(metrics);
    // 预先查汇率（只对非 USD 币种，按 group.localDate 快照日）
    const fxCache = new Map();
    for (const g of groups) {
        if (g.currency === "USD")
            continue;
        const key = `${g.currency}\u0000${g.localDate}`;
        if (!fxCache.has(key)) {
            const fx = await resolveFx(pool, g.currency, g.localDate);
            fxCache.set(key, fx);
            if (fx.rate === null) {
                logger.warn({ currency: g.currency, date: g.localDate }, "fx_missing");
            }
        }
    }
    const built = groups.map((g) => {
        const fx = g.currency === "USD"
            ? { rate: null, date: null }
            : fxCache.get(`${g.currency}\u0000${g.localDate}`) ?? { rate: null, date: null };
        return buildDailyMetricRow(g, workspaceId, platform, opts.accountId, timezone, timezoneMissing, fx, dataSource, opts.idempotencyKey);
    });
    const maxDate = built.reduce((m, b) => (m === null || b.row.date > m ? b.row.date : m), null);
    await withTx(pool, async (client) => {
        for (const b of built)
            await upsertDailyMetric(client, b.row);
        if (maxDate !== null) {
            await advanceMetricCursor(client, workspaceId, platform, opts.accountId, maxDate);
        }
    });
    return {
        upserted: built.length,
        fxMissing: built.filter((b) => b.fxMissing).length,
        timezoneMissing: built.filter((b) => b.timezoneMissing).length,
    };
}
//# sourceMappingURL=ingest.js.map