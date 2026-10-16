import test from 'node:test';
import assert from 'node:assert/strict';
import c from '../../shell/contracts/phase1.cjs';
import runtime from '../../shell/runtime/contract.cjs';

const now = '2026-10-16T00:00:00.000Z';
const identity = { userId: 'user-a', tenantId: 'tenant-a' };
const run = () => c.bindRun(identity, { version: c.VERSION, runId: 'run-a', conversationId: 'conv-a', workspaceId: 'ws-a', state: 'queued', revision: 0, createdAt: now, policyVersion: 'policy-1' });
const event = (extra = {}) => ({ version: c.VERSION, eventId: 'evt-1', runId: 'run-a', conversationId: 'conv-a', seq: 1, type: 'queued', occurredAt: now, payload: {}, ...extra });
const models = () => ({ version: c.VERSION, modelId: 'model-1', provider: 'pt', endpointTypes: ['chat'], inputModalities: ['text'], outputModalities: ['text'], tasks: ['chat'], capabilitySource: 'pt-catalog', discovered: true, adapted: true, verified: true, autoEligible: true, observedAt: now });

test('existing runtime method and event contract is reused without a second runtime', () => {
  assert.deepEqual(c.runtimeMethods, runtime.RUNTIME_METHODS);
  assert.deepEqual(c.runtimeEvents, runtime.RUNTIME_EVENT_TYPES);
  assert.equal(Object.hasOwn(c, 'run'), false);
});
test('trusted identity binding rejects client overrides and cross-owner access', () => {
  const r = run();
  assert.equal(r.userId, identity.userId);
  assert.throws(() => c.bindRun(identity, { ...r, tenantId: 'tenant-b' }), { code: 'FORBIDDEN' });
  assert.throws(() => c.assertOwned({ ...identity, userId: 'user-b' }, r), { code: 'FORBIDDEN' });
  assert.throws(() => c.assertOwned({ ...identity, tenantId: 'tenant-b' }, r), { code: 'FORBIDDEN' });
  assert.equal(c.assertOwned(identity, r), r);
});
test('run state changes are immutable, revision checked, and terminal states cannot reopen', () => {
  const original = run();
  const active = c.transitionRun(original, 'running', 0);
  assert.equal(original.state, 'queued');
  assert.equal(active.revision, 1);
  assert.throws(() => c.transitionRun(active, 'waiting_external', 0), { code: 'REVISION_CONFLICT' });
  const external = c.transitionRun(active, 'waiting_external', 1);
  const stopping = c.transitionRun(external, 'cancelling', 2);
  assert.equal(stopping.state, 'cancelling');
  for (const state of c.TERMINAL_STATES) {
    const terminal = c.transitionRun(stopping, state, 3);
    assert.throws(() => c.transitionRun(terminal, 'running', 4), { code: 'INVALID_TRANSITION' });
  }
  assert.throws(() => c.transitionRun(original, 'waiting_external', 0), { code: 'INVALID_TRANSITION' });
});
test('late completion while cancelling remains a truthful completed result', () => {
  const stopping = c.transitionRun(c.transitionRun(run(), 'running', 0), 'cancelling', 1);
  assert.equal(c.transitionRun(stopping, 'completed', 2).state, 'completed');
});
test('external unknown outcome is a reconciliation marker, not automatic re-execution', () => {
  assert.deepEqual(c.validate('run', { ...run(), reconciliation: 'needs_reconciliation' }), []);
  assert.notDeepEqual(c.validate('run', { ...run(), reconciliation: 'retry_automatically' }), []);
});
test('events require scope, sequence, unique adjacent IDs, versions and semantic links', () => {
  const first = c.assertEventAfter(null, event(), run());
  assert.equal(c.assertEventAfter(first, event({ eventId: 'evt-2', seq: 2, type: 'delta' }), run()).seq, 2);
  for (const invalid of [{ runId: 'other' }, { conversationId: 'other' }]) assert.throws(() => c.assertEventAfter(null, event(invalid), run()), { code: 'EVENT_SCOPE_MISMATCH' });
  for (const invalid of [{ seq: 3, eventId: 'evt-3' }, { seq: 2 }]) assert.throws(() => c.assertEventAfter(first, event(invalid), run()), { code: 'EVENT_SEQUENCE_CONFLICT' });
  assert.throws(() => c.assertEventAfter(null, event({ seq: 2 }), run()), { code: 'EVENT_SEQUENCE_CONFLICT' });
  for (const invalid of [{ version: '2.0' }, { occurredAt: 'yesterday' }, { type: 'tool.finished' }, { type: 'artifact.ready' }]) assert.throws(() => c.assertContract('event', event(invalid)), { code: 'CONTRACT_INVALID' });
  assert.deepEqual(c.validate('event', event({ type: 'tool.finished', callId: 'call-a', payload: { state: 'succeeded' } })), []);
});
test('unknown actual model and usage source remain null; denied tools cannot execute', () => {
  const attempt = { version: c.VERSION, attemptId: 'attempt-a', runId: 'run-a', requestedModel: 'AUTO', resolvedModel: 'model-1', reportedModel: null, provider: 'pt', endpointType: 'chat', capability: 'chat', requestId: null, state: 'running', usageSource: null };
  assert.deepEqual(c.validate('attempt', attempt), []);
  assert.notDeepEqual(c.validate('attempt', { ...attempt, resolvedModel: null }), []);
  const tool = { version: c.VERSION, callId: 'call-a', runId: 'run-a', toolId: 'tool-a', toolVersion: '1', category: 'mcp', authorization: 'denied', state: 'pending' };
  assert.deepEqual(c.validate('tool', tool), []);
  assert.notDeepEqual(c.validate('tool', { ...tool, state: 'running' }), []);
  assert.notDeepEqual(c.validate('tool', { ...tool, state: 'succeeded' }), []);
});
test('attachment and artifact metadata retain ownership, revisions and constrained storage keys', () => {
  const a = { version: c.VERSION, attachmentId: 'att-a', ...identity, workspaceId: 'ws-a', sha256: 'a'.repeat(64), mediaType: 'application/pdf', byteLength: 0, parserVersion: null, state: 'uploaded', sources: [] };
  assert.deepEqual(c.validate('attachment', a), []);
  assert.notDeepEqual(c.validate('attachment', { ...a, byteLength: -1 }), []);
  assert.deepEqual(c.validate('attachment', { ...a, sources: [{ kind: 'page', locator: '3' }] }), []);
  assert.notDeepEqual(c.validate('attachment', { ...a, sources: [{}] }), []);
  const artifact = { version: c.VERSION, artifactId: 'art-a', runId: 'run-a', ...identity, workspaceId: 'ws-a', revision: 1, sha256: 'b'.repeat(64), storageKey: 'run-a/report.pdf', mediaType: 'application/pdf', state: 'ready' };
  assert.deepEqual(c.validate('artifact', artifact), []);
  for (const storageKey of ['../secret', '/secret', 'C:/secret', 'run-a/../secret', 'run-a\\secret', 'run-a//secret', 'run-a/\0secret']) assert.notDeepEqual(c.validate('artifact', { ...artifact, storageKey }), [], storageKey);
});
test('unverified or unsupported models cannot enter AUTO', () => {
  assert.deepEqual(c.validate('model', models()), []);
  for (const patch of [{ verified: false }, { adapted: false }, { discovered: false }, { capabilitySource: null }, { tasks: [] }, { endpointTypes: [] }]) assert.notDeepEqual(c.validate('model', { ...models(), ...patch }), []);
  assert.deepEqual(c.validate('model', { ...models(), autoEligible: false, verified: false, capabilitySource: null, tasks: [] }), []);
});
test('idempotency is identity-scoped, stable for reordered JSON, and conflicts do not replay', () => {
  const claim = c.idempotencyClaim(identity, 'create-run', 'client-key', { question: 'hello', attachments: ['a'], options: { b: 2, a: 1 } });
  const same = c.idempotencyClaim(identity, 'create-run', 'client-key', { options: { a: 1, b: 2 }, attachments: ['a'], question: 'hello' });
  assert.deepEqual(claim, same);
  assert.equal(c.compareIdempotency(null, claim), 'new');
  const existing = { ...claim, runId: 'original-run' };
  assert.equal(c.compareIdempotency(existing, same), 'replay');
  assert.throws(() => c.compareIdempotency(existing, c.idempotencyClaim(identity, 'create-run', 'client-key', { question: 'different' })), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  for (const other of [{ ...identity, userId: 'other' }, { ...identity, tenantId: 'other' }]) assert.notEqual(c.idempotencyClaim(other, 'create-run', 'client-key', {}).scope, claim.scope);
  assert.throws(() => c.compareIdempotency(existing, c.idempotencyClaim(identity, 'other-operation', 'client-key', {})), { code: 'IDEMPOTENCY_SCOPE_MISMATCH' });
});
test('fingerprints reject non-JSON values rather than silently colliding', () => {
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), { a: undefined }, new Array(1)]) assert.throws(() => c.fingerprint(value), TypeError);
  assert.notEqual(c.fingerprint([1, 2]), c.fingerprint([2, 1]));
  assert.notEqual(c.fingerprint(null), c.fingerprint('null'));
});
