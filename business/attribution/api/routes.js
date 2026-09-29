"use strict";
/**
 * A19 · 归因结果 REST（挂在 analytics 统一服务）
 * 端点对齐旧 /api/analytics/funnel，前缀改为 /api/attribution/*，不删老路由。
 */
const { isUuid } = require("../contracts/validate");
const { createAttributionApi } = require("./service");

function mapErrorStatus(err) {
  const code = err && err.code;
  if (code === "CONTEXT_REQUIRED") return 401;
  if (code === "BAD_RANGE") return 400;
  if (code === "FORBIDDEN") return 403;
  return 500;
}

function registerAttributionApiRoutes(app, opts = {}) {
  const {
    verifyAnalyticsToken,
    resolveWorkspaceId,
    parseAuthorization,
    pool,
    now = Date.now,
    attributionApi = createAttributionApi({ pool, ...opts }),
  } = opts;

  async function authContext(request, reply) {
    const raw = request.headers.authorization;
    const parsedAuth =
      typeof parseAuthorization === "function"
        ? parseAuthorization(raw)
        : typeof raw === "string" && raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (typeof parsedAuth !== "string" || parsedAuth.length === 0) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "unauthorized" } });
    }
    let auth;
    try {
      auth = await verifyAnalyticsToken(parsedAuth);
    } catch (err) {
      request.log.error({ err }, "attribution api token verify failed");
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
    }
    if (!auth) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
    }
    if (auth.expires_at != null && auth.expires_at <= now()) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "unauthorized" } });
    }
    if (!Array.isArray(auth.scopes) || !auth.scopes.includes("analytics:read")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
    }
    const tenantId = auth.tenant_id;
    if (!isUuid(tenantId)) {
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
    }
    let workspaceId;
    try {
      workspaceId = await resolveWorkspaceId(tenantId);
    } catch (err) {
      request.log.error({ err, tenant_id: tenantId }, "resolveWorkspaceId failed");
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
    }
    if (!workspaceId) {
      return reply.code(403).send({ error: { code: "NO_WORKSPACE", message: "no workspace" } });
    }
    return { tenantId, workspaceId, actorId: auth.label || null };
  }

  async function handle(fn, request, reply) {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    try {
      const body = await fn(ctx, request.query || {});
      return reply.code(200).send(body);
    } catch (err) {
      const status = mapErrorStatus(err);
      if (status >= 500) request.log.error({ err }, "attribution api failed");
      return reply.code(status).send({
        error: {
          code: err.code || (status === 400 ? "INVALID_QUERY" : "INTERNAL_ERROR"),
          message: err.message || "internal error",
        },
      });
    }
  }

  // 与旧 GET /api/analytics/funnel 字段对齐（groups + roi_by_entity）
  app.get("/api/attribution/funnel", (req, reply) =>
    handle(attributionApi.funnel, req, reply)
  );

  app.get("/api/attribution/creatives", (req, reply) =>
    handle(attributionApi.creatives, req, reply)
  );

  app.get("/api/attribution/events", (req, reply) =>
    handle(attributionApi.events, req, reply)
  );

  app.get("/api/attribution/health", (req, reply) =>
    handle(attributionApi.health, req, reply)
  );

  app.get("/api/attribution/roi", (req, reply) =>
    handle(attributionApi.creativeRoi, req, reply)
  );

  return { attributionApi };
}

module.exports = { registerAttributionApiRoutes };
