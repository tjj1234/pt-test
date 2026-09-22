"use strict";
/**
 * A9 · Fastify 插件：导入页 + API（挂在 analytics 统一服务）
 * tenant 只从鉴权派生（token / 可信头），不信任 body.tenantId。
 */
const fs = require("node:fs");
const path = require("node:path");
const { isUuid } = require("../contracts/validate");
const { createImportService } = require("./service");

const PAGE_PATH = path.join(__dirname, "page.html");

function registerImportRoutes(app, opts = {}) {
  const {
    verifyAnalyticsToken,
    resolveWorkspaceId,
    parseAuthorization,
    importService = createImportService(opts),
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

  app.get("/api/business/attribution/import", async (_req, reply) => {
    const html = fs.readFileSync(PAGE_PATH, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/business/attribution/import/jobs", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const jobs = importService.listJobs(ctx, 50);
    return { ok: true, jobs };
  });

  app.get("/api/business/attribution/import/jobs/:importId", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    const job = importService.getJob(ctx, request.params.importId);
    if (!job) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "job not found" } });
    return { ok: true, job };
  });

  app.post("/api/business/attribution/import/jobs", async (request, reply) => {
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
      const job = await importService.createAndValidate(ctx, {
        provider: body.provider,
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

  app.post("/api/business/attribution/import/jobs/:importId/confirm", async (request, reply) => {
    const ctx = await authContext(request, reply);
    if (reply.sent) return;
    try {
      const job = await importService.confirmImport(
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

  return { importService };
}

module.exports = { registerImportRoutes };
