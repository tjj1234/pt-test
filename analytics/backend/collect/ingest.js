"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.3 幂等落库 worker
 *
 * 依据：《北极星开发/1-数据接入/1.3-幂等落库-rev4.md》
 *   §1.1 消费落库流程（单写者串行，seq 由 DB 序列分配）
 *   §1.3 seq 全局单调 + 单写者串行（下游 1.4 增量游标硬前提）
 *   §2   幂等 INSERT … ON CONFLICT (tenant_id, event_id) DO NOTHING
 *   §4   多租户隔离（SET LOCAL 上下文 + RLS，tenant 只取 envelope）
 *   §5   失败重试（可重试/不可重试分流 + 指数退避 + DLQ）
 *   §6   落库前清洗与归一化（字段白名单 + Key 脱敏）
 *   §7   append-only（只 INSERT，绝不 UPDATE/DELETE）
 *
 * 铁律（写进代码，不靠自觉）：
 *   1. tenant_id 只取 envelope.tenant_id，绝不读事件体内任何身份字段（§4.1）。
 *   2. seq 由 DEFAULT nextval('pt_events_seq') 在 INSERT 时由 DB 分配，worker 不生成。
 *   3. 只 INSERT，全文件无 UPDATE / DELETE（append-only，§7）。
 *   4. 不存 IP（只存 country/region）、不存 prompt/completion 正文（只存 token 用量）。
 *   5. Key 只落「前 8 位 + SHA-256 哈希」，完整 Key 只在本函数内存停留一瞬（§6）。
 *   6. 运行时永不 DISABLE RLS（只有一次性迁移脚本允许，§3.3 纪律）。
 *
 * 依赖注入（对齐 server.ts 风格，队列后端可换）：
 *   dequeue / ack / moveToDlq 抽象了「从哪取消息、取完怎么确认、死信怎么写」，
 *   生产接 Redis Stream（XREAD 单消费者串行，§1.1），尖刀用 createInMemoryIngestQueue。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermanentEventError = void 0;
exports.classifyError = classifyError;
exports.maskKey = maskKey;
exports.normalizeEvent = normalizeEvent;
exports.ingestOne = ingestOne;
exports.createIngestWorker = createIngestWorker;
exports.createInMemoryIngestQueue = createInMemoryIngestQueue;
exports.createPool = createPool;
exports.runIngestWorker = runIngestWorker;
const pg_1 = require("pg");
const node_crypto_1 = require("node:crypto");
const validate_1 = require("./validate");
// ---------------------------------------------------------------------------
// 错误分类（§5.1：先分流，再决定重试还是进死信）
// ---------------------------------------------------------------------------
/** 不可重试（永久）错误：这条消息本身有问题，重试 N 次也不会好（§5.1 表）。 */
class PermanentEventError extends Error {
    constructor(message) {
        super(message);
        this.name = "PermanentEventError";
    }
}
exports.PermanentEventError = PermanentEventError;
/** 可重试 SQLSTATE（§5.1 表：连接/超时/连接数/死锁/串行化/语句超时）。 */
const RETRYABLE_SQLSTATE = new Set([
    "08000", // connection_exception
    "08003", // connection_does_not_exist
    "08006", // connection_failure
    "57P01", // admin_shutdown
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
    "53300", // too_many_connections
    "40P01", // deadlock_detected
    "40001", // serialization_failure
    "57014", // query_canceled（statement_timeout）
    "55P03", // lock_not_available
]);
/** 网络层错误码（node 侧，连接失败/超时等，非 SQLSTATE）。 */
const RETRYABLE_NET = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
]);
/** 从未知异常里尽量取出 pg 错误码（SQLSTATE 或 node 网络错误码）。 */
function pgCode(err) {
    if (err !== null && typeof err === "object") {
        const code = err.code;
        if (typeof code === "string")
            return code;
    }
    return undefined;
}
/**
 * 错误分类（§5.1）。
 * - duplicate：唯一键冲突，已被 ON CONFLICT DO NOTHING 消化，正常路径不会抛；兜底按成功 ACK。
 * - permanent：数据/约束类，直接 DLQ 不重试。
 * - retryable：瞬时故障，退避重试；未知异常默认按可重试（宁可重试，不静默丢，§5.4）。
 */
function classifyError(err) {
    if (err instanceof PermanentEventError)
        return "permanent";
    const code = pgCode(err);
    if (!code)
        return "retryable";
    if (code === "23505")
        return "duplicate"; // unique_violation（seq 唯一等，正常不出现）
    if (code.startsWith("22"))
        return "permanent"; // data_exception 系列（22xxx）
    if (code === "23502" || code === "23514")
        return "permanent"; // not_null / check
    if (RETRYABLE_SQLSTATE.has(code) || RETRYABLE_NET.has(code))
        return "retryable";
    return "retryable"; // 保守默认：未知按可重试
}
// ---------------------------------------------------------------------------
// 类型归一化原语（§6：转换失败即归入「不可重试」→ DLQ）
// ---------------------------------------------------------------------------
/** TEXT 列：字符串直通；数字/布尔宽松转字符串；其余判永久错误。 */
function text(v, field) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "string")
        return v;
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    throw new PermanentEventError(`字段 ${field} 需为字符串（实际 ${typeof v}）`);
}
/** BIGINT 列：合法整数（Number.isSafeInteger 内），字符串整数可转。 */
function bigint(v, field) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "number" && Number.isSafeInteger(v))
        return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
        const n = Number(v);
        if (Number.isSafeInteger(n))
            return n;
    }
    throw new PermanentEventError(`字段 ${field} 需为整数（BIGINT）`);
}
/** INTEGER 列：合法整数（http_status 等）。 */
function integer(v, field) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "number" && Number.isInteger(v))
        return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
        const n = Number(v);
        if (Number.isInteger(n))
            return n;
    }
    throw new PermanentEventError(`字段 ${field} 需为整数（INTEGER）`);
}
/** BOOLEAN 列：布尔直通；"true"/"false"、1/0 可转。 */
function booleanValue(v, field) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "boolean")
        return v;
    if (v === "true")
        return true;
    if (v === "false")
        return false;
    if (v === 1)
        return true;
    if (v === 0)
        return false;
    throw new PermanentEventError(`字段 ${field} 需为布尔值（实际 ${typeof v}）`);
}
/** NUMERIC 列：返回字符串（避免浮点精度损失），数字/数字字符串可转。 */
function numeric(v, field) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "number") {
        if (Number.isFinite(v))
            return String(v);
        throw new PermanentEventError(`字段 ${field} 需为有限数值（NUMERIC）`);
    }
    if (typeof v === "string") {
        const s = v.trim();
        if (s !== "" && Number.isFinite(Number(s)))
            return s;
        throw new PermanentEventError(`字段 ${field} 需为数值（NUMERIC）`);
    }
    throw new PermanentEventError(`字段 ${field} 需为数值（NUMERIC）`);
}
/**
 * Key 脱敏（§6 / 1.1 §4 合规硬约束，对齐 key_id_prefix/key_id_hash 列）。
 * - key_id_prefix = 完整 Key 前 8 位（人工/日志定位）。
 * - key_id_hash   = SHA-256(完整 Key) 十六进制（64 字符）。
 * - 完整 Key 明文只在本函数内存停留一瞬，算完即弃，返回值不含明文。
 */
function maskKey(key) {
    if (key === undefined || key === null)
        return undefined;
    if (typeof key !== "string" || key.length === 0) {
        throw new PermanentEventError("key_id 需为非空字符串（用于脱敏）");
    }
    return {
        key_id_prefix: key.slice(0, 8),
        key_id_hash: (0, node_crypto_1.createHash)("sha256").update(key, "utf8").digest("hex"),
    };
}
/** 通用 TEXT 字段（契约 §1.1，每个事件都带、可空）。 */
const COMMON_TEXT_FIELDS = [
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
    "country", // 只存国家，不存原始 IP（铁律 4）
    "region",
    "user_agent",
    "device_type",
    "os",
    "browser",
    "page_url",
    "referrer",
];
/**
 * 事件体归一化（§6）。只映射表里存在的白名单列，未知字段（含正文 prompt/completion
 * 若被误带、以及事件体内任何 tenant_id）一律丢弃。三件套复用 1.2 的 validateEvent。
 */
function normalizeEvent(event) {
    const validated = (0, validate_1.validateEvent)(event);
    if (!validated.ok || !validated.event) {
        throw new PermanentEventError(`事件体三件套校验失败: ${JSON.stringify(validated.errors)}`);
    }
    const rec = event;
    const { event_id, event_name, timestamp } = validated.event;
    const row = {
        event_id, // UUID 字符串（幂等键之一）
        event_name, // 6 白名单之一
        timestamp, // int64 epoch 毫秒（1.2 已校验，此处为强类型直取）
    };
    // 通用 TEXT 字段白名单（§6 字段白名单）
    for (const field of COMMON_TEXT_FIELDS) {
        row[field] = text(rec[field], field);
    }
    switch (event_name) {
        case "visit":
            row.page_path = text(rec["page_path"], "page_path");
            row.page_title = text(rec["page_title"], "page_title");
            row.session_id = text(rec["session_id"], "session_id");
            row.dwell_time_ms = bigint(rec["dwell_time_ms"], "dwell_time_ms");
            break;
        case "signup":
            row.registration_method = text(rec["registration_method"], "registration_method");
            row.email_verified = booleanValue(rec["email_verified"], "email_verified");
            break;
        case "key_created": {
            row.create_page = text(rec["create_page"], "create_page");
            row.key_type = text(rec["key_type"], "key_type");
            const masked = maskKey(rec["key_id"]);
            if (masked) {
                row.key_id_prefix = masked.key_id_prefix;
                row.key_id_hash = masked.key_id_hash;
            }
            break;
        }
        case "model_call": {
            row.model = text(rec["model"], "model");
            row.source = text(rec["source"], "source");
            row.caller = text(rec["caller"], "caller");
            row.request_time = bigint(rec["request_time"], "request_time");
            row.response_time = bigint(rec["response_time"], "response_time");
            row.latency_ms = bigint(rec["latency_ms"], "latency_ms");
            row.success = booleanValue(rec["success"], "success");
            row.http_status = integer(rec["http_status"], "http_status");
            row.error_code = text(rec["error_code"], "error_code");
            row.request_id = text(rec["request_id"], "request_id");
            row.response_id = text(rec["response_id"], "response_id");
            row.provider = text(rec["provider"], "provider");
            row.endpoint = text(rec["endpoint"], "endpoint");
            row.prompt_tokens = bigint(rec["prompt_tokens"], "prompt_tokens");
            row.completion_tokens = bigint(rec["completion_tokens"], "completion_tokens");
            row.total_tokens = bigint(rec["total_tokens"], "total_tokens");
            row.cost = numeric(rec["cost"], "cost");
            const masked = maskKey(rec["key_id"]);
            if (masked) {
                row.key_id_prefix = masked.key_id_prefix;
                row.key_id_hash = masked.key_id_hash;
            }
            break;
        }
        case "recharge":
            row.recharge_id = text(rec["recharge_id"], "recharge_id");
            row.amount = numeric(rec["amount"], "amount");
            row.currency = text(rec["currency"], "currency");
            row.payment_method = text(rec["payment_method"], "payment_method");
            row.status = text(rec["status"], "status"); // success / failed（recharge 专用）
            break;
        case "auto_recharge_toggle":
            row.enabled = booleanValue(rec["enabled"], "enabled");
            break;
    }
    // 铁律 1/§4.1：tenant_id 只由 ingestOne 从 envelope 注入，事件体任何 tenant_id 已在
    // 白名单之外被丢弃；本函数绝不读、绝不落事件体身份字段。
    return row;
}
// ---------------------------------------------------------------------------
// 幂等 INSERT（§2：ON CONFLICT (tenant_id, event_id) DO NOTHING）
// ---------------------------------------------------------------------------
/** 落库列白名单（固定顺序，不含 seq —— seq 由 DEFAULT nextval('pt_events_seq') 分配）。 */
const INSERT_COLUMNS = [
    "tenant_id",
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
/**
 * 由白名单行构建参数化 INSERT。列名来自固定白名单（非用户输入，无注入风险）；
 * tenant_id/event_id 显式 ::uuid 转换；seq 不在列清单，靠 DEFAULT nextval 分配。
 */
function buildInsert(row) {
    const cols = [];
    const exprs = [];
    const values = [];
    for (const col of INSERT_COLUMNS) {
        const v = row[col];
        if (v === undefined)
            continue; // 未出现字段不落（NULL 靠列缺省）
        cols.push(col);
        values.push(v);
        const ph = `$${values.length}`;
        exprs.push(col === "tenant_id" || col === "event_id" ? `${ph}::uuid` : ph);
    }
    const sql = `INSERT INTO pt_events (${cols.join(", ")}) ` +
        `VALUES (${exprs.join(", ")}) ` +
        `ON CONFLICT (tenant_id, event_id) DO NOTHING`;
    return { sql, values };
}
/**
 * 单条落库（§1.1 ④⑤ / §4.2）。事务内：
 *   1. set_config('app.current_tenant_id', $1, true) —— 等价于 SET LOCAL，事务内生效、
 *      结束自动复位（§4.2）；tenant 只取 envelope，绝不读事件体。
 *   2. INSERT … ON CONFLICT (tenant_id, event_id) DO NOTHING —— 幂等，冲突不报错；
 *      seq 由 DEFAULT nextval('pt_events_seq') 自动分配（§1.3），worker 不生成。
 * 只 INSERT、绝不 UPDATE/DELETE（append-only，§7）。
 */
async function ingestOne(pool, envelope) {
    // ① tenant 只认 envelope（§4.1）；非 UUID fail-fast（否则 RLS 的 ::uuid 会抛错）。
    const tenantId = envelope.tenant_id;
    if (!(0, validate_1.isUuid)(tenantId)) {
        throw new PermanentEventError(`envelope.tenant_id 非法（非 UUID）：${String(tenantId).slice(0, 32)}`);
    }
    // ② 归一化 + 脱敏（§6）；③ tenant 强制注入，忽略事件体内任何 tenant_id。
    const row = normalizeEvent(envelope.event);
    row.tenant_id = tenantId;
    const { sql, values } = buildInsert(row);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        try {
            // ④ RLS 上下文（SET LOCAL 语义，§4.2）
            await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
            // ⑤ 幂等 INSERT；seq 由 DB 序列分配
            const res = await client.query(sql, values);
            await client.query("COMMIT");
            return { inserted: res.rowCount === 1 };
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
/** 指数退避 + 随机抖动（§5.2）：min(2^attempt × 200ms, 30s) × (1 + rand(0..0.3))。 */
function backoffDelay(attempt) {
    const base = Math.min(Math.pow(2, attempt) * 200, 30000);
    return Math.round(base * (1 + Math.random() * 0.3));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * 落库 worker（§1.1 / §1.3）。
 * - 单写者串行：同一时刻只有一条 INSERT 在事务中，前一条 COMMIT 后才处理下一条，
 *   保证 COMMIT 顺序 == seq 分配顺序（§1.3 硬前提）。
 * - 只有「落库成功」或「确认重复」才 ACK；永久失败/重试耗尽写 DLQ 后再 ACK（§5.4）。
 */
function createIngestWorker(options) {
    const { pool, dequeue, ack, moveToDlq, maxAttempts = 5, pollIntervalMs = 500, signal, logger = console, } = options;
    const stats = {
        inserted: 0,
        duplicated: 0,
        failedPermanent: 0,
        failedRetryExhausted: 0,
    };
    async function processOne(msg) {
        const eventId = (0, validate_1.tryExtractEventId)(msg.envelope.event);
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await ingestOne(pool, msg.envelope);
                if (res.inserted)
                    stats.inserted += 1;
                else
                    stats.duplicated += 1;
                await ack(msg); // ⑥ 成功/去重均 ACK
                return;
            }
            catch (err) {
                lastErr = err;
                const cls = classifyError(err);
                if (cls === "duplicate") {
                    // 正常路径被 ON CONFLICT 消化，不会走到这；兜底按成功 ACK（§2.2）
                    stats.duplicated += 1;
                    logger.warn({ event_id: eventId, err }, "unexpected duplicate, ack");
                    await ack(msg);
                    return;
                }
                if (cls === "permanent") {
                    stats.failedPermanent += 1;
                    logger.error({ event_id: eventId, err }, "permanent failure -> DLQ");
                    await moveToDlq(msg, err); // §5.3：先写 DLQ 成功，再 ACK 原消息
                    await ack(msg);
                    return;
                }
                // 可重试：退避后重试
                logger.warn({ event_id: eventId, attempt, err }, "retryable failure, will retry");
                if (attempt < maxAttempts)
                    await sleep(backoffDelay(attempt));
            }
        }
        stats.failedRetryExhausted += 1;
        logger.error({ event_id: eventId, err: lastErr }, "retry exhausted -> DLQ");
        await moveToDlq(msg, lastErr);
        await ack(msg);
    }
    async function run() {
        while (!signal?.aborted) {
            let msg;
            try {
                msg = await dequeue();
            }
            catch (err) {
                logger.error({ err }, "dequeue failed");
                await sleep(pollIntervalMs);
                continue;
            }
            if (!msg) {
                await sleep(pollIntervalMs);
                continue;
            }
            // 单写者串行：await 前一条完整落库（含 COMMIT）后才取/处理下一条（§1.3）
            await processOne(msg);
        }
        logger.info({ stats }, "ingest worker stopped");
    }
    return { run, stats };
}
/**
 * 进程内存队列（尖刀最简兜底）。dequeue 直接 shift（取即消费），ack 为 no-op；
 * 生产替换为 Redis Stream：XREAD（单消费者串行）取、XACK 确认、XADD 写 pt-dlq。
 */
function createInMemoryIngestQueue() {
    const pending = [];
    const dead = [];
    let seq = 0;
    return {
        enqueue: async (envelope) => {
            pending.push({ id: String((seq += 1)), envelope });
            return true;
        },
        dequeue: async () => pending.shift() ?? null,
        ack: async () => {
            /* shift 即消费，ack 为 no-op */
        },
        moveToDlq: async (msg) => {
            dead.push(msg);
        },
        pendingCount: () => pending.length,
        deadCount: () => dead.length,
        drainDead: () => dead.splice(0, dead.length),
    };
}
// ---------------------------------------------------------------------------
// 连接池 / 可运行入口
// ---------------------------------------------------------------------------
/** 建 pg 连接池（DI：测试可注入 fake，生产用 DATABASE_URL）。 */
function createPool(databaseUrl) {
    return new pg_1.Pool({ connectionString: databaseUrl });
}
/** 运行 worker 直到 signal 中止，返回累计统计（用于测试/一次性消费）。 */
async function runIngestWorker(options) {
    const worker = createIngestWorker(options);
    await worker.run();
    return worker.stats;
}
//# sourceMappingURL=ingest.js.map