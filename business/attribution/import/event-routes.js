"use strict";
/**
 * A18 · Fastify 插件：事件 CSV 导入 API
 * tenant 只从鉴权派生，不信任 body.tenantId。
 */
const { isUuid } = require("../contracts/validate");
const { createEventImportService } = require("./event-service");

function registerEventImportRoutes(app, opts = {}) {
  const {
    verifyAnalyticsToken,
    resolveWorkspaceId,
    parseAuthorization,
    now = Date.now,
    pool,
    eventImportService = createEventImportService({ ...opts, pool }),
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
    if (auth.expires_at != null && auth.expires_at <= now()) {
      return reply.code(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "expired token" } });
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

  const base = "/api/business/attribution/event-import";

  app.get(`${base}/jobs`, async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    return { ok: true, jobs: await eventImportService.listJobs(ctx, 50) };
  });

  app.get(`${base}/jobs/:importId`, async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const job = await eventImportService.getJob(ctx, request.params.importId);
    if (!job) {
      return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "job not found" } });
    }
    return { ok: true, job };
  });

  app.post(`${base}/jobs`, async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const body = request.body || {};
    if (body.tenantId || body.tenant_id) {
      return reply.code(400).send({
        ok: false,
        error: { code: "CLIENT_TENANT_REJECTED", message: "do not send tenantId" },
      });
    }
    try {
      const job = await eventImportService.createAndValidate(ctx, {
        originalName: body.originalName || body.filename,
        contentBase64: body.contentBase64,
        idempotencyKey: body.idempotencyKey,
        mapping: body.mapping,
      });
      return reply.code(201).send({ ok: true, job });
    } catch (err) {
      const code = err && err.code ? err.code : "BAD_REQUEST";
      const status = code === "CONTEXT_REQUIRED" ? 401 : 400;
      return reply.code(status).send({
        ok: false,
        error: { code, message: err && err.message ? err.message : String(err) },
      });
    }
  });

  app.post(`${base}/jobs/:importId/confirm`, async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    try {
      const job = await eventImportService.confirmImport(
        ctx,
        request.params.importId,
        (request.body && request.body.mapping) || undefined
      );
      if (!job) {
        return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "job not found" } });
      }
      return { ok: true, job };
    } catch (err) {
      const code = err && err.code ? err.code : "BAD_REQUEST";
      return reply.code(400).send({
        ok: false,
        error: { code, message: err && err.message ? err.message : String(err) },
      });
    }
  });

  app.get(`${base}/template.csv`, async (_request, reply) => {
    const csv = [
      "event_name,user_id,event_time,visitor_id,utm_source,utm_medium,utm_campaign,utm_content,amount,currency",
      "page_view,usr_demo,2026-09-10 12:00:00,vis_demo,facebook,cpc,camp_demo,ad_demo,,",
      "CompleteRegistration,usr_demo,2026-09-10 12:01:00,vis_demo,facebook,cpc,camp_demo,ad_demo,,",
      "recharge,usr_demo,2026-09-10 12:05:00,vis_demo,facebook,cpc,camp_demo,ad_demo,99,USD",
    ].join("\n");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="event-import-template.csv"')
      .send(csv);
  });

  return { eventImportService };
}

module.exports = { registerEventImportRoutes };
