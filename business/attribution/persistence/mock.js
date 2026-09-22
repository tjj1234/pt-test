"use strict";
/**
 * A2 · Mock Repository（单测 / A8 前临时；禁止第二套真实 DB 连接）
 */
function createMockPersistence() {
  const rawEvents = [];
  const dlq = [];
  let rawSeq = 0;
  let dlqSeq = 0;

  return {
    kind: "mock",
    async ensureSchema() {
      return true;
    },
    async insertRawEvent(row) {
      const id = (rawSeq += 1);
      const rec = {
        id,
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        eventId: row.eventId || null,
        webhookId: row.webhookId || null,
        receivedAt: row.receivedAt || new Date().toISOString(),
        rawEvent: row.rawEvent,
        parseStatus: row.parseStatus || "received",
        requestId: row.requestId || null,
      };
      // 幂等：(tenantId, eventId)
      if (rec.eventId) {
        const dup = rawEvents.find(
          (r) => r.tenantId === rec.tenantId && r.eventId === rec.eventId
        );
        if (dup) return { id: dup.id, inserted: false };
      }
      rawEvents.push(rec);
      return { id, inserted: true };
    },
    async insertDlq(row) {
      const id = (dlqSeq += 1);
      const rec = {
        id,
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        eventId: row.eventId || null,
        webhookId: row.webhookId || null,
        reason: row.reason,
        errorClass: row.errorClass || "permanent",
        rawEvent: row.rawEvent,
        envelope: row.envelope || null,
        attempts: row.attempts || 0,
        createdAt: row.createdAt || new Date().toISOString(),
        resolvedAt: null,
        resolution: null,
      };
      dlq.push(rec);
      return { id, inserted: true };
    },
    async listDlq(ctx, opts = {}) {
      assertContext(ctx);
      const limit = Math.min(Number(opts.limit) || 50, 200);
      const openOnly = opts.openOnly !== false;
      return dlq
        .filter((r) => r.tenantId === ctx.tenantId)
        .filter((r) => (openOnly ? !r.resolvedAt : true))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    async getRawEvent(ctx, eventId) {
      assertContext(ctx);
      return (
        rawEvents.find((r) => r.tenantId === ctx.tenantId && r.eventId === eventId) || null
      );
    },
    async listRawEvents(ctx, opts = {}) {
      assertContext(ctx);
      const limit = Math.min(Number(opts.limit) || 50, 200);
      return rawEvents
        .filter((r) => r.tenantId === ctx.tenantId)
        .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
        .slice(0, limit);
    },
    _dump() {
      return { rawEvents: [...rawEvents], dlq: [...dlq] };
    },
  };
}

function assertContext(ctx) {
  if (!ctx || !ctx.tenantId || !ctx.workspaceId) {
    throw Object.assign(new Error("AttributionContext 必填（tenantId/workspaceId）"), {
      code: "CONTEXT_REQUIRED",
    });
  }
}

module.exports = { createMockPersistence, assertContext };
