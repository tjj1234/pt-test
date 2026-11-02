import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const catalog = require("../../shell/model-catalog.cjs");
const cache = require("../../shell/models/catalog-cache.cjs");
const capabilities = require("../../shell/models/capabilities.cjs");
const key = "failure-stage-fixture-secret";
const baseURL = "https://catalog.invalid/v1";
const response = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload });

async function rejectsAt(stage, invoke) {
  const observed = [];
  let failure;
  try { await invoke((value) => { observed.push(value); }); } catch (error) { failure = error; }
  assert.ok(failure instanceof TypeError, `expected TypeError, received ${failure?.name || "no error"}: ${failure?.stack || ""}`);
  assert.equal(observed.at(-1), stage, `failure must be attributed to ${stage}; observed ${observed.join(" -> ")}; ${failure.stack}`);
}

test("catalog internal failures report fixed stage labels without details", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "northstar-catalog-failure-stage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalResolve = cache.resolveScopeId;
  const originalRead = cache.readScopedCache;
  const originalWrite = cache.writeScopedCache;
  const originalMerge = capabilities.mergeSnapshot;
  const base = { apiKey: key, scopeId: "stage-user", baseURL, cacheDir: dir, now: Date.now(), force: true, fallback: [], fetchImpl: async () => response({ data: [{ id: "stage-model" }] }) };
  try {
    cache.resolveScopeId = () => { throw new TypeError("private scope detail"); };
    await rejectsAt("scope", (onCatalogStage) => catalog.getCatalog({ ...base, onCatalogStage }));
    cache.resolveScopeId = originalResolve;

    cache.readScopedCache = () => { throw new TypeError("private cache read detail"); };
    await rejectsAt("cache_read", (onCatalogStage) => catalog.getCatalog({ ...base, onCatalogStage }));
    cache.readScopedCache = originalRead;

    const invalidResponse = await catalog.getCatalog({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new TypeError("private response detail"); } }) });
    assert.equal(invalidResponse.catalogDiagnostics.errorCode, "PT_INVALID_RESPONSE");
    assert.equal(invalidResponse.catalogDiagnostics.failureStage, "fetch_or_parse");

    capabilities.mergeSnapshot = () => { throw new TypeError("private merge detail"); };
    await rejectsAt("merge", (onCatalogStage) => catalog.getCatalog({ ...base, onCatalogStage }));
    capabilities.mergeSnapshot = originalMerge;

    await catalog.getCatalog({ ...base, force: true });
    capabilities.mergeSnapshot = (_snapshot, input) => {
      if (input.success === false) throw new TypeError("private local update detail");
      return originalMerge(_snapshot, input);
    };
    await rejectsAt("local_update", (onCatalogStage) => catalog.getCatalog({ ...base, force: false, now: base.now + 1, permission: true, onCatalogStage }));
    capabilities.mergeSnapshot = originalMerge;

    cache.writeScopedCache = () => { throw new TypeError("private cache write detail"); };
    await rejectsAt("cache_write", (onCatalogStage) => catalog.getCatalog({ ...base, onCatalogStage }));
    cache.writeScopedCache = originalWrite;

    capabilities.mergeSnapshot = (snapshot) => snapshot;
    cache.readScopedCache = () => ({ scopeId: originalResolve({ apiKey: key, baseURL, scopeId: "stage-user" }), models: [new Proxy({}, { get(_target, keyName) { if (keyName === "tasks") throw new TypeError("private projection detail"); return undefined; } })], lastSuccessfulAt: new Date(base.now).toISOString() });
    await rejectsAt("projection", (onCatalogStage) => catalog.getCatalog({ ...base, force: false, onCatalogStage }));

    cache.readScopedCache = () => ({ scopeId: originalResolve({ apiKey: key, baseURL, scopeId: "stage-user" }), models: [], lastSuccessfulAt: new Date(base.now).toISOString() });
    await rejectsAt("fallback_projection", (onCatalogStage) => catalog.getCatalog({ ...base, force: false, fallback: [new Proxy({}, { get() { throw new TypeError("private fallback projection detail"); } })], onCatalogStage }));
  } finally {
    cache.resolveScopeId = originalResolve;
    cache.readScopedCache = originalRead;
    cache.writeScopedCache = originalWrite;
    capabilities.mergeSnapshot = originalMerge;
  }
});

test("catalog HTTP, network, and successful paths keep their bounded status and stage", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "northstar-catalog-failure-stage-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { apiKey: key, scopeId: "status-user", baseURL, cacheDir: dir, now: Date.now(), force: true, fallback: [{ id: "fallback-model" }] };
  const http = await catalog.getCatalog({ ...base, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(http.catalogDiagnostics.errorCode, "PT_HTTP_ERROR");
  assert.equal(http.catalogDiagnostics.failureStage, "fetch_or_parse");
  assert.equal(http.catalogDiagnostics.failureCountKnown, true);
  const network = await catalog.getCatalog({ ...base, now: base.now + 1, fetchImpl: async () => { throw new Error("private network detail"); } });
  assert.equal(network.catalogDiagnostics.errorCode, "PT_NETWORK_ERROR");
  assert.equal(network.catalogDiagnostics.failureStage, "fetch_or_parse");
  const success = await catalog.getCatalog({ ...base, now: base.now + 2, fetchImpl: async () => response({ data: [{ id: "success-model" }] }) });
  assert.equal(success.catalogDiagnostics.errorCode, null);
  assert.equal(success.catalogDiagnostics.failureStage, null);
  assert.equal(success.models[0].id, "success-model");
});

test("a false cache-write result is classified as cache_write with known sync failure count", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "northstar-catalog-cache-write-false-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalWrite = cache.writeScopedCache;
  const observed = [];
  try {
    cache.writeScopedCache = () => false;
    const result = await catalog.getCatalog({
      apiKey: key,
      scopeId: "cache-write-false-user",
      baseURL,
      cacheDir: dir,
      now: Date.now(),
      force: true,
      fallback: [],
      fetchImpl: async () => ({ ok: false, status: 503 }),
      onCatalogStage: (stage) => observed.push(stage),
    });
    assert.ok(observed.includes("cache_write"));
    assert.equal(result.catalogDiagnostics.state, "cache_write_failed");
    assert.equal(result.catalogDiagnostics.errorCode, "CATALOG_CACHE_WRITE_FAILED");
    assert.equal(result.catalogDiagnostics.failureStage, "cache_write");
    assert.equal(result.catalogDiagnostics.failureCount, 1);
    assert.equal(result.catalogDiagnostics.failureCountKnown, true);
  } finally {
    cache.writeScopedCache = originalWrite;
  }
});
