import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePtRecord, mergeSnapshot } = require('../../shell/models/capabilities.cjs');
const { applyReviewedMediaQualification } = require('../../shell/models/reviewed-media-apply.cjs');
const { buildReviewedMediaQualificationMaps } = require('../../shell/models/reviewed-media-qualification.cjs');

const scopeId = 'current-key-scope';
const observedAt = '2026-10-25T00:00:00.000Z';
const raw = { id: 'fixture-image-model', supported_endpoint_types: ['image-generation'] };
const candidate = normalizePtRecord(raw, {
  scopeId, observedAt, permission: true,
  localPolicy: { enabled: true, source: 'chat policy fixture', version: '1', tasks: ['textChat'] },
});
const catalog = { scopeId, models: [candidate],
  availability: { status: 'available', modelIds: [candidate.id] },
  catalogDiagnostics: { state: 'fresh', errorCode: null } };
const review = { modelId: candidate.id, scopeId, capabilityRevision: candidate.capabilityRevision,
  source: 'model-specific reviewed fixture', version: '2026-10-25.1', reviewedAt: observedAt,
  tasks: [{ taskType: 'text2image', source: 'fixture task declaration',
    adapterId: 'pt-image-generations-v1', endpoint: 'openai-images-generations' }] };

function mergedCatalog(maps) {
  const merged = mergeSnapshot({ scopeId, models: [candidate], lastSuccessfulAt: observedAt }, {
    scopeId, observedAt: '2026-10-25T00:01:00.000Z', success: true, complete: true, records: [raw],
  }, maps);
  return { ...catalog, models: merged.models };
}

test('one atomic scoped apply returns only a draft revision for administrator confirmation', async () => {
  let called = 0;
  const result = await applyReviewedMediaQualification({ catalog, reviews: [review],
    applyUpdates: async ({ scopeId: target, expectedRevisions, maps }) => {
      called++;
      assert.equal(target, scopeId);
      assert.deepEqual(expectedRevisions, { [candidate.id]: candidate.capabilityRevision });
      assert.deepEqual(maps.verifications[candidate.id], {});
      return { applied: true, previousRevisions: expectedRevisions, catalog: mergedCatalog(maps) };
    },
  });
  assert.equal(called, 1);
  assert.equal(result.status, 'pending_admin_confirmation');
  assert.equal(result.confirmations[0].modelId, candidate.id);
  assert.match(result.confirmations[0].appliedCapabilityRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(result.confirmations[0].appliedCapabilityRevision, candidate.capabilityRevision);
  assert.equal(JSON.stringify(result).includes('apiKey'), false);
});

test('concurrent revision mismatch or invalid storage receipt fails closed', async () => {
  await assert.rejects(applyReviewedMediaQualification({ catalog, reviews: [review], applyUpdates: async () => ({ applied: false }) }), { code: 'MEDIA_REVIEW_CONFLICT' });
  await assert.rejects(applyReviewedMediaQualification({ catalog, reviews: [review], applyUpdates: async ({ maps }) => ({
    applied: true, previousRevisions: { [candidate.id]: '0'.repeat(64) }, catalog: mergedCatalog(maps),
  }) }), { code: 'MEDIA_REVIEW_CONFLICT' });
  await assert.rejects(applyReviewedMediaQualification({ catalog, reviews: [review], applyUpdates: async ({ expectedRevisions, maps }) => ({
    applied: true, previousRevisions: expectedRevisions,
    catalog: { ...mergedCatalog(maps), scopeId: 'other-scope' },
  }) }), { code: 'MEDIA_REVIEW_APPLY_INVALID' });
});

test('storage cannot manufacture a passed verification during initial qualification', async () => {
  await assert.rejects(applyReviewedMediaQualification({ catalog, reviews: [review], applyUpdates: async ({ expectedRevisions, maps }) => {
    const forged = mergedCatalog(maps);
    forged.models[0].verifications.textToImage = { status: 'passed' };
    return { applied: true, previousRevisions: expectedRevisions, catalog: forged };
  } }), { code: 'MEDIA_REVIEW_APPLY_INVALID' });
});

test('a pinned replay preserves an existing verified result and rejects changed applied hash', async () => {
  const firstMaps = buildReviewedMediaQualificationMaps({ catalog, reviews: [review] });
  const applied = mergedCatalog(firstMaps);
  const appliedModel = applied.models[0];
  const current = { ...applied, models: [{ ...appliedModel, verifications: { textToImage: {
    status: 'passed', modelId: appliedModel.id, task: 'textToImage', scopeId,
    capabilityRevision: appliedModel.capabilityRevision, adapterId: 'pt-image-generations-v1',
    adapterVersion: '1', endpoint: 'openai-images-generations',
    source: 'fixture real run', verifiedAt: observedAt,
  } } }] };
  const pinned = { ...review, appliedCapabilityRevision: appliedModel.capabilityRevision };
  const callback = async ({ expectedRevisions, maps }) => {
    const next = mergeSnapshot({ scopeId, models: current.models, lastSuccessfulAt: '2026-10-25T00:01:00.000Z' }, {
      scopeId, observedAt: '2026-10-25T00:02:00.000Z', success: true, complete: true, records: [raw],
    }, maps);
    return { applied: true, previousRevisions: expectedRevisions, catalog: { ...current, models: next.models } };
  };
  const result = await applyReviewedMediaQualification({ catalog: current, reviews: [pinned], applyUpdates: callback });
  assert.equal(result.confirmations[0].appliedCapabilityRevision, appliedModel.capabilityRevision);
  await assert.rejects(applyReviewedMediaQualification({ catalog: current, reviews: [pinned],
    applyUpdates: async (args) => {
      const receipt = await callback(args);
      receipt.catalog.models[0].capabilityRevision = 'f'.repeat(64);
      return receipt;
    },
  }), { code: 'MEDIA_REVIEW_APPLY_INVALID' });
});
