"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.4 事件查询 API —— GET /api/analytics/events
 *
 * 依据：《北极星开发/1-数据接入/1.4-事件查询API-fixed5.md》
 *   §1.1 路径与方法（GET，只读，Authorization: Bearer <只读 token>）
 *   §1.2 查询参数（全部可选；tenant_id 绝不从参数读，只由 token 派生）
 *   §1.3 返回体（items / next_cursor / has_more / count）
 *   §1.4 错误码（401 无法识别 / 403 已识别但无权 / 400 参数非法）
 *   §2.1 seq 全局单调序号（序列名 pt_events_seq，DB 分配，无重启回退）
 *   §2.2 筛选 → SQL（显式列清单，不含 tenant_id；seq > $since 单列 keyset）
 *   §3   seq 单列 keyset 游标（WHERE seq > since ORDER BY seq，不漏不重）
 *   §4   只读 token 鉴权（读写 key / webhook Secret 一律 403，非 401）
 *   §6   查询侧多租户隔离（SET LOCAL app.current_tenant_id + 显式 WHERE tenant_id 双保险）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只读：全文件只有 SELECT，无 INSERT / UPDATE / DELETE。
 *   2. tenant_id 只从 token 反查结果派生，绝不读查询参数 / 请求头里的任何租户字段。
 *   3. 运行时永不 DISABLE RLS（只有一次性迁移脚本允许，fixed5 §2.1 纪律）。
 *   4. 不返回 tenant_id / 完整 Key / 原始 IP（表内本无，序列化白名单再兜底）。
 *   5. seq 游标严格 `seq > since`（严格大于），ORDER BY seq ASC，单列，不重不漏。
 *
 * 依赖注入（对齐 collect/server.ts、collect/ingest.ts 风格，后端可换）：
 *   - pool：pg 连接池（调用方 new Pool({ connectionString: DATABASE_URL }) 注入）。
 *   - verifyAnalyticsToken：只反查「只读分析 token」签发表，与 1.2/1.3 的
 *     webhook Secret / 读写 key 反查完全独立；返回 null 表示「不是只读 token」→ 403。
 * 本文件提供 buildQueryServer（核心）+ createInMemoryTokenVerifier（测试兜底）
 * + startQueryServer（可运行入口）。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInMemoryTokenVerifier = createInMemoryTokenVerifier;
exports.serializeEventRow = serializeEventRow;
exports.parseEventFilters = parseEventFilters;
exports.queryEventsScoped = queryEventsScoped;
exports.parseAuthorization = parseAuthorization;
exports.buildQueryServer = buildQueryServer;
exports.startQueryServer = startQueryServer;
const fastify_1 = __importDefault(require("fastify"));
const validate_1 = require("../collect/validate");
/**
 * 内存只读 token 反查（测试兜底）。生产替换为「只读分析 token 签发表」反查，
 * 返回同样的 AnalyticsAuth。查不到（读写 key / Secret 混用）→ null。
 */
function createInMemoryTokenVerifier(records) {
    const byToken = new Map(records.map((r) => [
        r.token,
        { tenant_id: r.tenant_id, scopes: r.scopes, expires_at: r.expires_at },
    ]));
    return (token) => byToken.get(token) ?? null;
}
// ---------------------------------------------------------------------------
// 字段白名单 + 序列化（fixed5 §2.2 / §5）
// ---------------------------------------------------------------------------
/**
 * SELECT 显式列清单（fixed5 §2.2，逐字对齐，顺序不变）。
 * 不含 tenant_id（§5 最小暴露）；seq 返回（不敏感，用于对齐游标锚点）。
 */
const SELECT_COLUMNS = [
    "seq",
    "event_id",
    "event_name",
    "timestamp",
    "visitor_id",
    "user_id",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "click_id",
    "country",
    "region",
    "user_agent",
    "device_type",
    "os",
    "browser",
    "page_url",
    "referrer",
    "page_path",
    "page_title",
    "session_id",
    "dwell_time_ms",
    "registration_method",
    "email_verified",
    "key_id_prefix",
    "key_id_hash",
    "create_page",
    "key_type",
    "model",
    "source",
    "caller",
    "request_time",
    "response_time",
    "latency_ms",
    "success",
    "http_status",
    "error_code",
    "request_id",
    "response_id",
    "provider",
    "endpoint",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cost",
    "recharge_id",
    "amount",
    "currency",
    "payment_method",
    "status",
    "enabled",
];
/** pg 把 int8(BIGINT) 返回为字符串，这些列需转 number 对齐 fixed5 §8.2 示例。 */
const BIGINT_COLUMNS = new Set([
    "seq",
    "timestamp",
    "dwell_time_ms",
    "request_time",
    "response_time",
    "latency_ms",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
]);
/** pg 把 numeric 返回为字符串，这些列转 number 对齐 fixed5 §8.2 示例（cost/amount）。 */
const NUMERIC_COLUMNS = new Set(["cost", "amount"]);
/**
 * 逐字段白名单序列化（fixed5 §5.2）：只输出 SELECT_COLUMNS 里的列，
 * 任何多余字段（未来误加列、tenant_id 等）都不会被带出。
 * BIGINT / NUMERIC 转 number；其余（TEXT/UUID/CHAR/BOOLEAN/INTEGER）原样透传。
 */
function serializeEventRow(row) {
    const out = {};
    for (const col of SELECT_COLUMNS) {
        const v = row[col];
        if (v === null || v === undefined) {
            out[col] = null;
        }
        else if (BIGINT_COLUMNS.has(col) || NUMERIC_COLUMNS.has(col)) {
            out[col] = typeof v === "string" ? Number(v) : v;
        }
        else {
            out[col] = v;
        }
    }
    return out;
}
/** 默认每批条数（fixed5 §1.2）。 */
const DEFAULT_LIMIT = 100;
/** 每批条数上限（fixed5 §1.2：超上限截断，不报错）。 */
const MAX_LIMIT = 500;
/** int64 上限十进制串（校验 since 不溢出 bigint）。 */
const BIGINT_MAX = "9223372036854775807";
/** 是否合法非负整数（十进制，无符号/空格/小数）。 */
function isNonNegativeInt(s) {
    return /^\d+$/.test(s);
}
/** 是否落在 int64 范围（since 以字符串传给 ::bigint，须防越界触发 SQL 22003）。 */
function isBigintString(s) {
    if (!/^\d+$/.test(s))
        return false;
    const t = s.replace(/^0+/, "") || "0";
    return (t.length < BIGINT_MAX.length ||
        (t.length === BIGINT_MAX.length && t <= BIGINT_MAX));
}
/**
 * 解析并校验查询参数（fixed5 §1.2 / §1.4 / §2.3 前置校验）。
 * - from/to：非负整数 epoch 毫秒；from > to → 400。
 * - limit：非负整数；<=0 → 400；>500 → 截断 500（不报错）。
 * - since：合法非负整数（seq 十进制）；非法 → 400。
 * - 文本类：空串视同不传（不过滤）；event_name 支持逗号分隔多值 → = ANY(...)。
 * 注意：本函数绝不读取 / 使用任何 tenant_id 入参（fixed5 §4.2 ⑥）。
 */
function parseEventFilters(query) {
    const q = (query ?? {});
    const get = (key) => {
        const v = q[key];
        if (typeof v === "string")
            return v;
        if (Array.isArray(v) && typeof v[0] === "string")
            return v[0];
        return undefined;
    };
    // from / to：事件发生时间（epoch 毫秒）
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
    // limit
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
    // since：seq 游标（不透明十进制字符串，只透传、不解析）
    let since = null;
    const sinceRaw = get("since");
    if (sinceRaw !== undefined) {
        if (!isBigintString(sinceRaw)) {
            return { ok: false, message: "since 需为合法非负整数（seq）" };
        }
        since = sinceRaw;
    }
    // 文本精确匹配：空串视同不传（不过滤）
    const strOrNull = (raw) => raw !== undefined && raw.length > 0 ? raw : null;
    // event_name：逗号分隔多值（fixed5 §1.2，visit,signup → = ANY(...)）
    let eventNames = null;
    const eventNamesRaw = get("event_name");
    if (eventNamesRaw !== undefined) {
        const list = eventNamesRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (list.length > 0)
            eventNames = list;
    }
    const filters = {
        from,
        to,
        utm_source: strOrNull(get("utm_source")),
        utm_campaign: strOrNull(get("utm_campaign")),
        utm_content: strOrNull(get("utm_content")),
        country: strOrNull(get("country")),
        event_names: eventNames,
        source: strOrNull(get("source")),
        model: strOrNull(get("model")),
        limit,
        since,
    };
    return { ok: true, filters };
}
// ---------------------------------------------------------------------------
// SQL 组装（fixed5 §2.2 筛选 → SQL 映射）
// ---------------------------------------------------------------------------
/**
 * 由筛选条件构建参数化 SELECT（fixed5 §2.2）。
 * - 列名来自 SELECT_COLUMNS 固定白名单（非用户输入，无注入风险）。
 * - tenant_id 显式 ::uuid 双保险（§6 第一层应用层隔离）。
 * - seq > $since::bigint 单列 keyset（§3.2），ORDER BY seq ASC，LIMIT $limit+1 多取 1 条判 has_more。
 * - since 以字符串传给 ::bigint，避免 JS number 精度损失，游标严格精确。
 */
function buildSelectSql(tenantId, f) {
    const conditions = [];
    const values = [];
    values.push(tenantId);
    conditions.push(`tenant_id = $${values.length}::uuid`);
    if (f.from !== null) {
        values.push(f.from);
        conditions.push(`timestamp >= $${values.length}`);
    }
    if (f.to !== null) {
        values.push(f.to);
        conditions.push(`timestamp <= $${values.length}`);
    }
    if (f.utm_source !== null) {
        values.push(f.utm_source);
        conditions.push(`utm_source = $${values.length}`);
    }
    if (f.utm_campaign !== null) {
        values.push(f.utm_campaign);
        conditions.push(`utm_campaign = $${values.length}`);
    }
    if (f.utm_content !== null) {
        values.push(f.utm_content);
        conditions.push(`utm_content = $${values.length}`);
    }
    if (f.country !== null) {
        values.push(f.country);
        conditions.push(`country = $${values.length}`);
    }
    if (f.event_names !== null) {
        values.push(f.event_names);
        conditions.push(`event_name = ANY($${values.length}::text[])`);
    }
    if (f.source !== null) {
        values.push(f.source);
        conditions.push(`source = $${values.length}`);
    }
    if (f.model !== null) {
        values.push(f.model);
        conditions.push(`model = $${values.length}`);
    }
    if (f.since !== null) {
        values.push(f.since);
        conditions.push(`seq > $${values.length}::bigint`);
    }
    values.push(f.limit + 1); // 多取 1 条判 has_more（§1.3）
    const sql = `SELECT ${SELECT_COLUMNS.join(", ")} ` +
        `FROM pt_events ` +
        `WHERE ${conditions.join(" AND ")} ` +
        `ORDER BY seq ASC ` +
        `LIMIT $${values.length}`;
    return { sql, values };
}
// ---------------------------------------------------------------------------
// 查询核心（fixed5 §6：SET LOCAL 租户上下文 + RLS + 显式 WHERE 双保险）
// ---------------------------------------------------------------------------
/**
 * 在「租户上下文 + RLS」下执行只读查询（fixed5 §6，复用 1.3 §4.2 隔离入口）。
 * 事务内：
 *   1. SELECT set_config('app.current_tenant_id', $1, true) —— 等价于 SET LOCAL，
 *      事务内生效、结束自动复位；tenant 只取鉴权派生的 tenantId，绝不读入参。
 *   2. SELECT … WHERE tenant_id = $1::uuid …（显式 WHERE 双保险第一层）。
 * RLS 第二层（FORCE ROW LEVEL SECURITY + tenant_isolation 策略）兜底：若漏设
 * 上下文则 tenant_id = NULL 恒不匹配 → 返回空（fail-closed，宁可不给数据也不串户）。
 * 只读：只 SELECT，无 INSERT/UPDATE/DELETE（§0 铁律 1）。
 */
async function queryEventsScoped(pool, tenantId, filters) {
    const { sql, values } = buildSelectSql(tenantId, filters);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        try {
            // SET LOCAL 语义（is_local=true），事务结束自动复位（fixed5 §6）
            await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
                tenantId,
            ]);
            const res = await client.query(sql, values);
            await client.query("COMMIT");
            return res.rows;
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
// ---------------------------------------------------------------------------
// 鉴权解析（fixed5 §4.2 ①/②）
// ---------------------------------------------------------------------------
/**
 * 解析 Authorization 头（fixed5 §4.2 ①）。
 * 只认 `Bearer <token>`（大小写不敏感）；缺失 / 非 Bearer / token 为空 → null。
 */
function parseAuthorization(raw) {
    if (typeof raw !== "string")
        return null;
    const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
    if (!m)
        return null;
    const token = m[1].trim();
    return token.length > 0 ? token : null;
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
 * 构建事件查询服务（fixed5 §1.1）。
 * 路由：GET /api/analytics/events。
 */
function buildQueryServer(options) {
    const { pool, verifyAnalyticsToken, now = Date.now, logger = true } = options;
    const app = (0, fastify_1.default)({ logger });
    // 兜底错误体：未捕获异常 → { ok:false, error:{code,message} }。
    app.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "events query failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        reply
            .status(statusCode)
            .send(errorBody(statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", statusCode >= 500 ? "internal error" : "bad request"));
    });
    app.get("/api/analytics/events", async (request, reply) => {
        // ① 解析凭证（fixed5 §4.2 ①/②）：缺失 / 非法 → 401
        const authHeader = request.headers["authorization"];
        const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token = parseAuthorization(raw);
        if (token === null) {
            return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
        }
        // ③ 只反查只读分析 token（fixed5 §4.2 ③）；查询出错 → 500
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
        // ④ 可识别但非只读 token（读写 key / webhook Secret / 未知）→ 403（fixed5 §4.1）
        if (auth === null) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ⑤ 过期只读 token → 401（fixed5 §1.4「过期 → 无法识别」）
        if (auth.expires_at !== null && auth.expires_at <= now()) {
            return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
        }
        // ⑤ scope 不足（不含 analytics:read）→ 403（fixed5 §4.2 ⑤）
        if (!Array.isArray(auth.scopes) || !auth.scopes.includes("analytics:read")) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ⑥ tenant 只从 token 派生（fixed5 §4.2 ⑥）；非法 UUID 是服务端配置错误 → 500
        const tenantId = auth.tenant_id;
        if (!(0, validate_1.isUuid)(tenantId)) {
            request.log.error({ tenant_id: tenantId }, "token tenant_id is not a UUID");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // 参数校验前置（fixed5 §2.3 ⑤）：from>to / limit<=0 / since 非法 → 400
        const parsed = parseEventFilters(request.query);
        if (!parsed.ok) {
            return reply
                .status(400)
                .send(errorBody("INVALID_QUERY", parsed.message));
        }
        // ⑦ 查询（SET LOCAL RLS 上下文 + 显式 WHERE 双保险，fixed5 §6）
        let rows;
        try {
            rows = await queryEventsScoped(pool, tenantId, parsed.filters);
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "query failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑧ 多取 1 条判 has_more；裁剪 + 白名单序列化（fixed5 §1.3 / §5.2）
        const limit = parsed.filters.limit;
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(serializeEventRow);
        const nextCursor = hasMore ? String(page[page.length - 1].seq) : null;
        return reply.status(200).send({
            items,
            next_cursor: nextCursor,
            has_more: hasMore,
            count: items.length,
        });
    });
    return app;
}
/** 构建并监听，返回已启动的服务与关闭句柄。 */
async function startQueryServer(options) {
    const app = buildQueryServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3001);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
//# sourceMappingURL=query.js.map