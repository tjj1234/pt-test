"use strict";
/**
 * A2 · 事件归一 + Collect 队列包装（不修改 collect/ingest.js 源码）
 */
const { isUuid, isEventName, assertCanonicalEvent } = require("../contracts/validate");

function pick(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  const v = obj[key];
  return v === undefined || v === null || v === "" ? null : v;
}

/**
 * envelope + Context → CanonicalEvent（raw 与标准字段分离）
 * tenantId / workspaceId 只认 Context / envelope.tenant_id，不读 body.tenant_id
 */
function toCanonicalEvent({ context, envelope, receivedAt }) {
  if (!context || !context.tenantId || !context.workspaceId) {
    throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
  }
  const body = (envelope && envelope.event) || {};
  const tenantId = context.tenantId;
  if (envelope && envelope.tenant_id && envelope.tenant_id !== tenantId) {
    throw Object.assign(new Error("envelope.tenant_id 与 Context 不一致"), {
      code: "TENANT_MISMATCH",
    });
  }
  const eventId = pick(body, "event_id");
  const eventName = pick(body, "event_name");
  const timestamp = body.timestamp;

  const canonical = {
    tenantId,
    workspaceId: context.workspaceId,
    eventId,
    eventName,
    timestamp,
    visitorId: pick(body, "visitor_id"),
    userId: pick(body, "user_id"),
    sessionId: pick(body, "session_id"),
    utmSource: pick(body, "utm_source"),
    utmMedium: pick(body, "utm_medium"),
    utmCampaign: pick(body, "utm_campaign"),
    utmContent: pick(body, "utm_content"),
    utmTerm: pick(body, "utm_term"),
    country: pick(body, "country"),
    amount: typeof body.amount === "number" ? body.amount : null,
    currency: pick(body, "currency"),
    model: pick(body, "model"),
    totalTokens: Number.isInteger(body.total_tokens) ? body.total_tokens : null,
    rawEvent: typeof body === "object" && body && !Array.isArray(body) ? { ...body } : {},
    receivedAt: receivedAt || new Date().toISOString(),
    webhookId: (envelope && envelope.webhook_id) || context.webhookId || null,
  };
  return canonical;
}

/**
 * 包装既有内存队列：enqueue 时写 raw；moveToDlq 时持久化死信。
 * 不替换 ingest worker 实现。
 */
function wrapIngestQueueWithPersistence(queue, persistence, options = {}) {
  if (!queue || !persistence) throw new Error("queue 与 persistence 必填");
  const resolveWorkspace =
    options.resolveWorkspace ||
    ((tenantId) => {
      if (options.workspaceId) return options.workspaceId;
      throw Object.assign(new Error("无法解析 workspaceId"), { code: "WORKSPACE_UNRESOLVED" });
    });

  const origEnqueue = queue.enqueue.bind(queue);
  const origMove = queue.moveToDlq.bind(queue);

  return {
    enqueue: async (envelope) => {
      const tenantId = envelope && envelope.tenant_id;
      if (!isUuid(tenantId)) {
        // 与主干一致：非法租户不写业务 raw（由上层拒）
        return origEnqueue(envelope);
      }
      const workspaceId = await resolveWorkspace(tenantId);
      if (workspaceId) {
        const body = (envelope && envelope.event) || {};
        const eventId = typeof body.event_id === "string" ? body.event_id : null;
        await persistence.insertRawEvent({
          tenantId,
          workspaceId,
          eventId: eventId && isUuid(eventId) ? eventId : null,
          webhookId: envelope.webhook_id || null,
          rawEvent: body && typeof body === "object" ? body : {},
          parseStatus: "received",
          requestId: options.requestId || null,
        });
      }
      return origEnqueue(envelope);
    },
    dequeue: queue.dequeue.bind(queue),
    ack: queue.ack.bind(queue),
    moveToDlq: async (msg, err) => {
      const envelope = msg && msg.envelope;
      const tenantId = envelope && envelope.tenant_id;
      const body = (envelope && envelope.event) || {};
      if (isUuid(tenantId)) {
        let workspaceId = options.workspaceId;
        try {
          workspaceId = workspaceId || (await resolveWorkspace(tenantId));
        } catch {
          workspaceId = "ws_unresolved";
        }
        const eventId = typeof body.event_id === "string" && isUuid(body.event_id) ? body.event_id : null;
        await persistence.insertDlq({
          tenantId,
          workspaceId: workspaceId || "ws_unresolved",
          eventId,
          webhookId: envelope.webhook_id || null,
          reason: err && err.message ? String(err.message) : String(err || "unknown"),
          errorClass:
            err && err.name === "PermanentEventError"
              ? "permanent"
              : "retry_exhausted",
          rawEvent: body && typeof body === "object" ? body : {},
          envelope: {
            tenant_id: tenantId,
            webhook_id: envelope.webhook_id || null,
          },
          attempts: options.attempts || 0,
        });
      }
      return origMove(msg, err);
    },
    pendingCount: queue.pendingCount ? queue.pendingCount.bind(queue) : undefined,
    deadCount: queue.deadCount ? queue.deadCount.bind(queue) : undefined,
    drainDead: queue.drainDead ? queue.drainDead.bind(queue) : undefined,
  };
}

/**
 * 校验失败事件直接进可查 DLQ（接收层拒收，不经 worker）
 */
async function recordValidationFailure(persistence, context, body, errors) {
  if (!context || !context.tenantId || !context.workspaceId) {
    throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
  }
  const eventId =
    body && typeof body.event_id === "string" && isUuid(body.event_id) ? body.event_id : null;
  await persistence.insertRawEvent({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    eventId,
    webhookId: context.webhookId || null,
    rawEvent: body && typeof body === "object" ? body : {},
    parseStatus: "rejected",
  });
  return persistence.insertDlq({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    eventId,
    webhookId: context.webhookId || null,
    reason: Array.isArray(errors)
      ? errors.map((e) => (e.message || e.reason || JSON.stringify(e))).join("; ")
      : String(errors || "validation_failed"),
    errorClass: "validation",
    rawEvent: body && typeof body === "object" ? body : {},
  });
}

module.exports = {
  toCanonicalEvent,
  wrapIngestQueueWithPersistence,
  recordValidationFailure,
  isUuid,
  isEventName,
  assertCanonicalEvent,
};
