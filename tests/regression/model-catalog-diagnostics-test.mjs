import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const catalog = require("../../shell/model-catalog.cjs");

test("model catalog reports a bounded upstream HTTP failure while keeping routing unknown", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-catalog-diag-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const result = await catalog.getCatalog({
    apiKey: "fixture-secret-not-returned",
    scopeId: "fixture-user",
    baseURL: "https://catalog.invalid/v1",
    cacheDir,
    force: true,
    now: Date.now(),
    fallback: [{ id: "glm-5", supported_endpoint_types: ["openai"] }],
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });

  assert.equal(result.availability.status, "unknown");
  assert.equal(result.catalogDiagnostics.state, "sync_failed");
  assert.equal(result.catalogDiagnostics.errorCode, "PT_HTTP_ERROR");
  assert.equal(result.catalogDiagnostics.upstreamStatus, 401);
  assert.equal(result.catalogDiagnostics.modelCount, 1);
  assert.equal(JSON.stringify(result.catalogDiagnostics).includes("fixture-secret"), false);
});

test("model catalog distinguishes invalid JSON and network failures without exposing raw errors", async () => {
  const invalid = await catalog.fetchPtSnapshot({
    apiKey: "fixture-secret",
    baseURL: "https://catalog.invalid/v1",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("body contains fixture-secret"); } }),
  });
  assert.equal(invalid.errorCode, "PT_INVALID_RESPONSE");
  assert.equal(invalid.status, 200);
  assert.equal(JSON.stringify(invalid).includes("fixture-secret"), false);

  const network = await catalog.fetchPtSnapshot({
    apiKey: "fixture-secret",
    baseURL: "https://catalog.invalid/v1",
    fetchImpl: async () => { throw new Error("request included fixture-secret"); },
  });
  assert.equal(network.errorCode, "PT_NETWORK_ERROR");
  assert.equal(JSON.stringify(network).includes("fixture-secret"), false);
});

test("model catalog reports empty or unrecognized response envelopes", async () => {
  const result = await catalog.fetchPtSnapshot({
    apiKey: "fixture-secret",
    baseURL: "https://catalog.invalid/v1",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: "glm-5" }] }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PT_EMPTY_OR_UNRECOGNIZED_RESPONSE");
});
