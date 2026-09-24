"use strict";
/**
 * A17 · Fastify 路由（挂在 analytics 统一服务；不碰 collect/）
 */
const { createIngestionAdapter } = require("./service");
const { isUuid } = require("../contracts/invariants");

function registerIngestionAdapterRoutes(app, opts = {}) {
  const {
    verifyAnalyticsToken,
    resolveWorkspaceId,
    parseAuthorization,
    adapter = createIngestionAdapter(opts),
  } = opts;

  async function authContext(request, reply) {
    const raw = request.headers.authorization;
    const parsedAuth =
      typeof parseAuthorization === "function"
        ? parseAuthorization(raw)
        : { ok: typeof raw === "string" && raw.startsWith("Bearer "), token: raw && raw.slice(7) };
    if (!parsedAuth || !parsedAuth.ok) {
      return reply.code(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "missing token" } });
    }
    const auth = await verifyAnalyticsToken(parsedAuth.token);
    if (!auth) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "invalid token" } });
    }
    const tenantId = auth.tenant_id;
    if (!isUuid(tenantId)) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "bad tenant" } });
    }
    const workspaceId = await resolveWorkspaceId(tenantId);
    if (!workspaceId) {
      return reply.code(403).send({
        ok: false,
        error: { code: "NO_WORKSPACE", message: "tenant has no workspace mapping" },
      });
    }
    return { tenantId, workspaceId, actorId: auth.label || null };
  }

  app.get("/api/business/attribution/ingestion/mapping", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    return { ok: true, mapping: adapter.getMapping(ctx.workspaceId) };
  });

  app.put("/api/business/attribution/ingestion/mapping", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const body = request.body || {};
    try {
      const mapping = adapter.putMapping(ctx.workspaceId, body.mappings || {}, ctx.actorId);
      return { ok: true, mapping };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: err.code || "BAD_MAPPING", message: err.message },
      });
    }
  });

  app.post("/api/business/attribution/ingestion/adapt", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const body = request.body || {};
    const raw = body.event || body;
    const result = adapter.adapt(ctx.workspaceId, raw);
    if (result.ignored) return { ok: true, ignored: true, quality: result.quality };
    if (!result.ok) {
      return reply.code(422).send({
        ok: false,
        error: result.error,
        quality: result.quality,
      });
    }
    return { ok: true, event: result.event, quality: result.quality };
  });

  app.post("/api/business/attribution/ingestion/connection-test", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const body = request.body || {};
    const result = await adapter.testConnection(ctx.workspaceId, {
      collectUrl: body.collectUrl,
      secret: body.secret,
      event: body.event,
      probeEventName: body.probeEventName,
    });
    return reply.code(result.ok ? 200 : 200).send({ ok: result.ok, ...result });
  });

  app.get("/api/business/attribution/ingestion/quality-stats", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    return { ok: true, stats: adapter.getQualityStats(ctx.workspaceId) };
  });

  return { adapter };
}

module.exports = { registerIngestionAdapterRoutes };
