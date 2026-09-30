"use strict";
/**
 * B12 · SS-GTM 原始事件接入路由（挂在 analytics 统一服务；不碰 collect/）
 *
 * 与 collect 的差异：collect 只收「已是白名单三件套」的规范化事件；本路由先经
 * A17 适配器把原始事件（如无 event_id 的 page_view）归一化，再走 collect 同一套
 * 三件套校验 + 同一入队管线。鉴权复用 webhook_endpoints + x-pt-webhook-secret，
 * 不要求 GTM 具备 Bearer token 能力。
 *
 * 复用契约：
 *   - secretMatches 由调用方（analytics/backend/server.js 统一入口）注入，不新增实现；
 *   - validateEvent / tryExtractEventId 只读引用 collect/validate.js，绝不修改。
 */
const { validateEvent, tryExtractEventId } = require("../../../analytics/backend/collect/validate");

function errorBody(code, message, eventId) {
  return eventId === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message }, event_id: eventId };
}

function registerRawIngestRoutes(app, opts = {}) {
  const { resolveEndpoint, secretMatches, resolveWorkspaceId, enqueue, adapter } = opts;

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "raw-collect request failed");
    const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
      ? error.statusCode
      : 500;
    const code = statusCode >= 500 ? "INTERNAL_ERROR" : "INVALID_EVENT";
    const message = statusCode >= 500 ? "internal error" : "bad request";
    reply
      .status(statusCode)
      .send(errorBody(code, message, tryExtractEventId(request.body)));
  });

  app.post("/api/v1/raw-collect/:webhook_id", async (request, reply) => {
    const { webhook_id } = request.params;
    const body = request.body;
    const receivedAt = Date.now();

    // ① Secret 鉴权 —— 缺 Secret 401
    const secretHeader = request.headers["x-pt-webhook-secret"];
    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    if (!secret) {
      return reply.status(401).send(errorBody("MISSING_SECRET", "unauthorized"));
    }

    // ② 端点反查（webhook_id → 端点记录）
    let endpoint = null;
    try {
      endpoint = await resolveEndpoint(webhook_id);
    } catch (err) {
      request.log.error({ err, webhook_id }, "endpoint lookup failed");
      return reply.status(500).send(errorBody("INTERNAL_ERROR", "internal error"));
    }
    if (!endpoint || endpoint.status !== "active") {
      return reply.status(403).send(errorBody("INVALID_SECRET", "unauthorized"));
    }

    // ③ 常量时间 Secret 比对（复用统一入口注入的 secretMatches）
    if (!secretMatches(secret, endpoint.secret_hash)) {
      return reply.status(403).send(errorBody("INVALID_SECRET", "unauthorized"));
    }

    // ④ workspace 反查（mapping store 以 workspace 为键）
    let workspaceId;
    try {
      workspaceId = await resolveWorkspaceId(endpoint.tenant_id);
    } catch (err) {
      request.log.error({ err, tenant_id: endpoint.tenant_id }, "resolveWorkspaceId failed");
      return reply.status(500).send(errorBody("INTERNAL_ERROR", "internal error"));
    }
    if (!workspaceId) {
      return reply.status(403).send({
        ok: false,
        error: { code: "NO_WORKSPACE", message: "tenant has no workspace mapping" },
      });
    }

    // ⑤ 前置格式校验：必须是 JSON 对象且 event_name 非空
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send(errorBody("INVALID_EVENT", "event body must be a JSON object"));
    }
    const rawName = body.event_name != null ? body.event_name : body.eventName;
    if (typeof rawName !== "string" || rawName.length === 0) {
      return reply.status(400).send(errorBody("INVALID_EVENT", "event_name is required"));
    }

    // ⑥ 原始事件 → A17 适配归一化
    let adapted;
    try {
      adapted = adapter.adapt(workspaceId, body, { receivedAtMs: receivedAt });
    } catch (err) {
      request.log.error({ err, tenant_id: endpoint.tenant_id }, "adapt failed");
      return reply.status(500).send(errorBody("INTERNAL_ERROR", "internal error"));
    }
    if (adapted.ignored) {
      return reply.status(200).send({ ok: true, ignored: true, quality: adapted.quality });
    }
    if (!adapted.ok || !adapted.event) {
      return reply.status(422).send({
        ok: false,
        error: adapted.error || { code: "UNMAPPED_EVENT_NAME", message: "event name unmapped" },
        quality: adapted.quality,
      });
    }

    // ⑦ 同一套三件套校验（collect 冻结契约）
    const validated = validateEvent(adapted.event);
    if (!validated.ok || !validated.event) {
      return reply.status(400).send({
        ok: false,
        error: { code: "INVALID_EVENT", message: "invalid event", details: validated.errors },
        event_id: tryExtractEventId(adapted.event),
      });
    }

    // ⑧ 入队（同一入队管线；tenant_id 由端点反查强制注入）
    const envelope = {
      tenant_id: endpoint.tenant_id,
      received_at: receivedAt,
      event: adapted.event,
    };
    let enqueued = false;
    try {
      enqueued = await enqueue(envelope);
    } catch (err) {
      request.log.error(
        { err, event_id: validated.event.event_id, tenant_id: endpoint.tenant_id },
        "enqueue failed"
      );
      enqueued = false;
    }
    if (!enqueued) {
      return reply
        .status(503)
        .send(errorBody("QUEUE_UNAVAILABLE", "queue unavailable", validated.event.event_id));
    }

    request.log.info(
      { event_id: validated.event.event_id, webhook_id, tenant_id: endpoint.tenant_id },
      "raw event accepted"
    );
    return reply.status(200).send({
      ok: true,
      event_id: validated.event.event_id,
      received_at: receivedAt,
    });
  });
}

module.exports = { registerRawIngestRoutes };
