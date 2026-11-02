import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { admitControlledMediaAttempt } = require('../../shell/tasks/controlled-media-admission.cjs');
const { createRunBudget } = require('../../shell/tasks/budget.cjs');

const scope = 'nonsecret-current-key-scope';
const capabilityRevision = 'a'.repeat(64);
const requestA = '10000000-0000-4000-8000-000000000001';
const requestB = '10000000-0000-4000-8000-000000000002';
const route = { scopeId: scope, taskType: 'text2image', model: 'fixture-image-model',
  capabilityRevision, adapterId: 'pt-image-generations-v1', adapterVersion: '1' };
const grant = (id, runId) => ({ authorized: true, purpose: 'controlled_media_test', grantId: id,
  runId, userId: 'owner', tenantId: 'tenant', credentialScopeId: scope,
  taskType: route.taskType, modelId: route.model, capabilityRevision,
  adapterId: route.adapterId, adapterVersion: route.adapterVersion,
  maxMediaCalls: 1, maxExternalSubmissions: 1, maxRetries: 0,
  issuedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T01:00:00.000Z' });
const run = (runId) => ({ runId, userId: 'owner', tenantId: 'tenant', state: 'running', activeLease: true, leaseOwner: 'lease-owner' });
const at = () => Date.parse('2026-10-25T00:30:00.000Z');

function fakeDurableReservations() {
  const consumed = new Set(), unresolved = new Map();
  return {
    unresolved,
    reserveAttempt: async (entry) => {
      const slot = `${entry.credentialScopeId}:${entry.modelId}:${entry.taskType}`;
      if (consumed.has(entry.grantId) || unresolved.has(slot)) return { accepted: false };
      consumed.add(entry.grantId);
      unresolved.set(slot, entry.operationKey);
      return { accepted: true, reservationId: `reservation-${consumed.size}`,
        grantId: entry.grantId, operationKey: entry.operationKey,
        scopeConflictChecked: true, grantConsumed: true };
    },
    reconcile: (entry) => unresolved.delete(`${entry.credentialScopeId}:${entry.modelId}:${entry.taskType}`),
  };
}

test('one test Run consumes its grant and unknown outcome blocks a new Run on the same key/model/task', async () => {
  const ledger = fakeDurableReservations();
  const first = await admitControlledMediaAttempt({ grant: grant('grant-a', 'run-a'), run: run('run-a'),
    credentialScopeId: scope, route, requestId: requestA, reserveAttempt: ledger.reserveAttempt, now: at });
  assert.equal(first.unknownOutcomeKeepsReservation, true);
  assert.equal(first.operationKey, `run-a:${requestA}`);
  assert.equal(JSON.stringify(first).includes('apiKey'), false);
  await assert.rejects(admitControlledMediaAttempt({ grant: grant('grant-a', 'run-a'), run: run('run-a'),
    credentialScopeId: scope, route, requestId: requestB, reserveAttempt: ledger.reserveAttempt, now: at }), { code: 'MEDIA_RESERVATION_CONFLICT' });
  await assert.rejects(admitControlledMediaAttempt({ grant: grant('grant-b', 'run-b'), run: run('run-b'),
    credentialScopeId: scope, route, requestId: requestB, reserveAttempt: ledger.reserveAttempt, now: at }), { code: 'MEDIA_RESERVATION_CONFLICT' });
  // Explicit reconciliation may clear the scope slot; it never unconsumes grant-a.
  ledger.reconcile({ credentialScopeId: scope, modelId: route.model, taskType: route.taskType });
  const second = await admitControlledMediaAttempt({ grant: grant('grant-b', 'run-b'), run: run('run-b'),
    credentialScopeId: scope, route, requestId: requestB, reserveAttempt: ledger.reserveAttempt, now: at });
  assert.equal(second.runId, 'run-b');
});

test('identity, current Key scope, route, retry and lease are checked before reservation', async () => {
  let reservations = 0;
  const reserveAttempt = async () => { reservations++; throw new Error('must not reserve'); };
  const base = { grant: grant('grant-a', 'run-a'), run: run('run-a'), credentialScopeId: scope,
    route, requestId: requestA, reserveAttempt, now: at };
  await assert.rejects(admitControlledMediaAttempt({ ...base, run: { ...base.run, userId: 'other' } }), { code: 'MEDIA_GRANT_IDENTITY_MISMATCH' });
  await assert.rejects(admitControlledMediaAttempt({ ...base, credentialScopeId: 'another-key' }), { code: 'MEDIA_GRANT_IDENTITY_MISMATCH' });
  await assert.rejects(admitControlledMediaAttempt({ ...base, run: { ...base.run, activeLease: false } }), { code: 'MEDIA_GRANT_IDENTITY_MISMATCH' });
  await assert.rejects(admitControlledMediaAttempt({ ...base, route: { ...route, model: 'other-model' } }), { code: 'MEDIA_GRANT_ROUTE_MISMATCH' });
  await assert.rejects(admitControlledMediaAttempt({ ...base, retryCount: 1 }), { code: 'MEDIA_RETRY_NOT_ALLOWED' });
  await assert.rejects(admitControlledMediaAttempt({ ...base, grant: { ...base.grant, expiresAt: '2026-10-25T00:00:01.000Z' } }), { code: 'MEDIA_GRANT_INVALID' });
  assert.equal(reservations, 0);
});

test('the per-Run runtime budget allows one tool and zero retries, independent of durable cross-Run slot', () => {
  const budget = createRunBudget({ limits: { maxDurationMs: 180000, maxModelCalls: 2,
    maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0 }, now: () => 0 });
  assert.equal(budget.admit({ type: 'model' }).allowed, true);
  const media = budget.admit({ type: 'tool', key: 'media_route' });
  assert.equal(media.allowed, true);
  media.settle();
  assert.deepEqual([budget.admit({ type: 'tool', key: 'media_route' }).code,
    budget.admit({ type: 'retry' }).code], ['RUN_TOOL_CALL_LIMIT', 'RUN_RETRY_LIMIT']);
  assert.equal(budget.snapshot().costStatus, 'unlimited'); // Count cap is not a monetary cap.
});

test('a reservation receipt must prove scope conflict check and grant consumption', async () => {
  const base = { grant: grant('grant-a', 'run-a'), run: run('run-a'), credentialScopeId: scope,
    route, requestId: requestA, now: at };
  await assert.rejects(admitControlledMediaAttempt({ ...base, reserveAttempt: async (entry) => ({
    accepted: true, reservationId: 'reservation-a', grantId: entry.grantId,
    operationKey: entry.operationKey, scopeConflictChecked: false, grantConsumed: true,
  }) }), { code: 'MEDIA_RESERVATION_INVALID' });
});
