import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveMediaRouteForRun } = require('../../shell/models/media-route-admission.cjs');
const { normalizePtRecord } = require('../../shell/models/capabilities.cjs');
const { DEFAULT_BASE_URL } = require('../../shell/model-catalog.cjs');

const identity = { userId: 'owner', tenantId: 'tenant' };
const apiKey = 'fixture-key';
const scopeId = 'fixture-scope';
const observedAt = '2026-10-24T00:00:00.000Z';
const raw = { id: 'image-model', capabilities: { textToImage: true }, input_modalities: ['text'], output_modalities: ['image'] };
const override = { source: 'reviewed media endpoint fixture', version: '1', tasks: {}, endpoints: ['openai-images-generations'] };
const adapter = { adapterId: 'pt-image-generations-v1', version: '1', endpoint: 'openai-images-generations', source: 'reviewed wire adapter fixture' };
const policy = { enabled: true, source: 'reviewed media policy fixture', version: '1', tasks: ['textToImage'] };
const base = { scopeId, observedAt, override, localPolicy: policy, adaptations: { textToImage: adapter }, permission: true };
const revision = normalizePtRecord(raw, base).capabilityRevision;
const candidate = normalizePtRecord(raw, { ...base, verifications: { textToImage: {
  status: 'passed', modelId: raw.id, task: 'textToImage', scopeId, capabilityRevision: revision,
  adapterId: adapter.adapterId, adapterVersion: adapter.version, endpoint: adapter.endpoint,
  source: 'reviewed runtime fixture', verifiedAt: observedAt,
} } });
const catalog = { models: [candidate], scopeId,
  availability: { status: 'available', modelIds: [candidate.id] },
  catalogDiagnostics: { state: 'fresh', errorCode: null } };

test('Run media admission uses current credential and a verified catalog route', async () => {
  let calls = 0;
  const route = await resolveMediaRouteForRun({ identity, apiKey, args: { taskType: 'text2image' },
    getCatalog: async (options) => {
      calls++;
      assert.deepEqual(options, { apiKey, scopeId: identity.userId, baseURL: DEFAULT_BASE_URL, force: true, fallback: [] });
      return catalog;
    } });
  assert.equal(calls, 1);
  assert.equal(route.model, candidate.id);
  assert.equal(route.adapterId, adapter.adapterId);
  assert.equal(route.path, '/v1/images/generations');
});

test('failed refresh and incomplete qualification fail before media submission', async () => {
  for (const changed of [
    { catalogDiagnostics: { state: 'sync_failed', errorCode: 'PT_HTTP_ERROR' } },
    { availability: { status: 'unknown', modelIds: [] } },
    { models: [{ ...candidate, permission: null }] },
    { models: [{ ...candidate, localPolicy: { enabled: true, source: 'chat only', version: '1', tasks: ['textChat'] } }] },
    { models: [{ ...candidate, verifications: {}, states: { ...candidate.states, textToImage: { ...candidate.states.textToImage, verified: false, autoEligible: false } } }] },
  ]) {
    await assert.rejects(resolveMediaRouteForRun({ identity, apiKey, args: { taskType: 'text2image' },
      getCatalog: async () => ({ ...catalog, ...changed }) }), { code: changed.catalogDiagnostics ? 'MEDIA_CATALOG_UNAVAILABLE' : changed.availability ? 'MEDIA_CATALOG_UNAVAILABLE' : 'NO_ELIGIBLE_MODEL' });
  }
});

test('tool arguments cannot select a model or change the verified adapter', async () => {
  await assert.rejects(resolveMediaRouteForRun({ identity, apiKey, args: { taskType: 'text2image', modelId: 'other-model' },
    getCatalog: async () => { assert.fail('invalid arguments must not query the catalog'); } }), { code: 'MEDIA_ROUTE_ARGUMENT_OVERRIDE' });
  await assert.rejects(resolveMediaRouteForRun({ identity, apiKey, args: { taskType: 'image2video' }, getCatalog: async () => catalog }), { code: 'NO_ELIGIBLE_MODEL' });
  await assert.rejects(resolveMediaRouteForRun({ identity, apiKey, args: { taskType: 'text2image' }, getCatalog: async () => { throw new Error('private catalog detail'); } }),
    { code: 'MEDIA_CATALOG_UNAVAILABLE', message: 'Media model qualification failed' });
});
