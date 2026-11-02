import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../shell/model-catalog.cjs');
const CACHE = require('../../shell/models/catalog-cache.cjs');
const Cap = require('../../shell/models/capabilities.cjs');
const { routeTextTask } = require('../../shell/models/task-router.cjs');
const baseNow = Date.parse('2026-10-17T00:00:00.000Z');
const key = 'key-fixture-do-not-persist';
const record = { id: 'model-a', capabilities: { textChat: true }, input_modalities: ['text'], output_modalities: ['text'], supported_endpoint_types: ['anthropic'] };
const response = (payload, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'fixture-etag-v1' }, json: async () => payload });

test('legacy display cache is preserved but cannot grant access or crash failed refresh', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-legacy-display-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baseURL = 'https://pt.example/v1';
  const scopeId = CACHE.resolveScopeId({ apiKey: key, baseURL, scopeId: 'owner' });
  const file = CACHE.cacheFile(dir, scopeId);
  const legacy = JSON.stringify({ schemaVersion: 1, scopeId, snapshot: {
    scopeId, models: [{ id: 'legacy-model', chat: true }], lastSuccessfulAt: new Date(baseNow).toISOString(),
  } });
  writeFileSync(file, legacy, { mode: 0o600 });
  const result = await C.getCatalog({ apiKey: key, baseURL, scopeId: 'owner', cacheDir: dir,
    now: baseNow + 1000, force: true, fallback: [{ id: 'display-only' }],
    fetchImpl: async () => response({}, 503) });
  assert.equal(result.catalogDiagnostics.errorCode, 'PT_HTTP_ERROR');
  assert.equal(result.availability.status, 'unknown');
  assert.deepEqual(result.availability.modelIds, []);
  assert.equal(result.models.some((model) => model.id === 'legacy-model'), false);
  const backup = readdirSync(dir).find((name) => name.endsWith('.bak'));
  assert.ok(backup, 'invalid cache bytes must be preserved before replacement');
  assert.equal(readFileSync(path.join(dir, backup), 'utf8'), legacy);
});

test('catalog lifecycle scopes persistent caches by non-secret credential/access fingerprint', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scopeA = CACHE.resolveScopeId({ apiKey: key, baseURL: 'https://pt.example/v1' });
  const scopeB = CACHE.resolveScopeId({ apiKey: 'different-fixture-key', baseURL: 'https://pt.example/v1' });
  assert.notEqual(scopeA, scopeB);
  assert.notEqual(scopeA, CACHE.resolveScopeId({ apiKey: key, baseURL: 'https://pt.example/v1', scopeId: 'permission-scope-rotated' }));
  assert.equal(CACHE.resolveScopeId({ apiKey: '', baseURL: 'https://pt.example/v1' }), null);
  let calls = 0;
  const a = await C.getCatalog({ apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow, fetchImpl: async () => { calls++; return response({ data: [record] }); } });
  assert.equal(a.models[0].chat, true);
  assert.equal(a.models[0].states.textChat.autoEligible, false, 'discovery alone is not runtime or AUTO eligibility');
  assert.equal(a.models[0].runtimeStatus, 'unadapted');
  assert.deepEqual(a.availability, { status: 'available', modelIds: ['model-a'] });
  assert.equal(calls, 1);
  const b = await C.getCatalog({ apiKey: 'different-fixture-key', baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow, fetchImpl: async () => { calls++; return response({ data: [{ id: 'model-b' }] }); } });
  assert.equal(b.models[0].id, 'model-b', 'different key cannot consume the prior scope cache');
  assert.equal(calls, 2);
  const cacheFiles = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(cacheFiles.length, 2);
  for (const name of cacheFiles) assert.equal(readFileSync(path.join(dir, name), 'utf8').includes(key), false, 'raw credential is never persisted');
});

test('a successful PT model listing grants permission only to returned IDs for that credential', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-listed-permission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow };
  const first = await C.getCatalog({ ...base, fetchImpl: async () => response({ data: [{ id: 'model-a' }] }) });
  assert.equal(first.models.find((m) => m.id === 'model-a').permission, true);
  const refreshed = await C.getCatalog({ ...base, now: baseNow + 1000, force: true,
    fetchImpl: async () => response({ data: [{ id: 'model-b' }] }) });
  assert.equal(refreshed.models.find((m) => m.id === 'model-b').permission, true);
  assert.equal(refreshed.models.find((m) => m.id === 'model-a').permission, null,
    'a cached model absent from this key response is not granted permission');
});

test('PT listing permission and confirmed endpoint mapping enable manual chat adaptation while AUTO requires verification', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-qualification-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policy = { enabled: true, source: 'user-confirmed textChat policy', version: 'test-1', tasks: ['textChat'] };
  const adapter = { adapterId: 'powertokens-openai-completions', version: 'test-1', endpoint: 'openai-chat-completions', source: 'user-confirmed OpenAI-compatible endpoint' };
  const catalog = await C.getCatalog({
    apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow,
    qualificationDefaults: { policy, adaptation: adapter },
    fetchImpl: async () => response({ data: [
      { id: 'new-dynamic-chat', supported_endpoint_types: ['openai-response'] },
      { id: 'listed-non-chat-model' },
    ] }),
  });
  const candidate = catalog.models.find((model) => model.id === 'new-dynamic-chat');
  assert.equal(candidate.permission, true);
  assert.deepEqual(candidate.localPolicy, policy);
  assert.deepEqual(candidate.adaptations.textChat, adapter);
  assert.equal(candidate.tasks.textChat.value, true);
  assert.deepEqual(candidate.inputModalities.value, ['text']);
  assert.deepEqual(candidate.outputModalities.value, ['text']);
  assert.equal(candidate.tasks.textChat.source.path, 'supported_endpoint_types');
  assert.equal(candidate.states.textChat.endpointCompatible, true);
  const routed = routeTextTask({ candidates: [candidate], requirements: { task: 'textChat' }, selection: { mode: 'manual', modelId: candidate.id }, availability: catalog.availability });
  assert.equal(routed.ok, true);
  assert.equal(routed.resolvedModelId, 'new-dynamic-chat');
  assert.equal(routed.verificationRequired, true);
  const automatic = routeTextTask({ candidates: [candidate], requirements: { task: 'textChat' }, selection: { mode: 'auto' }, availability: catalog.availability });
  assert.equal(automatic.ok, false);
  assert.equal(automatic.code, 'NO_ELIGIBLE_MODEL');
  const nonChat = catalog.models.find((model) => model.id === 'listed-non-chat-model');
  assert.equal(nonChat.permission, true, 'presence in the current PT listing is invocation permission');
  assert.deepEqual(nonChat.localPolicy, policy, 'the textChat route policy is enabled');
  assert.equal(nonChat.tasks.textChat.value, null, 'permission and policy do not invent task capability');
  assert.equal(nonChat.states.textChat.adapted, false);
  const deniedRoute = routeTextTask({ candidates: [nonChat], requirements: { task: 'textChat' }, selection: { mode: 'manual', modelId: nonChat.id }, availability: catalog.availability });
  assert.equal(deniedRoute.ok, false);
  assert.equal(deniedRoute.code, 'MANUAL_MODEL_INELIGIBLE');
});

test('confirmed task endpoint proves chat capability without proving runtime verification', () => {
  const model = C.normalizeModel({ id: 'deepseek-v4-pro', supported_endpoint_types: ['anthropic'] });
  assert.equal(model.chat, true);
  assert.equal(model.capabilityStatus, 'supported');
  assert.equal(model.runtimeStatus, 'unadapted');
  assert.equal(model.states.textChat.autoEligible, false);
  assert.equal(C.routeModelFor('hello', [model], 'deepseek-v4-pro'), '', 'rich unknown model is excluded from AUTO');
});

test('synchronization preserves operator policy, adapter and verification evidence', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-local-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scoped = C.resolveScopeId({ apiKey: key, baseURL: 'https://pt.example/v1' });
  const raw = { ...record, name: 'Model A' };
  const at = new Date(baseNow).toISOString();
  const override = { source: 'operator-reviewed catalog fixture', version: 'override-1', tasks: { textChat: true } };
  const revision = Cap.normalizePtRecord(raw, { scopeId: scoped, observedAt: at, override }).capabilityRevision;
  const policy = { enabled: true, source: 'catalog lifecycle fixture', version: 'policy-1', tasks: ['textChat'] };
  const adaptation = { textChat: { adapterId: 'adapter-chat', version: '1', endpoint: 'openai-chat-completions', source: 'adapter fixture' } };
  const verification = { textChat: { status: 'passed', modelId: 'model-a', task: 'textChat', scopeId: scoped, adapterId: 'adapter-chat', adapterVersion: '1', endpoint: 'openai-chat-completions', source: 'controlled verification fixture', verifiedAt: at, capabilityRevision: revision } };
  const base = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow, permission: true, policies: { 'model-a': policy }, adaptations: { 'model-a': adaptation }, verifications: { 'model-a': verification }, overrides: { 'model-a': override } };
  const initial = await C.getCatalog({ ...base, fetchImpl: async () => response({ data: [raw] }) });
  assert.equal(initial.models[0].states.textChat.autoEligible, true);
  const refreshed = await C.getCatalog({ apiKey: key, baseURL: base.baseURL, cacheDir: dir, now: baseNow + 1000, force: true, fetchImpl: async () => response({ data: [raw] }) });
  assert.deepEqual(refreshed.models[0].localPolicy, policy);
  assert.deepEqual(refreshed.models[0].adaptations.textChat, adaptation.textChat);
  assert.deepEqual(refreshed.models[0].verifications.textChat, verification.textChat);
  assert.deepEqual(refreshed.models[0].manualOverride, { id: 'model-a', ...override });
  assert.equal(refreshed.models[0].tasks.textChat.source.kind, 'manual');
  assert.equal(refreshed.models[0].states.textChat.autoEligible, true);
  const cachedOptions = { apiKey: key, baseURL: base.baseURL, cacheDir: dir, now: baseNow + 2000,
    fetchImpl: async () => { assert.fail('fresh cache local updates must not require network'); } };
  const revoked = await C.getCatalog({ ...cachedOptions, permission: false });
  assert.equal(revoked.models[0].permission, false);
  assert.equal(revoked.models[0].states.textChat.autoEligible, false);
  const persisted = await C.getCatalog(cachedOptions);
  assert.equal(persisted.models[0].permission, false, 'revocation survives a subsequent read without options');
  const policyDenied = await C.getCatalog({ ...cachedOptions, permission: true,
    policies: { 'model-a': { ...policy, enabled: false, version: 'policy-2' } } });
  assert.equal(policyDenied.models[0].localPolicy.enabled, false);
  assert.equal(policyDenied.models[0].states.textChat.autoEligible, false);
  const noVerification = await C.getCatalog({ ...cachedOptions, policies: { 'model-a': policy }, verifications: { 'model-a': {} } });
  assert.equal(noVerification.models[0].states.textChat.verified, false);
  const noAdapter = await C.getCatalog({ ...cachedOptions, verifications: { 'model-a': verification }, adaptations: { 'model-a': {} } });
  assert.equal(noAdapter.models[0].states.textChat.adapted, false);
  assert.equal(noAdapter.models[0].states.textChat.verified, false);
});

test('incremental successful snapshots add/update without tombstoning; only explicit completeness can remove', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-complete-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow };
  let first = await C.getCatalog({ ...base, fetchImpl: async () => response({ data: [record, { id: 'model-b' }] }) });
  assert.deepEqual(first.models.map((m) => m.id), ['model-a', 'model-b']);
  const partial = await C.getCatalog({ ...base, now: baseNow + 1000, force: true, fetchImpl: async () => response({ data: [{ ...record, name: 'Model A v2' }] }) });
  assert.deepEqual(partial.models.map((m) => m.id), ['model-a', 'model-b']);
  assert.equal(partial.models.find((m) => m.id === 'model-b').availability, 'present');
  assert.deepEqual(partial.availability, { status: 'available', modelIds: ['model-a', 'model-b'] });
  const complete = await C.getCatalog({ ...base, now: baseNow + 2000, force: true, isCompleteSnapshot: (payload) => payload.complete === true, fetchImpl: async () => response({ complete: true, data: [{ ...record, name: 'Model A v2' }] }) });
  assert.equal(complete.models.find((m) => m.id === 'model-b').availability, 'removed');
  assert.equal(complete.models.find((m) => m.id === 'model-a').availability, 'present');
  assert.deepEqual(complete.availability, { status: 'available', modelIds: ['model-a'] });
});

test('paginated sync grants returned IDs only and never tombstones omitted models', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-backoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow };
  await C.getCatalog({ ...base, fetchImpl: async () => response({ data: [record, { id: 'model-b' }] }) });
  let calls = 0;
  const partial = await C.getCatalog({ ...base, now: baseNow + 24 * 60 * 60 * 1000, force: true, fetchImpl: async () => { calls++; return response({ data: [record], has_more: true }); } });
  const modelA = partial.models.find((model) => model.id === 'model-a');
  const modelB = partial.models.find((model) => model.id === 'model-b');
  assert.equal(modelA.permission, true, 'an ID returned in a paginated response is authorized for this key');
  assert.equal(modelB.permission, null, 'an omitted cached ID from a partial page is not authorized');
  assert.equal(modelB.availability, 'present', 'an incomplete page cannot tombstone an omitted model');
  assert.equal(calls, 1);
  const failed = await C.getCatalog({ ...base, now: baseNow + 24 * 60 * 60 * 1000 + 1000, force: true, fetchImpl: async () => { calls++; return response({ data: [] }, 503); } });
  assert.equal(modelA.permission, true, 'prior partial page authorization remains an immutable snapshot result');
  assert.equal(failed.models.find((model) => model.id === 'model-a').permission, null, 'failed refresh closes previously granted permission');
  assert.equal(calls, 2);
  const backoff = await C.getCatalog({ ...base, now: baseNow + 24 * 60 * 60 * 1000 + 2000, fetchImpl: async () => { calls++; return response({ data: [] }); } });
  assert.equal(calls, 2, 'automatic sync inside retry backoff is suppressed');
  assert.equal(backoff.models.find((model) => model.id === 'model-a').permission, null);
});

test('failed initial sync and static fallback do not establish availability or permission', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-no-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow, fallback: [record] };
  const catalog = await C.getCatalog({ ...base, fetchImpl: async () => response({}, 503) });
  assert.deepEqual(catalog.availability, { status: 'unknown', modelIds: [] });
  assert.equal(catalog.models[0].id, record.id);
  assert.equal(catalog.models[0].permission, null);
  assert.equal(catalog.models[0].localPolicy, null);
  const retry = await C.getCatalog({ ...base, now: baseNow + 1000, fetchImpl: async () => { throw Error('backoff should suppress fetch'); } });
  assert.deepEqual(retry.availability, { status: 'unknown', modelIds: [] });
  const noCredential = await C.getCatalog({ ...base, apiKey: '', fetchImpl: async () => response({ data: [record] }) });
  assert.deepEqual(noCredential.availability, { status: 'unknown', modelIds: [] });
  assert.equal(noCredential.models[0].permission, null);
});

test('a successful empty snapshot does not grant availability to static display fallback', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-empty-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = await C.getCatalog({ apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow,
    fallback: [record], isCompleteSnapshot: (payload) => payload.complete === true,
    fetchImpl: async () => response({ complete: true, data: [] }) });
  assert.deepEqual(catalog.availability, { status: 'available', modelIds: [] });
  assert.equal(catalog.models[0].id, record.id);
  assert.equal(catalog.models[0].permission, null);
});

test('concurrent refreshes for one scope share one injected provider request', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-singleflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const opts = { apiKey: key, baseURL: 'https://pt.example/v1', cacheDir: dir, now: baseNow, force: true, fetchImpl: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return response({ data: [record] }); } };
  const [a, b] = await Promise.all([C.getCatalog(opts), C.getCatalog(opts)]);
  assert.equal(calls, 1);
  assert.deepEqual(a.models.map((m) => m.id), b.models.map((m) => m.id));
});

test('older rich cache records missing eligibility facts are preserved and never reach unsafe merge', async (t) => {
  const fields = ['ptEndpointTasks', 'endpoints', 'inputModalities', 'outputModalities'];
  for (const field of fields) {
    const dir = mkdtempSync(path.join(tmpdir(), 'northstar-catalog-old-rich-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const baseURL = 'https://pt.example/v1';
    const scopeId = CACHE.resolveScopeId({ apiKey: key, baseURL, scopeId: 'owner' });
    const snapshot = Cap.mergeSnapshot(null, { scopeId, observedAt: new Date(baseNow).toISOString(),
      success: true, complete: true, records: [record] });
    delete snapshot.models[0][field];
    const original = JSON.stringify({ schemaVersion: 1, scopeId, snapshot });
    writeFileSync(CACHE.cacheFile(dir, scopeId), original, { mode: 0o600 });
    let fetches = 0;
    const result = await C.getCatalog({ apiKey: key, baseURL, scopeId: 'owner', cacheDir: dir,
      now: baseNow + 1000, fallback: [{ id: 'display-only' }],
      qualificationDefaults: { policy: { enabled: true, source: 'fixture', version: '1' } },
      fetchImpl: async () => { fetches++; return response({}, 503); } });
    assert.equal(fetches, 1, `${field}: apparently fresh but invalid cached facts cannot suppress validation`);
    assert.equal(result.catalogDiagnostics.errorCode, 'PT_HTTP_ERROR');
    assert.equal(result.availability.status, 'unknown');
    assert.deepEqual(result.availability.modelIds, []);
    const backups = readdirSync(dir).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1, `${field}: preserve original evidence before replacing invalid cache`);
    assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), original);
    assert.equal(result.models.some(model => model.id === record.id), false, 'invalid old rich record cannot grant permission');
  }
});
