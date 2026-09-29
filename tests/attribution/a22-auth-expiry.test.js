"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fastify = require("../../analytics/node_modules/fastify");
const { createPgCompatPool, sha256Hex } = require("../../analytics/lib/db.cjs");
const { createTokenVerifier, insertAnalyticsToken } = require("../../analytics/lib/deps.cjs");
const { buildQueryServer, parseAuthorization } = require("../../analytics/backend/events/query.js");
const { registerImportRoutes } = require("../../business/attribution/import/routes");
const { registerEventImportRoutes } = require("../../business/attribution/import/event-routes");
const { registerIngestionAdapterRoutes } = require("../../business/attribution/ingestion-adapter/routes");

const TENANT = "22222222-2222-4222-8222-222222222222";

async function expectExpiredToken401(name, register, url, extra, verifyAnalyticsToken) {
  const app = fastify({ logger: false });
  let workspaceLookups = 0;
  register(app, {
    parseAuthorization,
    verifyAnalyticsToken,
    resolveWorkspaceId: async () => {
      workspaceLookups += 1;
      return "ws_a22";
    },
    ...extra,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer expired-token" },
    });
    assert.equal(response.statusCode, 401, `${name} rejects expired token`);
    assert.equal(workspaceLookups, 0, `${name} stops before workspace lookup`);
  } finally {
    await app.close();
  }
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-a22-expired-db-"));
  const pool = await createPgCompatPool({
    dataDir,
    migrationsDir: path.join(__dirname, "../../analytics/backend/db"),
    deliveryMigrationsDir: path.join(__dirname, "../../analytics/schema"),
    recoverStalePidFile: true,
    log: () => {},
  });
  const token = "expired-token";
  await insertAnalyticsToken(pool, TENANT, token, "a22-expiry-test");
  await pool.query(
    "UPDATE analytics_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
    [sha256Hex(token)]
  );
  const verifier = createTokenVerifier(pool);

  try {
    const eventsApp = buildQueryServer({ pool, verifyAnalyticsToken: verifier, logger: false });
    const eventsResponse = await eventsApp.inject({
      method: "GET",
      url: "/api/analytics/events",
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(eventsResponse.statusCode, 401, "events route still rejects expired token");
    await eventsApp.close();

    await expectExpiredToken401(
      "import",
      registerImportRoutes,
      "/api/business/attribution/import/jobs",
      { importService: { listJobs: async () => [] } },
      verifier
    );
    await expectExpiredToken401(
      "event import",
      registerEventImportRoutes,
      "/api/business/attribution/event-import/jobs",
      { eventImportService: { listJobs: async () => [] } },
      verifier
    );
    await expectExpiredToken401(
      "ingestion adapter",
      registerIngestionAdapterRoutes,
      "/api/business/attribution/ingestion/mapping",
      { adapter: { getMapping: () => ({}) } },
      verifier
    );
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify({ ok: true, expiredTokenStatus: 401, routes: ["events", "import", "event-import", "ingestion-adapter"] }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
