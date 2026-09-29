"use strict";
/**
 * 北极星项目 · 数据接入层 · 单元 1.2 Webhook 接收服务 —— 事件体校验 + 白名单
 *
 * 依据：
 *   《北极星开发/1-数据接入/1.2-Webhook接收服务.md》§1.2 请求体 / 接收层字段校验边界
 *   《接口契约-北极星-v1.0.md》§1 事件 Schema
 *
 * 校验边界（只卡「幂等 + 路由必需」三件套，其余一律宽松透传）：
 *   event_id   必填 · 合法 UUID 字符串（幂等键）
 *   event_name 必填 · 在 6 事件白名单内
 *   timestamp  必填 · int64 epoch 毫秒，合法非负整数（拒绝非数字 / 负值 / NaN / 小数）
 *   其余字段   不校验 · 原样透传（类型清洗 / 归一化 / 脱敏交给 1.3 落库层）
 *
 * 铁律：
 *   - 只校验、不改写事件体；不编造字段、不补默认值、不删未知字段。
 *   - 本文件绝不读取 / 使用事件体内的任何身份字段（含 tenant_id / user_id），
 *     租户归属由 server.ts 的 Secret 反查强制注入，本层不碰。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_WHITELIST = void 0;
exports.isUuid = isUuid;
exports.isEventName = isEventName;
exports.isTimestampMs = isTimestampMs;
exports.validateEvent = validateEvent;
exports.tryExtractEventId = tryExtractEventId;
// ---------------------------------------------------------------------------
// 6 事件白名单（§1.2 表，对齐接口契约 §1.2）
// ---------------------------------------------------------------------------
exports.EVENT_WHITELIST = [
    "visit",
    "signup",
    "key_created",
    "model_call",
    "recharge",
    "auto_recharge_toggle",
];
// ---------------------------------------------------------------------------
// 三件套字段校验原语
// ---------------------------------------------------------------------------
/** 合法 UUID 字符串（8-4-4-4-12，大小写十六进制均可，与示例 7f9c24a0-… 一致）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** event_id 是否为合法 UUID 字符串。 */
function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
}
/** event_name 是否在 6 事件白名单内。 */
function isEventName(value) {
    return (typeof value === "string" &&
        exports.EVENT_WHITELIST.includes(value));
}
/**
 * timestamp 是否为合法 int64 epoch 毫秒。
 * 规则（§1.2 表）：拒绝非数字 / 负值；同时拒绝 NaN/Infinity/小数（int64 必为整数）。
 */
function isTimestampMs(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
// ---------------------------------------------------------------------------
// 主校验：validateEvent(body)
// ---------------------------------------------------------------------------
/**
 * 校验事件体（§1.2 接收层字段校验边界）。
 *
 * 只卡三件套 + 6 白名单；其余字段宽松透传、不做强类型校验。
 * 校验通过返回 ok=true，失败返回 ok=false 且带逐字段 errors。
 * 本函数不修改入参对象，也不产出「裁剪后」的新事件体——透传由调用方持有原 body。
 *
 * @param body Fastify 解析后的 JSON body（应为对象）
 */
function validateEvent(body) {
    const errors = [];
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return {
            ok: false,
            errors: [{ field: "body", message: "事件体必须是 JSON 对象" }],
            event: null,
        };
    }
    const record = body;
    const eventId = record["event_id"];
    if (!isUuid(eventId)) {
        errors.push({
            field: "event_id",
            message: "event_id 缺失或不是合法 UUID 字符串",
        });
    }
    const eventName = record["event_name"];
    if (!isEventName(eventName)) {
        errors.push({
            field: "event_name",
            message: `event_name 缺失或不在白名单内（允许：${exports.EVENT_WHITELIST.join("/")}）`,
        });
    }
    const timestamp = record["timestamp"];
    if (!isTimestampMs(timestamp)) {
        errors.push({
            field: "timestamp",
            message: "timestamp 缺失或非法（需 int64 epoch 毫秒，非负整数）",
        });
    }
    if (errors.length > 0) {
        return { ok: false, errors, event: null };
    }
    return {
        ok: true,
        errors: [],
        event: {
            event_id: eventId,
            event_name: eventName,
            timestamp: timestamp,
        },
    };
}
// ---------------------------------------------------------------------------
// 排障辅助：尽量从事件体回显 event_id（§4.2 错误体）
// ---------------------------------------------------------------------------
/**
 * 从（可能已解析失败的）body 里尽量取出字符串 event_id 用于错误回显。
 * 取不到返回 undefined；不抛异常。
 */
function tryExtractEventId(body) {
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const id = body["event_id"];
        if (typeof id === "string" && id.length > 0)
            return id;
    }
    return undefined;
}
//# sourceMappingURL=validate.js.map