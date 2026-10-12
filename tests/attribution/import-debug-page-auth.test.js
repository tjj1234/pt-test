"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fastify = require("../../analytics/node_modules/fastify");
const { parseAuthorization } = require("../../analytics/backend/events/query.js");
const { registerImportRoutes } = require("../../business/attribution/import/routes");

test("debug page and import APIs share authentication; authorized APIs retain behavior", async () => {
  const app = fastify();
  const tenantId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const result = { importId: "job-1", status: "ready" };
  const service = {};
  for (const method of ["listJobs", "getJob", "createAndValidate", "confirmImport", "getWorkspaceMeta", "markConnected"]) {
    service[method] = (ctx) => {
      assert.equal(ctx.tenantId, tenantId);
      assert.equal(ctx.workspaceId, "ws-test");
      calls.push(method);
      return method === "listJobs" ? [result] : result;
    };
  }
  registerImportRoutes(app, {
    parseAuthorization,
    now: () => 1000,
    verifyAnalyticsToken: async (token) => {
      if (token === "invalid") return null;
      return { tenant_id: token === "bad-tenant" ? "bad" : tenantId,
        label: token, expires_at: token === "expired" ? 1000 : 2000 };
    },
    resolveWorkspaceId: async () => "ws-test",
    importService: service,
  });
  const base = "/api/business/attribution/import";
  const routes = [
    ["GET", base], ["GET", base + "/jobs"],
    ["GET", base + "/jobs/job-1"], ["POST", base + "/jobs"],
    ["POST", base + "/jobs/job-1/confirm"],
    ["GET", base + "/workspace"], ["POST", base + "/workspace/connected"],
  ];
  try {
    for (const [method, url] of routes) {
      for (const [authorization, expected] of [
        [undefined, 401], ["Basic abc", 401], ["Bearer ", 401],
        ["Bearer invalid", 403], ["Bearer expired", 401], ["Bearer bad-tenant", 403],
      ]) {
        const response = await app.inject({ method, url,
          headers: authorization ? { authorization } : {} });
        assert.equal(response.statusCode, expected, `${method} ${url}: ${authorization}`);
        assert.doesNotMatch(response.headers["content-type"], /text\/html/);
      }
    }
    assert.deepEqual(calls, [], "unauthorized requests never reach import service");
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, headers: { authorization: "Bearer valid" } });
      assert.equal(response.statusCode, method === "POST" && url === base + "/jobs" ? 201 : 200);
      if (url === base) {
        assert.match(response.headers["content-type"], /text\/html/);
        assert.match(response.body, /<!doctype html>/i);
      } else {
        const key = url.endsWith("/jobs") && method === "GET" ? "jobs" : url.includes("/workspace") ? "workspace" : "job";
        assert.deepEqual(response.json(), { ok: true, [key]: key === "jobs" ? [result] : result });
      }
    }
    assert.equal(calls.length, 6);
  } finally {
    await app.close();
  }
});
