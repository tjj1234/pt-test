import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizePtRecord, mergeSnapshot } = require('../../shell/models/capabilities.cjs');
const at = '2026-10-16T00:00:00.000Z';
const later = '2026-10-17T00:00:00.000Z';
const scopeId = 'independent-review-scope';
const raw = { id: 'review-model', capabilities: { textChat: true }, input_modalities: ['text'], output_modalities: ['text'], supported_endpoint_types: ['anthropic'] };
const policy = { enabled: true, source: 'trusted-platform-policy', version: '1', tasks: ['textChat'] };
const adaptation = { textChat: { adapterId: 'chat-adapter', version: '1', endpoint: 'openai-chat-completions', source: 'trusted-registry' } };
const snapshot = (records, extra = {}) => ({ scopeId, observedAt: at, success: true, complete: true, records, ...extra });
function seeded() {
  const normalized = normalizePtRecord(raw, { scopeId, observedAt: at });
  const verified = { textChat: { status: 'passed', modelId: raw.id, task: 'textChat', scopeId, adapterId: 'chat-adapter', adapterVersion: '1', endpoint: 'openai-chat-completions', source: 'independent-test-fixture', verifiedAt: at, capabilityRevision: normalized.capabilityRevision } };
  const out = mergeSnapshot(null, snapshot([raw]), { permission: true, policies: { [raw.id]: policy }, adaptations: { [raw.id]: adaptation }, verifications: { [raw.id]: verified } });
  assert.equal(out.models[0].states.textChat.autoEligible, true);
  return out;
}

test('independent: failed synchronization preserves available model facts without granting unknown capabilities', () => {
  const initial = seeded();
  const out = mergeSnapshot(initial, snapshot([], { observedAt: later, success: false }));
  assert.equal(out.models[0].availability, 'present');
  assert.equal(out.models[0].capabilityRevision, initial.models[0].capabilityRevision);
  const unknown = normalizePtRecord({ id: 'chat-vision-guess', supported_endpoint_types: ['chat'] }, { scopeId, observedAt: at });
  assert.equal(unknown.states.textChat.autoEligible, false);
  assert.equal(unknown.tasks.imageUnderstanding.value, null);
});

test('independent: trusted permission revocation closes AUTO even if metadata fetch fails', () => {
  const out = mergeSnapshot(seeded(), snapshot([], { observedAt: later, success: false }), { permission: false });
  assert.equal(out.models[0].permission, false);
  assert.equal(out.models[0].states.textChat.autoEligible, false);
  assert.equal(out.models[0].availability, 'present', 'revocation must not invent upstream removal');
});

test('independent: disabling a retained model applies during a partial snapshot', () => {
  const disabled = { enabled: false, source: 'trusted-platform-policy', version: '2' };
  const out = mergeSnapshot(seeded(), snapshot([], { observedAt: later, complete: false }), { policies: { [raw.id]: disabled } });
  assert.equal(out.models[0].localPolicy.enabled, false);
  assert.equal(out.models[0].localPolicy.version, '2');
  assert.equal(out.models[0].states.textChat.autoEligible, false);
});

test('independent: revoking an adapter prevents retained partial-snapshot model routing', () => {
  const out = mergeSnapshot(seeded(), snapshot([], { observedAt: later, complete: false }), { adaptations: { [raw.id]: {} } });
  assert.equal(out.models[0].states.textChat.adapted, false);
  assert.equal(out.models[0].states.textChat.verified, false);
  assert.equal(out.models[0].states.textChat.autoEligible, false);
});

test('independent: explicit task false wins over supported list and snapshot sources remain isolated', () => {
  const m = normalizePtRecord({ ...raw, capabilities: { textChat: false }, supported_tasks: ['text-chat'] }, { scopeId, observedAt: at });
  assert.equal(m.tasks.textChat.value, false);
  const initial = seeded();
  const prior = JSON.stringify(initial);
  const out = mergeSnapshot(initial, snapshot([], { observedAt: later, scopeId: 'other-scope' }));
  assert.equal(out.events[0].reason, 'scope-mismatch');
  assert.equal(JSON.stringify(initial), prior);
  assert.equal(out.models[0].scopeId, scopeId);
});

test('independent: trusted non-chat endpoint does not acquire chat capability from generic qualification defaults', () => {
  const image = { id: 'review-image-model', supported_endpoint_types: ['image-generation'] };
  const out = mergeSnapshot(null, snapshot([image]), {
    permission: true,
    qualificationDefaults: { policy, adaptation: { textChat: adaptation.textChat } },
  });
  assert.equal(out.models[0].tasks.textToImage.value, true);
  assert.equal(out.models[0].tasks.textChat.value, null);
  assert.equal(out.models[0].states.textChat.autoEligible, false);
});

test('PT trusted endpoint types map to their declared chat, image, and video tasks', () => {
  const mappings = [
    ['anthropic', 'textChat', ['text'], ['text']],
    ['openai-response', 'textChat', ['text'], ['text']],
    ['image-generation', 'textToImage', ['text'], ['image']],
    ['openai-video', 'textToVideo', ['text'], ['video']],
  ];
  for (const [endpoint, task, input, output] of mappings) {
    const model = normalizePtRecord({ id: `endpoint-${endpoint}`, supported_endpoint_types: [endpoint] }, { scopeId, observedAt: at });
    assert.equal(model.tasks[task].value, true, endpoint);
    assert.deepEqual(model.inputModalities.value, input, endpoint);
    assert.deepEqual(model.outputModalities.value, output, endpoint);
    for (const other of ['textChat', 'textToImage', 'textToVideo']) {
      if (other !== task) assert.equal(model.tasks[other].value, null, `${endpoint} must not imply ${other}`);
    }
  }
});
