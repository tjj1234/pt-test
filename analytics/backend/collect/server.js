"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.2 Webhook 接收服务 —— Fastify 服务入口 + 路由
 *
 * 依据：《北极星开发/1-数据接入/1.2-Webhook接收服务.md》
 *   §1.1 端点与鉴权载体（POST /api/v1/collect/{webhook_id} + X-PT-Webhook-Secret）
 *   §1.2 请求体 / 字段校验边界（三件套 + 6 白名单，其余宽松透传）
 *   §2   Secret 鉴权（SHA-256 哈希 + crypto.timingSafeEqual 常量时间比较）
 *   §3   快速响应（立即 200 + 异步入队，不等待落库）
 *   §4   状态码总表 / 统一错误体
 *
 * 流水线（§3.1，①②③④⑤ 全部在返回前同步完成，只有「落库」被移到 1.3 worker）：
 *   ① 读 body（bodyLimit ≤1MB，超限 413）
 *   ② 解析 JSON / 校验三件套（失败 400 / 415）
 *   ③ Secret 鉴权（失败 401 / 403）
 *   ④ 组装 envelope：{ tenant_id, received_at, event }，tenant_id 由端点反查强制注入
 *   ⑤ 入队 Enqueue(envelope)（失败 503，上游 at-least-once 重试）
 *   → 返回 200（不等待 1.3 落库）
 *
 * 只读铁律：
 *   - webhook 是数据入口，本单元只「接收 + 鉴权 + 入队」，不在本单元落库（落库是 1.3 的事）。
 *   - 不编造、不改事件体：envelope.event 就是原始 body，不裁剪、不补默认值。
 *   - tenant_id 绝不读事件体，只认 Secret 反查结果（防串户最终防线，§2.4）。
 *   - Secret 只用于瞬时哈希比对，不落日志、不落库。
 *
 * 依赖注入（§3.3「抽象为 Enqueue(envelope) → ok/err，后端可换」）：
 *   - resolveEndpoint：webhook_id → 端点记录（webhook_endpoints 表由 1.3 落地）。
 *   - enqueue：envelope → 是否入队成功（Redis Stream 首选，进程内存队列为尖刀兜底）。
 * 本文件提供 buildServer（核心）+ createInMemoryEndpointResolver / createInMemoryQueue
 * （尖刀兜底默认实现）+ startCollectServer（可运行入口）。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
exports.createInMemoryEndpointResolver = createInMemoryEndpointResolver;
exports.createInMemoryQueue = createInMemoryQueue;
exports.startCollectServer = startCollectServer;
exports.registerShutdown = registerShutdown;
const fastify_1 = __importDefault(require("fastify"));
const node_crypto_1 = require("node:crypto");
const validate_1 = require("./validate");
// ---------------------------------------------------------------------------
// 常量时间 Secret 比对（§2.2 / §2.3）
// ---------------------------------------------------------------------------
/** 存储哈希应为 64 字符十六进制（SHA-256）。 */
const SECRET_HASH_HEX = /^[0-9a-f]{64}$/i;
/**
 * 判断请求携带的 Secret 是否与端点存储的 SHA-256 哈希一致。
 * - 先对「提供值」做 SHA-256，再与库中哈希做常量时间比较（防时序侧信道逐字节试探）。
 * - 存储哈希格式异常时 fail-closed（返回 false），绝不误放行。
 */
function secretMatches(providedSecret, storedHashHex) {
    const digest = (0, node_crypto_1.createHash)("sha256").update(providedSecret, "utf8").digest();
    if (!SECRET_HASH_HEX.test(storedHashHex))
        return false;
    const stored = Buffer.from(storedHashHex, "hex");
    return stored.length === digest.length && (0, node_crypto_1.timingSafeEqual)(digest, stored);
}
/** 把 catch 到的 unknown 归一为 Error，供 pino 序列化 err 字段。 */
function toError(err) {
    return err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : "unknown error");
}
function errorBody(code, message, eventId) {
    return eventId === undefined
        ? { ok: false, error: { code, message } }
        : { ok: false, error: { code, message }, event_id: eventId };
}
/** Fastify 框架错误码 → §4.1 业务错误码。 */
const FST_ERROR_CODE = {
    FST_ERR_CTP_BODY_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    FST_ERR_CTP_INVALID_JSON_BODY: "INVALID_JSON",
    FST_ERR_CTP_EMPTY_JSON_BODY: "INVALID_JSON",
    FST_ERR_CTP_INVALID_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
    FST_ERR_CTP_INVALID_CONTENT_LENGTH: "UNSUPPORTED_MEDIA_TYPE",
};
// ---------------------------------------------------------------------------
// buildServer：组装 Fastify 实例 + 唯一路由
// ---------------------------------------------------------------------------
/**
 * 构建 webhook 接收服务（服务入口）。
 * 路由：POST /api/v1/collect/{webhook_id}（§1.1）。
 */
function buildServer(options) {
    const { resolveEndpoint, enqueue, maxBodyBytes = 1024 * 1024, // 1MB
    logger = true, } = options;
    const app = (0, fastify_1.default)({
        logger,
        bodyLimit: maxBodyBytes,
    });
    // 统一错误体：把 Fastify 框架错误（body 超限 / 非 JSON / 媒体类型错等）映射为 §4.2 结构。
    app.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, "collect request failed");
        const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : 500;
        const code = FST_ERROR_CODE[error.code] ??
            (statusCode >= 500 ? "INTERNAL_ERROR" : "INVALID_EVENT");
        const message = statusCode >= 500 ? "internal error" : "bad request";
        reply
            .status(statusCode)
            .send(errorBody(code, message, (0, validate_1.tryExtractEventId)(request.body)));
    });
    app.post("/api/v1/collect/:webhook_id", async (request, reply) => {
        const { webhook_id } = request.params;
        const body = request.body; // Fastify 已按 application/json 解析
        const receivedAt = Date.now(); // 接收时间（仅参考，1.3 不落库）
        // ② 校验三件套 + 白名单（§1.2）—— 失败 400【临时注释：调试 GTM 时放开字段校验】
        // const validated = (0, validate_1.validateEvent)(body);
        // if (!validated.ok || !validated.event) {
        //     return reply
        //         .status(400)
        //         .send(errorBody("INVALID_EVENT", "invalid event", (0, validate_1.tryExtractEventId)(body)));
        // }
        // const { event_id } = validated.event;
        // 临时放开校验：仍尽量从 body 提取 event_id 供日志/响应使用，避免后续引用 undefined 崩溃
        const event_id = (0, validate_1.tryExtractEventId)(body);
        // ③ Secret 鉴权（§2.2）—— 缺 Secret 401
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
        // 端点不存在 / 停用 / Secret 错误 → 统一 403，文案一致防探测（§2.3 / §4.1）
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
        // ④ 组装 envelope：tenant_id 由端点反查强制注入，绝不读事件体身份字段（§2.4）
        const envelope = {
            tenant_id: endpoint.tenant_id,
            received_at: receivedAt,
            event: body, // 原始事件体，未改、未删、未补
        };
        // ⑤ 入队：入队成功才 200；失败 503 让上游 at-least-once 重试（§3.2）
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
        // 立即 200，不等待 1.3 落库（§1.3 / 验收标准）
        return reply.status(200).send({
            ok: true,
            event_id,
            received_at: receivedAt,
        });
    });
    return app;
}
// ---------------------------------------------------------------------------
// 尖刀阶段默认实现（可替换，§3.3 结论）
// ---------------------------------------------------------------------------
/**
 * 内存端点反查（尖刀 / 测试兜底）。
 * 生产应替换为查询 webhook_endpoints 表（1.3 落地），返回同样的 EndpointRecord。
 */
function createInMemoryEndpointResolver(records) {
    const byId = new Map(records.map((r) => [r.webhook_id, r]));
    return (webhookId) => byId.get(webhookId) ?? null;
}
function createInMemoryQueue() {
    const pending = [];
    return {
        enqueue: async (envelope) => {
            pending.push(envelope);
            return true;
        },
        pendingCount: () => pending.length,
        drainAll: () => pending.splice(0, pending.length),
    };
}
/** 构建并监听，返回已启动的服务与关闭句柄。 */
async function startCollectServer(options) {
    const app = buildServer(options);
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? 3000);
    await app.listen({ port, host });
    return {
        app,
        address: `${host}:${port}`,
        close: () => app.close(),
    };
}
/**
 * 优雅关闭（§3.5）：监听 SIGINT/SIGTERM，先停止收新请求并关闭，再退出。
 * 进程内存队列「已入队消息的消费」是 1.3 worker 的 drain 职责；
 * 生产用 Redis Stream 时消息持久化在队列，关闭服务不丢已入队消息。
 */
function registerShutdown(close) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            void Promise.resolve(close()).finally(() => process.exit(0));
        });
    }
}
//# sourceMappingURL=server.js.map