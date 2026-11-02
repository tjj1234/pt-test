import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePtRecord, mergeSnapshot } = require('../../shell/models/capabilities.cjs');
const { routeMediaTask } = require('../../shell/models/media-task-router.cjs');
const { buildReviewedMediaQualificationMaps } = require('../../shell/models/reviewed-media-qualification.cjs');

const scopeId = 'current-key-scope';
const observedAt = '2026-10-25T00:00:00.000Z';
const raw = { id: 'fixture-image-model', supported_endpoint_types: ['image-generation'] };
const candidate = normalizePtRecord(raw, {
  scopeId, observedAt, permission: true,
  localPolicy: { enabled: true, source: 'existing reviewed chat policy', version: '1', tasks: ['textChat'] },
});
const catalog = { scopeId, models: [candidate],
  availability: { status: 'available', modelIds: [candidate.id] },
  catalogDiagnostics: { state: 'fresh', errorCode: null } };
const grant = (tasks) => ({
  modelId: candidate.id, scopeId, capabilityRevision: candidate.capabilityRevision,
  source: 'fixture model-specific reviewed declaration', version: '2026-10-25.1', reviewedAt: observedAt,
  tasks: tasks.map((taskType) => ({ taskType, source: `fixture declaration for ${taskType}`,
    adapterId: 'pt-image-generations-v1', endpoint: 'openai-images-generations' })),
});
const materialize = (maps) => normalizePtRecord(raw, {
  scopeId, observedAt, permission: true,
  override: maps.overrides[candidate.id], localPolicy: maps.policies[candidate.id],
  adaptations: maps.adaptations[candidate.id], verifications: maps.verifications[candidate.id],
});
const route = (model, taskType, mode) => routeMediaTask({ candidates: [model],
  availability: { status: 'available', scopeId, modelIds: [model.id] }, taskType,
  selection: mode === 'manual' ? { mode, modelId: model.id } : { mode } });

test('a reviewed single task prepares only a manual route and retains explicit chat policy', () => {
  const withChatVerification = { ...catalog, models: [{ ...candidate, verifications: { textChat: { status: 'passed' } } }] };
  const maps = buildReviewedMediaQualificationMaps({ catalog: withChatVerification, reviews: [grant(['text2image'])] });
  assert.deepEqual(maps.policies[candidate.id].tasks, ['textChat', 'textToImage']);
  assert.deepEqual(maps.verifications[candidate.id], { textChat: { status: 'passed' } });
  const reviewed = materialize(maps);
  assert.equal(route(reviewed, 'text2image', 'manual').ok, true);
  assert.equal(route(reviewed, 'text2image', 'auto').ok, false);
  assert.equal(route(reviewed, 'image2image', 'manual').ok, false);
});

test('image to image needs its own reviewed task, then still lacks AUTO verification', () => {
  const maps = buildReviewedMediaQualificationMaps({ catalog, reviews: [grant(['text2image', 'image2image'])] });
  const reviewed = materialize(maps);
  assert.equal(reviewed.tasks.imageToImage.value, true);
  assert.equal(reviewed.tasks.imageToImage.source.kind, 'manual');
  assert.equal(route(reviewed, 'image2image', 'manual').ok, true);
  assert.equal(route(reviewed, 'image2image', 'auto').ok, false);
});

test('an administrator-pinned applied revision replays exactly and preserves later runtime verification', () => {
  const review = grant(['text2image']);
  const first = buildReviewedMediaQualificationMaps({ catalog, reviews: [review] });
  const applied = materialize(first);
  assert.notEqual(applied.capabilityRevision, candidate.capabilityRevision);
  const runtimeVerification = { status: 'passed', modelId: applied.id, task: 'textToImage',
    scopeId, capabilityRevision: applied.capabilityRevision, adapterId: 'pt-image-generations-v1',
    adapterVersion: '1', endpoint: 'openai-images-generations', source: 'fixture real run', verifiedAt: observedAt };
  const current = { ...applied, verifications: { textToImage: runtimeVerification } };
  const currentCatalog = { ...catalog, models: [current] };
  const pinned = { ...review, appliedCapabilityRevision: applied.capabilityRevision };
  const replay = buildReviewedMediaQualificationMaps({ catalog: currentCatalog, reviews: [pinned] });
  assert.deepEqual(replay.verifications[applied.id].textToImage, runtimeVerification);
  assert.deepEqual(replay.overrides[applied.id], first.overrides[applied.id]);
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog: currentCatalog, reviews: [review] }), { code: 'MEDIA_REVIEW_STALE_OR_UNAUTHORIZED' });
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog: { ...catalog, models: [{ ...current, localPolicy: { ...current.localPolicy, tasks: [] } }] }, reviews: [pinned] }), { code: 'MEDIA_REVIEW_REPLAY_MISMATCH' });
});

test('qualification maps survive the catalog merge path without manufacturing AUTO evidence', () => {
  const review = grant(['text2image']);
  const maps = buildReviewedMediaQualificationMaps({ catalog, reviews: [review] });
  const first = mergeSnapshot({ scopeId, models: [candidate], lastSuccessfulAt: observedAt }, {
    scopeId, observedAt: '2026-10-25T00:01:00.000Z', success: true, complete: true, records: [raw],
  }, maps);
  const reviewed = first.models[0];
  assert.equal(route(reviewed, 'text2image', 'manual').ok, true);
  assert.equal(route(reviewed, 'text2image', 'auto').ok, false);
  const replayMaps = buildReviewedMediaQualificationMaps({
    catalog: { ...catalog, models: [reviewed] },
    reviews: [{ ...review, appliedCapabilityRevision: reviewed.capabilityRevision }],
  });
  const second = mergeSnapshot(first, {
    scopeId, observedAt: '2026-10-25T00:02:00.000Z', success: true, complete: true, records: [raw],
  }, replayMaps);
  assert.equal(second.models[0].capabilityRevision, reviewed.capabilityRevision);
  assert.equal(route(second.models[0], 'text2image', 'auto').ok, false);
});

test('stale scope or revision and unreviewed wire adapter fail before any qualification maps', () => {
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog, reviews: [{ ...grant(['text2image']), scopeId: 'other' }] }), { code: 'MEDIA_REVIEW_INVALID' });
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog, reviews: [{ ...grant(['text2image']), capabilityRevision: '0'.repeat(64) }] }), { code: 'MEDIA_REVIEW_STALE_OR_UNAUTHORIZED' });
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog, reviews: [{ ...grant(['image2image']), tasks: [{ taskType: 'image2image', source: 'fixture', adapterId: 'pt-video-generations-v1', endpoint: 'openai-videos' }] }] }), { code: 'MEDIA_REVIEW_TASK_INVALID' });
  assert.deepEqual(buildReviewedMediaQualificationMaps({ catalog, reviews: [] }).overrides, {});
});

test('failed catalog and absent current-key permission cannot yield reviewed maps', () => {
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog: { ...catalog, catalogDiagnostics: { state: 'sync_failed', errorCode: 'PT_HTTP_ERROR' } }, reviews: [grant(['text2image'])] }), { code: 'MEDIA_CATALOG_UNAVAILABLE' });
  assert.throws(() => buildReviewedMediaQualificationMaps({ catalog: { ...catalog, models: [{ ...candidate, permission: null }] }, reviews: [grant(['text2image'])] }), { code: 'MEDIA_REVIEW_STALE_OR_UNAUTHORIZED' });
});
