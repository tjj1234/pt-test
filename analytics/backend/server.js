"use strict";
/**
 * 北极星项目 · 统一服务入口 —— 一个进程、一个端口，同时提供全部端点
 *
 *   POST /api/v1/collect/:webhook_id   （单元 1.2，collect/server.ts 原实现）
 *   GET  /api/analytics/events         （单元 1.4，events/query.ts 原实现）
 *   GET  /api/analytics/funnel         （单元 2.4，ads/funnel.ts 原实现）
 *   GET  /api/analytics/audit/token    （单元 1.5，audit/route.ts 原实现）
 *
 * ── 方案选择（实测依据）────────────────────────────────────────────────────
 * 方案 A（Fastify 插件挂载「实例」）不可行：buildQueryServer / buildFunnelServer /
 * buildServer / buildTokenAuditServer 返回的是 Fastify **实例**，不是插件函数。
 * 实测 `parent.register(childInstance)` 同步不抛错、但 `ready()` 阶段 avvio 抛
 * `TypeError: func is not a function`（见 report / .tmp-plan-a-test.cjs）。因此
 * 采用方案 B：复用各模块已导出的纯函数，在统一 app 上按「与各单元逐字一致」的
 * 鉴权顺序与错误码重新注册路由。
 *
 * 复用点（不重写业务逻辑）：
 *   - audit：直接 `app.register(tokenAuditRoutes, opts)`（audit/route.ts 已导出插件）。
 *   - events：parseAuthorization / parseEventFilters / queryEventsScoped / serializeEventRow。
 *   - funnel：parseAuthorization / parseFunnelParams / queryFunnelScoped /
 *             serializeFunnelGroup / serializeRoiEntity + DEFAULT_SOURCE_PLATFORM_RULES。
 *   - collect：validateEvent / tryExtractEventId；secretMatches 未导出，此处逐字复制
 *             （SHA-256 + timingSafeEqual + 64 位 hex 校验，行为与原实现一致）。
 *
 * 铁律（不得因「合并」而放松任何一道）：
 *   1. 只读：三个分析端点纯 GET，无 body、无写操作；collect 只「接收 + 鉴权 + 入队」。
 *   2. tenant 只从 token（分析端点）/ Secret 反查（collect）派生，绝不读 query / body。
 *   3. 鉴权顺序与错误码逐字对齐：缺失/非法/过期 token → 401；可识别但非只读 token
 *      （读写 key / webhook Secret / 未知）→ 403；scope 不含 analytics:read → 403；
 *      参数非法 → 400；依赖查询/入队出错 → 500 / 503。
 *   4. 依赖（pool / verifyAnalyticsToken / loadAuditLogs / loadConfigFindings /
 *      resolveEndpoint / enqueue / resolveWorkspaceId）全部参数注入，不硬编码连接。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildUnifiedServer = buildUnifiedServer;
exports.startUnifiedServer = startUnifiedServer;
const fastify_1 = __importDefault(require("fastify"));
const node_crypto_1 = require("node:crypto");
const validate_1 = require("./collect/validate");
const validate_2 = require("./collect/validate");
const query_1 = require("./events/query");
const funnel_1 = require("./ads/funnel");
const attribution_1 = require("./ads/attribution");
const route_1 = require("./audit/route");
const import_1 = require("../../business/attribution/import/routes");
// ---- P1 #6：可信租户头注入（默认关；TRUST_TENANT_HEADER=1 且 X-Tenant-Id 为合法 UUID 时生效）----
// 信任边界：本服务只应由业务壳（同机 127.0.0.1）反代访问；业务壳只透传「其登录会话派生」
// 的租户。此处是「可信头 → 租户」的唯一收口，供 A 方案每租户隔离（set_config + RLS 已就绪）。
// 默认关闭时完全不读该头，与旧行为一致（租户只从 token 派生，B 方案共享演示数据兜底）。
const TRUST_TENANT_HEADER = process.env.TRUST_TENANT_HEADER === "1";
function trustedTenantHeader(request) {
    if (!TRUST_TENANT_HEADER)
        return null;
    const h = request && request.headers ? request.headers["x-tenant-id"] : undefined;
    const v = Array.isArray(h) ? h[0] : h;
    if (typeof v !== "string" || v.length === 0)
        return null;
    return (0, validate_1.isUuid)(v) ? v : null;
}
function errorBody(code, message, eventId) {
    return eventId === undefined
        ? { ok: false, error: { code, message } }
        : { ok: false, error: { code, message }, event_id: eventId };
}
function toError(err) {
    return err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : "unknown error");
}
/** 三个分析端点共用的兜底错误码（照抄 events/query.ts / ads/funnel.ts / audit/route.ts）。 */
function analyticsErrorBody(statusCode) {
    return errorBody(statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", statusCode >= 500 ? "internal error" : "bad request");
}
// ---------------------------------------------------------------------------
// collect：常量时间 Secret 比对（collect/server.ts 未导出，此处逐字复制）
// ---------------------------------------------------------------------------
/** 存储哈希应为 64 字符十六进制（SHA-256）。 */
const SECRET_HASH_HEX = /^[0-9a-f]{64}$/i;
/** Fastify 框架错误码 → 业务错误码（collect/server.ts §4.1 原表）。 */
const FST_ERROR_CODE = {
    FST_ERR_CTP_BODY_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    FST_ERR_CTP_INVALID_JSON_BODY: "INVALID_JSON",
    FST_ERR_CTP_EMPTY_JSON_BODY: "INVALID_JSON",
    FST_ERR_CTP_INVALID_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
    FST_ERR_CTP_INVALID_CONTENT_LENGTH: "UNSUPPORTED_MEDIA_TYPE",
};
function secretMatches(providedSecret, storedHashHex) {
    const digest = (0, node_crypto_1.createHash)("sha256").update(providedSecret, "utf8").digest();
    if (!SECRET_HASH_HEX.test(storedHashHex))
        return false;
    const stored = Buffer.from(storedHashHex, "hex");
    return stored.length === digest.length && (0, node_crypto_1.timingSafeEqual)(digest, stored);
}
function registerEventsRoutes(scope, deps) {
    const { pool, verifyAnalyticsToken, now } = deps;
    scope.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "events query failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        reply.status(statusCode).send(analyticsErrorBody(statusCode));
    });
    scope.get("/api/analytics/events", async (request, reply) => {
        // ① 解析凭证（fixed5 §4.2 ①/②）：缺失 / 非法 → 401
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
        // ⑥ tenant 只从 token 派生；非法 UUID 是服务端配置错误 → 500
        const tenantId = trustedTenantHeader(request) || auth.tenant_id;
        if (!(0, validate_1.isUuid)(tenantId)) {
            request.log.error({ tenant_id: tenantId }, "token tenant_id is not a UUID");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // 参数校验前置：from>to / limit<=0 / since 非法 → 400
        const parsed = (0, query_1.parseEventFilters)(request.query);
        if (!parsed.ok) {
            return reply
                .status(400)
                .send(errorBody("INVALID_QUERY", parsed.message));
        }
        // 查询（SET LOCAL RLS 上下文 + 显式 WHERE 双保险）
        let rows;
        try {
            rows = await (0, query_1.queryEventsScoped)(pool, tenantId, parsed.filters);
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "query failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // 多取 1 条判 has_more；裁剪 + 白名单序列化
        const limit = parsed.filters.limit;
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(query_1.serializeEventRow);
        const nextCursor = hasMore ? String(page[page.length - 1].seq) : null;
        return reply.status(200).send({
            items,
            next_cursor: nextCursor,
            has_more: hasMore,
            count: items.length,
        });
    });
}
function registerFunnelRoutes(scope, deps) {
    const { pool, verifyAnalyticsToken, resolveWorkspaceId, sourcePlatformRules, now } = deps;
    scope.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "funnel query failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        reply.status(statusCode).send(analyticsErrorBody(statusCode));
    });
    scope.get("/api/analytics/funnel", async (request, reply) => {
        // ① 解析凭证：缺失 / 非法 → 401
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
        // ③ 可识别但非只读 token → 403
        if (auth === null) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ④ 过期只读 token → 401
        if (auth.expires_at !== null && auth.expires_at <= now()) {
            return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
        }
        // ⑤ scope 不足 → 403
        if (!Array.isArray(auth.scopes) || !auth.scopes.includes("analytics:read")) {
            return reply.status(403).send(errorBody("FORBIDDEN", "forbidden"));
        }
        // ⑥ tenant 只从 token 派生；非法 UUID → 500
        const tenantId = trustedTenantHeader(request) || auth.tenant_id;
        if (!(0, validate_1.isUuid)(tenantId)) {
            request.log.error({ tenant_id: tenantId }, "token tenant_id is not a UUID");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑦ 参数校验前置：from>to / granularity / platform / limit / window → 400
        const parsed = (0, funnel_1.parseFunnelParams)(request.query);
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
            result = await (0, funnel_1.queryFunnelScoped)(pool, tenantId, workspaceId, parsed.params, {
                sourcePlatformRules,
            });
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "query failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // ⑩ 序列化：bucket 仅在 granularity != total 时出现
        const response = {
            from: result.from,
            to: result.to,
            granularity: parsed.params.granularity,
            platform: parsed.params.platform,
            country: parsed.params.country,
            groups: result.groups.map((r) => (0, funnel_1.serializeFunnelGroup)(r, parsed.params.granularity)),
            roi_by_entity: result.roi.map((r) => (0, funnel_1.serializeRoiEntity)(r, parsed.params.granularity)),
            data_freshness: {
                ...result.freshness,
                generated_at: new Date(now()).toISOString(),
            },
        };
        return reply.status(200).send(response);
    });
}
function registerCollectRoutes(scope, deps) {
    const { resolveEndpoint, enqueue } = deps;
    scope.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "collect request failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        const code = FST_ERROR_CODE[error.code] ??
            (statusCode >= 500 ? "INTERNAL_ERROR" : "INVALID_EVENT");
        const message = statusCode >= 500 ? "internal error" : "bad request";
        reply
            .status(statusCode)
            .send(errorBody(code, message, (0, validate_2.tryExtractEventId)(request.body)));
    });
    scope.post("/api/v1/collect/:webhook_id", async (request, reply) => {
        const { webhook_id } = request.params;
        const body = request.body;
        const receivedAt = Date.now();
        // ② 校验三件套 + 白名单 —— 失败 400
        const validated = (0, validate_2.validateEvent)(body);
        if (!validated.ok || !validated.event) {
            return reply
                .status(400)
                .send(errorBody("INVALID_EVENT", "invalid event", (0, validate_2.tryExtractEventId)(body)));
        }
        const { event_id } = validated.event;
        // ③ Secret 鉴权 —— 缺 Secret 401
        const secretHeader = request.headers["x-pt-webhook-secret"];
        const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
        if (!secret) {
            return reply
                .status(401)
                .send(errorBody("MISSING_SECRET", "unauthorized", event_id));
        }
        // 端点反查（webhook_id → 端点记录）
        let endpoint = null;
        try {
            endpoint = await resolveEndpoint(webhook_id);
        }
        catch (err) {
            request.log.error({ err: toError(err), webhook_id }, "endpoint lookup failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error", event_id));
        }
        // 端点不存在 / 停用 / Secret 错误 → 统一 403，文案一致防探测
        if (!endpoint || endpoint.status !== "active") {
            return reply
                .status(403)
                .send(errorBody("INVALID_SECRET", "unauthorized", event_id));
        }
        if (!secretMatches(secret, endpoint.secret_hash)) {
            return reply
                .status(403)
                .send(errorBody("INVALID_SECRET", "unauthorized", event_id));
        }
        // ④ 组装 envelope：tenant_id 由端点反查强制注入，绝不读事件体身份字段
        const envelope = {
            tenant_id: endpoint.tenant_id,
            received_at: receivedAt,
            event: body,
        };
        // ⑤ 入队：入队成功才 200；失败 503 让上游 at-least-once 重试
        let enqueued = false;
        try {
            enqueued = await enqueue(envelope);
        }
        catch (err) {
            request.log.error({ err: toError(err), event_id, tenant_id: endpoint.tenant_id }, "enqueue failed");
            enqueued = false;
        }
        if (!enqueued) {
            return reply
                .status(503)
                .send(errorBody("QUEUE_UNAVAILABLE", "queue unavailable", event_id));
        }
        request.log.info({ event_id, webhook_id, tenant_id: endpoint.tenant_id }, "event accepted");
        // 立即 200，不等待 1.3 落库
        return reply.status(200).send({
            ok: true,
            event_id,
            received_at: receivedAt,
        });
    });
}
// ---------------------------------------------------------------------------
// buildUnifiedServer：组装统一 Fastify 实例
// ---------------------------------------------------------------------------
/**
 * 构建统一服务（一个进程一个端口，四端点齐全）。
 * 每个单元的路由在独立 register 封装作用域内注册，以保留各单元原 setErrorHandler 行为
 * （collect 的 FST 错误码映射与分析端点的 BAD_REQUEST/INTERNAL_ERROR 互不串扰）。
 */
function buildUnifiedServer(options) {
    const { resolveEndpoint, enqueue, verifyAnalyticsToken, pool, loadAuditLogs, loadConfigFindings, resolveWorkspaceId = (tenantId) => tenantId, sourcePlatformRules = attribution_1.DEFAULT_SOURCE_PLATFORM_RULES, now = Date.now, maxBodyBytes = 1024 * 1024, // 1MB，对齐 collect/server.ts
    logger = true, } = options;
    const app = (0, fastify_1.default)({ logger, bodyLimit: maxBodyBytes });
    // 1.4 事件查询
    app.register(async (scope) => {
        registerEventsRoutes(scope, { pool, verifyAnalyticsToken, now });
    });
    // 2.4 漏斗查询
    app.register(async (scope) => {
        registerFunnelRoutes(scope, {
            pool,
            verifyAnalyticsToken,
            resolveWorkspaceId,
            sourcePlatformRules,
            now,
        });
    });
    // 1.5 Token 审计（直接复用 audit/route.ts 已导出的插件，鉴权顺序/错误码逐字一致）
    app.register(route_1.tokenAuditRoutes, {
        verifyAnalyticsToken,
        loadAuditLogs,
        loadConfigFindings,
        now,
    });
    // 1.2 webhook 采集
    app.register(async (scope) => {
        registerCollectRoutes(scope, { resolveEndpoint, enqueue });
    });
    // A9 广告导出导入（业务线；不碰 shell）
    app.register(async (scope) => {
        (0, import_1.registerImportRoutes)(scope, {
            pool,
            verifyAnalyticsToken,
            resolveWorkspaceId,
            parseAuthorization: query_1.parseAuthorization,
        });
    });
    return app;
}
/** 构建并监听，返回已启动的服务与关闭句柄。 */
async function startUnifiedServer(options) {
    const app = buildUnifiedServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3000);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
//# sourceMappingURL=server.js.map