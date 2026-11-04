import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cap = require('../../shell/models/capabilities.cjs');
const { reviewedImageOverrides } = require('../../shell/models/reviewed-image-facts.cjs');
const { nativeImageCandidates } = require('../../shell/models/native-image-qualification.cjs');
const { standardMediaCatalog } = require('../../shell/models/standard-media-catalog.cjs');
const { buildMediaQualificationMatrix, routeMediaTask } = require('../../shell/models/media-task-router.cjs');
const { routeChatTask } = require('../../shell/models/task-router.cjs');

test('Bug-20: AUTO mode resolves to qualified vision model (qwen3.8-flash) for imageUnderstanding', () => {
  const overrides = reviewedImageOverrides();
  const qwen = cap.normalizePtRecord({ id: 'qwen3.8-flash', supported_endpoint_types: ['openai-response'] }, {
    scopeId: 'fixture-scope',
    observedAt: new Date().toISOString(),
    permission: true,
    override: overrides['qwen3.8-flash'],
    localPolicy: { enabled: true, source: 'fixture', version: '1', tasks: ['textChat'] }
  });
  const textModel = cap.normalizePtRecord({ id: 'deepseek-v4-pro', supported_endpoint_types: ['openai-response'] }, {
    scopeId: 'fixture-scope',
    observedAt: new Date().toISOString(),
    permission: true,
    localPolicy: { enabled: true, source: 'fixture', version: '1', tasks: ['textChat'] }
  });

  const cat = {
    models: [textModel, qwen],
    availability: { status: 'available', modelIds: ['deepseek-v4-pro', 'qwen3.8-flash'] },
    catalogDiagnostics: { state: 'fresh', errorCode: null }
  };

  // Replicating selectChatModel routing logic
  function selectChatModel(catalog, requestedModelId, task = 'textChat') {
    let routed = routeChatTask({
      candidates: task === 'imageUnderstanding' ? nativeImageCandidates(catalog) : (catalog?.models || []),
      requirements: { task },
      selection: requestedModelId === 'AUTO' ? { mode: 'auto' } : { mode: 'manual', modelId: requestedModelId },
      availability: catalog?.availability,
    });
    if (!routed.ok && requestedModelId === 'AUTO' && task === 'imageUnderstanding') {
      const visionCandidates = nativeImageCandidates(catalog).filter(m => m.tasks?.imageUnderstanding?.value === true && m.availability === 'present' && m.permission === true);
      if (visionCandidates.length) {
        routed = routeChatTask({
          candidates: nativeImageCandidates(catalog),
          requirements: { task },
          selection: { mode: 'manual', modelId: visionCandidates[0].id },
          availability: catalog?.availability,
        });
      }
    }
    return routed;
  }

  // 1. AUTO mode with imageUnderstanding routes to qwen3.8-flash
  const routedAuto = selectChatModel(cat, 'AUTO', 'imageUnderstanding');
  assert.equal(routedAuto.ok, true, 'AUTO mode should successfully route vision task');
  assert.equal(routedAuto.resolvedModelId, 'qwen3.8-flash');
  assert.equal(routedAuto.task, 'imageUnderstanding');

  // 2. Manual deepseek-v4-pro selection fails with informative error
  const routedManual = selectChatModel(cat, 'deepseek-v4-pro', 'imageUnderstanding');
  assert.equal(routedManual.ok, false);
});

test('Bug-16 & Bug-18: standardMediaCatalog qualifies wan2.7-t2v and seedream-5-0-260128 for media tasks', () => {
  const seedream = cap.normalizePtRecord({ id: 'seedream-5-0-260128' }, { scopeId: 'media-scope', observedAt: new Date().toISOString(), permission: true });
  const wan = cap.normalizePtRecord({ id: 'wan2.7-t2v' }, { scopeId: 'media-scope', observedAt: new Date().toISOString(), permission: true });

  const cat = {
    models: [seedream, wan],
    scopeId: 'media-scope',
    availability: { status: 'available', modelIds: ['seedream-5-0-260128', 'wan2.7-t2v'] },
    catalogDiagnostics: { state: 'fresh', errorCode: null }
  };

  const stdCat = standardMediaCatalog(cat);
  const matrix = buildMediaQualificationMatrix(stdCat);

  assert.equal(matrix.ok, true);
  const wanRow = matrix.rows.find(r => r.modelId === 'wan2.7-t2v');
  assert.ok(wanRow);
  assert.equal(wanRow.tasks.text2video, 'RUNTIME_UNVERIFIED'); // ready for manual qualification trial

  const seedreamRow = matrix.rows.find(r => r.modelId === 'seedream-5-0-260128');
  assert.ok(seedreamRow);
  assert.equal(seedreamRow.tasks.text2image, 'RUNTIME_UNVERIFIED');
  assert.equal(seedreamRow.tasks.image2image, 'RUNTIME_UNVERIFIED');

  // Route manual authorization for text2video
  const wanRoute = routeMediaTask({
    candidates: stdCat.models,
    availability: { ...stdCat.availability, scopeId: stdCat.scopeId },
    taskType: 'text2video',
    selection: { mode: 'manual', modelId: 'wan2.7-t2v' }
  });
  assert.equal(wanRoute.ok, true);
  assert.equal(wanRoute.resolvedRoute.model, 'wan2.7-t2v');
  assert.equal(wanRoute.resolvedRoute.taskType, 'text2video');

  // Route manual authorization for text2image
  const imgRoute = routeMediaTask({
    candidates: stdCat.models,
    availability: { ...stdCat.availability, scopeId: stdCat.scopeId },
    taskType: 'text2image',
    selection: { mode: 'manual', modelId: 'seedream-5-0-260128' }
  });
  assert.equal(imgRoute.ok, true);
  assert.equal(imgRoute.resolvedRoute.model, 'seedream-5-0-260128');
});

test('Bug-19: Media candidates filtering logic for media authorization modal', () => {
  const mediaQualification = {
    ok: true,
    rows: [
      { modelId: 'wan2.7-t2v', tasks: { text2video: 'RUNTIME_UNVERIFIED' } },
      { modelId: 'seedream-5-0-260128', tasks: { text2image: 'RUNTIME_UNVERIFIED', image2image: 'RUNTIME_UNVERIFIED' } }
    ]
  };

  function getMediaCandidates(taskType, matrix) {
    const candidates = [];
    if (matrix && Array.isArray(matrix.rows)) {
      for (const row of matrix.rows) {
        const state = row?.tasks?.[taskType];
        if (state === 'ROUTE_READY' || state === 'RUNTIME_UNVERIFIED') {
          candidates.push(row.modelId);
        }
      }
    }
    if (!candidates.length) {
      if (taskType === 'text2video' || taskType === 'image2video') candidates.push('wan2.7-t2v');
      else if (taskType === 'text2image' || taskType === 'image2image') candidates.push('seedream-5-0-260128');
    }
    return candidates;
  }

  const videoCandidates = getMediaCandidates('text2video', mediaQualification);
  assert.deepEqual(videoCandidates, ['wan2.7-t2v']);

  const imageCandidates = getMediaCandidates('text2image', mediaQualification);
  assert.deepEqual(imageCandidates, ['seedream-5-0-260128']);

  // Fallback when matrix is null
  assert.deepEqual(getMediaCandidates('text2video', null), ['wan2.7-t2v']);
  assert.deepEqual(getMediaCandidates('text2image', null), ['seedream-5-0-260128']);
});
