import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMediaQualificationMatrix } = require('../../shell/models/media-task-router.cjs');
const { normalizePtRecord } = require('../../shell/models/capabilities.cjs');

const scopeId = 'current-credential-scope';
const observedAt = '2026-10-25T00:00:00.000Z';
const raw = { id: 'qualified-image', capabilities: { textToImage: true }, input_modalities: ['text'], output_modalities: ['image'] };
const override = { source: 'reviewed image contract', version: '1', tasks: {}, endpoints: ['openai-images-generations'] };
const adaptation = { adapterId: 'pt-image-generations-v1', version: '1', endpoint: 'openai-images-generations', source: 'reviewed wire adapter' };
const options = { scopeId, observedAt, permission: true,
  localPolicy: { enabled: true, source: 'reviewed media policy', version: '1', tasks: ['textToImage'] },
  override, adaptations: { textToImage: adaptation } };
const revision = normalizePtRecord(raw, options).capabilityRevision;
const ready = normalizePtRecord(raw, { ...options, verifications: { textToImage: {
  status: 'passed', modelId: raw.id, task: 'textToImage', scopeId, capabilityRevision: revision,
  adapterId: adaptation.adapterId, adapterVersion: adaptation.version, endpoint: adaptation.endpoint,
  source: 'observed Run', verifiedAt: observedAt,
} } });
const hinted = normalizePtRecord({ id: 'directory-video-hint', supported_endpoint_types: ['openai-video'] },
  { scopeId, observedAt, permission: true });
const catalog = { scopeId, catalogDiagnostics: { state: 'fresh', errorCode: null },
  availability: { status: 'available', modelIds: [ready.id, hinted.id] }, models: [ready, hinted] };

test('current catalog matrix reports every model and media task with first blocking reason', () => {
  const matrix = buildMediaQualificationMatrix(catalog);
  assert.equal(matrix.ok, true);
  assert.equal(matrix.modelCount, 2);
  assert.equal(matrix.rows[0].tasks.text2image, 'ROUTE_READY');
  assert.equal(matrix.rows[0].tasks.image2image, 'LOCAL_POLICY_UNKNOWN_OR_DENIED');
  assert.equal(matrix.rows[0].tasks.text2video, 'LOCAL_POLICY_UNKNOWN_OR_DENIED');
  assert.equal(matrix.rows[1].tasks.text2video, 'LOCAL_POLICY_UNKNOWN_OR_DENIED');
  assert.deepEqual(matrix.routeReadyCounts, { text2image: 1, image2image: 0, text2video: 0, image2video: 0 });
  assert.equal(JSON.stringify(matrix).includes('observed Run'), false);
});

test('stale, failed, display-only and ambiguous catalogs cannot produce a ready matrix', () => {
  for (const changed of [
    { catalogDiagnostics: { state: 'cached', errorCode: null } },
    { catalogDiagnostics: { state: 'fresh', errorCode: 'PT_HTTP_ERROR' } },
    { availability: { status: 'unknown', modelIds: [] } },
    { scopeId: null },
  ]) assert.equal(buildMediaQualificationMatrix({ ...catalog, ...changed }).code, 'MEDIA_CATALOG_UNAVAILABLE');
  assert.equal(buildMediaQualificationMatrix({ ...catalog, models: [ready, { ...ready }] }).code, 'CANDIDATE_ID_AMBIGUOUS');
});

test('permission, scope and runtime verification are separately enforced', () => {
  assert.equal(normalizePtRecord(raw, { ...options, localPolicy: { ...options.localPolicy, tasks: ['textChat'] }, verifications: ready.verifications }).states.textToImage.autoEligible, false);
  const variants = [
    [{ ...ready, permission: null }, 'PERMISSION_UNKNOWN_OR_DENIED'],
    [{ ...ready, scopeId: 'other-scope' }, 'MODEL_SCOPE_MISMATCH'],
    [{ ...ready, localPolicy: { enabled: true, source: 'chat only', version: '1', tasks: ['textChat'] } }, 'LOCAL_POLICY_UNKNOWN_OR_DENIED'],
    [{ ...ready, verifications: {} }, 'RUNTIME_UNVERIFIED'],
  ];
  for (const [candidate, expected] of variants) {
    const result = buildMediaQualificationMatrix({ ...catalog, models: [candidate] });
    assert.equal(result.rows[0].tasks.text2image, expected);
    assert.equal(result.routeReadyCounts.text2image, 0);
  }
});
