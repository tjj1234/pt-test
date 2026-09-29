"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.5 Token 审计 HTTP 路由 —— GET /api/analytics/audit/token
 *
 * 依据（跨单元接线项，前端 3.4 健康 Tab 已按此路径调用，本文件补齐后端）：
 *   《北极星开发/1-数据接入/1.5-Token最小审计-fixed.md》§7（只读旁路、最小子集）
 *   《北极星开发/3-界面/3.4-健康Tab.md》§2.3（health Tab 调 AnalyticsClient.getTokenAudit()）
 *   《北极星开发/5-胶水/5.2-tool封装.md》token-audit tool（parameters 只暴露 from/to，
 *    缺省 = 最近一个完整自然日 UTC；tenant_id、SS-GTM 访问凭证由后端注入）
 *   glue/tools.json token-audit 的 $depsNote（数据源 = SS-GTM Debug 日志 + GTM 静态配置）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. 只读：纯 GET、无请求体、无任何 INSERT/UPDATE/DELETE/入队/落库；审计是旁路，
 *      不写、不拦、不改事件流（1.5 §7.3）。
 *   2. tenant 只从只读 token 派生，绝不读查询参数 / 请求头里的任何租户字段（§4.2 ⑥）。
 *   3. 不编造：report 原样透传 runTokenAudit 的产出，不改键名、不补数、不重算。
 *   4. 鉴权分流（照抄 1.4 events/query.ts §4、2.4 ads/funnel.ts §5）：
 *      缺失/非法/过期 token → 401；可识别但非只读 token（读写 key / webhook Secret / 未知）
 *      → 403；scope 不含 analytics:read → 403。
 *
 * ── 关于「只 SELECT / BEGIN READ ONLY / RLS」的如实说明（重要，非遗漏）──
 *   runTokenAudit 是纯函数（src/audit/token.ts），其输入是 SS-GTM Debug 日志逐条记录
 *   （SsGtmLogEntry），不是 pt_events 表行。1.5 §8.1 已明确：pt_events 宽表没有「来源侧」
 *   列（transport / event_source / x_pt_source / ip_override），审计的三事件
 *   （credit_purchase / balance_recharge / token_consume）也不在 pt_events 的 6 白名单里，
 *   故来源判定必须由调用方从 SS-GTM Debug 日志解析后传入，「本模块不对 pt_events 做来源推断」。
 *   当前数据库 schema（db/001_init.sql）也没有任何 SS-GTM 日志表。因此本路由**没有**可执行
 *   的 SQL —— 它不读 pt_events，也就没有需要 BEGIN READ ONLY / set_config / RLS 的事务体。
 *
 *   只读与租户隔离在这里改由**边界**保证（与 2.4 注入 resolveWorkspaceId 同一风格）：
 *     - loadAuditLogs：只读依赖注入，接收「token 派生的 tenantId」+ 时间窗，返回该租户
 *       SS-GTM Debug 日志；生产实现由 SS-GTM 容器访问凭证界定租户（工具侧已约定
 *       「tenant_id、SS-GTM 访问凭证由后端注入」）。若未来把 SS-GTM 日志落库成
 *       ss_gtm_debug_logs 表，则该表必须 FORCE RLS + tenant_isolation 策略，并在
 *       loadAuditLogs 的 SQL 里 set_config('app.current_tenant_id', $1, true) + 显式
 *       WHERE tenant_id = $1 双保险（届时铁律 1 的「只 SELECT + BEGIN READ ONLY」落到该实现里）。
 *     - scopeLogsToTenant：本路由在喂给 runTokenAudit 前，防御性地丢弃「显式声明了
 *       tenant_id 且与 token 派生 tenant 不匹配」的日志（fail-closed，应用层 RLS 等价），
 *       这是无 SQL 场景下的「双保险」第一层；第二层由 loadAuditLogs 的租户界定兜底。
 *
 * 依赖注入（对齐 collect/server.ts、events/query.ts、ads/funnel.ts 风格，数据源可换）：
 *   - verifyAnalyticsToken：只反查「只读分析 token」签发表，返回 AnalyticsAuth | null。
 *   - loadAuditLogs：tenantId + 时间窗 → SS-GTM Debug 日志（已拍平成 SsGtmLogEntry）。
 *   - loadConfigFindings：可选，GTM 静态配置审计发现（手段二辅助，只作建议、不改 score）。
 * 本文件提供 tokenAuditRoutes（插件）+ buildTokenAuditServer（核心）+ createInMemoryAuditLogLoader
 * （测试兜底）+ startTokenAuditServer（可运行入口）。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInMemoryTokenVerifier = exports.tokenAuditRoutes = void 0;
exports.parseAuditParams = parseAuditParams;
exports.startOfUtcDay = startOfUtcDay;
exports.effectiveAuditWindow = effectiveAuditWindow;
exports.scopeLogsToTenant = scopeLogsToTenant;
exports.registerTokenAuditRoutes = registerTokenAuditRoutes;
exports.buildTokenAuditServer = buildTokenAuditServer;
exports.createInMemoryAuditLogLoader = createInMemoryAuditLogLoader;
exports.startTokenAuditServer = startTokenAuditServer;
const fastify_1 = __importDefault(require("fastify"));
const validate_1 = require("../collect/validate");
const query_1 = require("../events/query");
const token_1 = require("./token");
// ---- P1 #6：可信租户头注入（默认关；TRUST_TENANT_HEADER=1 且 X-Tenant-Id 为合法 UUID 时生效）----
// 与 server.js 同款收口：默认关闭不读该头（租户只从 token 派生），开启后优先采信可信头。
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
/** 是否合法非负整数（十进制，无符号/空格/小数）。 */
function isNonNegativeInt(s) {
    return /^\d+$/.test(s);
}
/**
 * 解析并校验审计时间窗参数（from/to 均可选，epoch 毫秒，UTC，含）。
 * - from/to：非负安全整数；from > to → 400。
 * - 其余参数一律忽略（token-audit tool 契约只暴露 from/to；事件范围/判据/评分在后端写死）。
 * 注意：本函数绝不读取 / 使用任何 tenant_id 入参（tenant 只从 token 派生，§4.2 ⑥）。
 */
function parseAuditParams(query) {
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
    return { ok: true, from, to };
}
// ---------------------------------------------------------------------------
// 时间窗缺省回填（tools.json：from/to 缺省 = 最近一个完整自然日，UTC）
// ---------------------------------------------------------------------------
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** epoch 毫秒 → 当日 00:00 UTC（自然日起点）。 */
function startOfUtcDay(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
/**
 * 生效时间窗（from/to 缺省回填，两侧均含）。
 *   to   缺省 = 今日 00:00 UTC（即「最近一个完整自然日」的结束边界）
 *   from 缺省 = 生效 to 往前 24h（即昨日 00:00 UTC）
 * 两者都缺省 → 恰好覆盖「最近一个完整自然日（UTC）」（对齐 tools.json）。
 */
function effectiveAuditWindow(from, to, nowMs) {
    const toMs = to ?? startOfUtcDay(nowMs);
    const fromMs = from ?? toMs - MS_PER_DAY;
    return { from: fromMs, to: toMs };
}
// ---------------------------------------------------------------------------
// 应用层租户隔离兜底（无 SQL 场景下的 RLS 等价，fail-closed）
// ---------------------------------------------------------------------------
/**
 * 防御性租户过滤（第二层「双保险」的第一层应用层兜底）。
 * 只丢弃「显式声明了非空 tenant_id 且与 token 派生 tenant 不一致」的日志；
 * 未携带 tenant_id 的日志保留（其租户归属由 loadAuditLogs 的租户界定兜底）。
 * 只删不增、不改字段 —— 不触碰审计数值口径，只做隔离。
 */
function scopeLogsToTenant(logs, tenantId) {
    return logs.filter((log) => {
        if (typeof log.tenant_id === "string" && log.tenant_id.length > 0) {
            return log.tenant_id === tenantId;
        }
        return true;
    });
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
 * 在给定 Fastify 实例上注册 GET /api/analytics/audit/token（照抄 1.4/2.4 的鉴权顺序）。
 * 只读：纯 GET，无 body，无任何写操作。
 */
function registerTokenAuditRoutes(app, options) {
    const { verifyAnalyticsToken, loadAuditLogs, loadConfigFindings, now = Date.now } = options;
    // 兜底错误体（照抄 1.4/2.4）
    app.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "token audit failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        reply
            .status(statusCode)
            .send(errorBody(statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", statusCode >= 500 ? "internal error" : "bad request"));
    });
    app.get("/api/analytics/audit/token", async (request, reply) => {
        // ① 解析凭证（1.4 §4.2 ①/②）：缺失 / 非法 → 401
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
        // ⑦ 参数校验前置：from/to 非法（含 from > to）→ 400；绝不读 tenant_id
        const parsed = parseAuditParams(request.query);
        if (!parsed.ok) {
            return reply
                .status(400)
                .send(errorBody("INVALID_QUERY", parsed.message));
        }
        // ⑧ 生效时间窗（缺省 = 最近一个完整自然日 UTC，tools.json）
        const window = effectiveAuditWindow(parsed.from, parsed.to, now());
        // ⑨ 只读拉取 SS-GTM Debug 日志（租户界定在依赖内）；出错 → 500
        let logs;
        try {
            logs = await loadAuditLogs(tenantId, window);
        }
        catch (err) {
            request.log.error({ err: toError(err), tenant_id: tenantId }, "loadAuditLogs failed");
            return reply
                .status(500)
                .send(errorBody("INTERNAL_ERROR", "internal error"));
        }
        // 应用层租户隔离兜底（fail-closed，只删不增）
        logs = scopeLogsToTenant(logs, tenantId);
        // ⑩ 可选：GTM 静态配置发现（手段二辅助）；出错 → 500
        let configFindings;
        if (loadConfigFindings) {
            try {
                configFindings = await loadConfigFindings(tenantId);
            }
            catch (err) {
                request.log.error({ err: toError(err), tenant_id: tenantId }, "loadConfigFindings failed");
                return reply
                    .status(500)
                    .send(errorBody("INTERNAL_ERROR", "internal error"));
            }
        }
        // ⑪ 审计（纯函数），report 原样透传，不改键名、不补数
        const report = (0, token_1.runTokenAudit)({ logs, window, configFindings });
        return reply.status(200).send({
            report,
            generated_at: new Date(now()).toISOString(),
        });
    });
}
/** Fastify 插件形式：可在合并的 analytics server 里 `app.register(tokenAuditRoutes, opts)`。 */
const tokenAuditRoutes = async (app, opts) => {
    registerTokenAuditRoutes(app, opts);
};
exports.tokenAuditRoutes = tokenAuditRoutes;
/** 构建独立的 Token 审计服务（对齐 buildQueryServer / buildFunnelServer）。 */
function buildTokenAuditServer(options) {
    const app = (0, fastify_1.default)({ logger: options.logger ?? true });
    registerTokenAuditRoutes(app, options);
    return app;
}
/**
 * 内存日志拉取（测试兜底）。生产替换为 SS-GTM Debug API 拉取（或未来 ss_gtm_debug_logs 表）。
 * 只做两件事：按 tenant_id 租户过滤 + 按时间窗（log.timestamp ∈ [from, to]，缺 timestamp 不滤）。
 */
function createInMemoryAuditLogLoader(records) {
    return async (tenantId, window) => records.filter((r) => {
        if (r.tenant_id !== tenantId)
            return false;
        if (window.from !== undefined &&
            r.timestamp !== undefined &&
            r.timestamp < window.from) {
            return false;
        }
        if (window.to !== undefined &&
            r.timestamp !== undefined &&
            r.timestamp > window.to) {
            return false;
        }
        return true;
    });
}
/** 构建并监听，返回已启动的服务与关闭句柄。 */
async function startTokenAuditServer(options) {
    const app = buildTokenAuditServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3001);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
// 复用 1.4 的内存只读 token 反查（测试兜底）
var query_2 = require("../events/query");
Object.defineProperty(exports, "createInMemoryTokenVerifier", { enumerable: true, get: function () { return query_2.createInMemoryTokenVerifier; } });
//# sourceMappingURL=route.js.map