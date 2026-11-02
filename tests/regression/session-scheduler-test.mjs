import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSessionScheduler } = require('../../shell/runtime/session-scheduler.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function controlled(scheduler, { runId, userId = 'u', sessionId = runId, processId = 'p', context = {}, onStart } = {}) {
  const started = deferred();
  const gate = deferred();
  let callCount = 0;
  let received;
  const handle = scheduler.submit({ runId, userId, sessionId, processId, context, execute: async (args) => {
    callCount++;
    received = args;
    started.resolve(args);
    if (onStart) onStart(args);
    return gate.promise;
  } });
  return { ...handle, started: started.promise, release: gate.resolve, reject: gate.reject, calls: () => callCount, received: () => received };
}

test('default concurrency is four Runs per account and sixteen globally', async () => {
  const s = createSessionScheduler();
  const sameAccount = Array.from({ length: 5 }, (_, i) => controlled(s, { runId: `default-user-${i}`, userId: 'same-account' }));
  const otherAccounts = Array.from({ length: 13 }, (_, i) => controlled(s, { runId: `default-global-${i}`, userId: `account-${i}` }));
  const all = [...sameAccount, ...otherAccounts];
  await Promise.all(all.slice(0, 4).map((x) => x.started));
  await Promise.all(otherAccounts.slice(0, 12).map((x) => x.started));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.stats(), { running: 16, queued: 2, active: 18, closed: false });
  assert.equal(sameAccount[4].calls(), 0, 'fifth Run for one account stays queued at the per-account cap');
  assert.equal(otherAccounts[12].calls(), 0, 'seventeenth global Run stays queued at the global cap');
  const closing = s.close();
  all.filter((x) => x.calls()).forEach((x) => x.release('close fixture'));
  await closing;
  await Promise.allSettled(all.map((x) => x.result));
  assert.deepEqual(s.stats(), { running: 0, queued: 0, active: 0, closed: true });
});

test('two sessions overlap; one session FIFO and immutable run context remain isolated', async () => {
  const s = createSessionScheduler({ perUserLimit: 2, globalLimit: 3 });
  const original = { nested: { value: 'one' }, runId: 'spoof' };
  const a = controlled(s, { runId: 'a', sessionId: 'same', context: original });
  const next = controlled(s, { runId: 'a2', sessionId: 'same' });
  const b = controlled(s, { runId: 'b' });
  const [ctxA, ctxB] = await Promise.all([a.started, b.started]);
  assert.deepEqual(s.stats(), { running: 2, queued: 1, active: 3, closed: false });
  assert.equal(next.calls(), 0);
  original.nested.value = 'mutated';
  assert.equal(ctxA.context.nested.value, 'one');
  assert.equal(ctxA.context.runId, 'a');
  assert.equal(ctxB.context.runId, 'b');
  assert.notEqual(ctxA.context, ctxB.context);
  assert.throws(() => { ctxA.context.nested.value = 'bad'; }, TypeError);
  a.release('a done');
  assert.equal(await a.result, 'a done');
  await next.started;
  assert.equal(b.getState(), 'running', 'second session still overlaps next same-session task');
  next.release('next'); b.release('b');
  await Promise.all([next.result, b.result]);
  assert.deepEqual(s.stats(), { running: 0, queued: 0, active: 0, closed: false });
  await s.close();
});

test('user and global quotas let unrelated eligible work bypass a blocked user', async () => {
  const s = createSessionScheduler({ perUserLimit: 1, globalLimit: 2 });
  const a = controlled(s, { runId: 'a', userId: 'a' });
  const a2 = controlled(s, { runId: 'a2', userId: 'a' });
  const b = controlled(s, { runId: 'b', userId: 'b' });
  const c = controlled(s, { runId: 'c', userId: 'c' });
  await Promise.all([a.started, b.started]);
  assert.equal(a2.calls(), 0); assert.equal(c.calls(), 0);
  b.release(); await b.result; await c.started;
  assert.equal(a2.calls(), 0);
  c.release(); a.release();
  await Promise.all([c.result, a.result]); await a2.started;
  a2.release(); await a2.result; await s.close();
});

test('queued cancellation never executes; running cancellation waits actual convergence before releasing quota', async () => {
  const s = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });
  const a = controlled(s, { runId: 'a' });
  const queued = controlled(s, { runId: 'queued' });
  const next = controlled(s, { runId: 'next' });
  await a.started;
  await queued.cancel();
  await assert.rejects(queued.result, { code: 'SCHEDULER_CANCELLED' });
  assert.equal(queued.calls(), 0);
  const cancelled = a.cancel();
  assert.equal(a.received().signal.aborted, true);
  assert.equal(a.getState(), 'running');
  assert.equal(s.stats().running, 1);
  assert.equal(next.calls(), 0, 'AbortSignal alone must not release quota');
  a.release('late result');
  assert.equal((await cancelled).state, 'cancelled');
  await assert.rejects(a.result, { code: 'SCHEDULER_CANCELLED' });
  await next.started;
  next.release('ok'); assert.equal(await next.result, 'ok');
  await s.close();
});

test('cancelling one concurrent session does not abort another; rejection cleans resources', async () => {
  const s = createSessionScheduler({ perUserLimit: 2, globalLimit: 2 });
  const a = controlled(s, { runId: 'a' }); const b = controlled(s, { runId: 'b' });
  await Promise.all([a.started, b.started]);
  const stopped = a.cancel();
  assert.equal(b.received().signal.aborted, false);
  a.reject(new Error('executor stopped'));
  await stopped; await assert.rejects(a.result, { code: 'SCHEDULER_CANCELLED' });
  b.reject(new Error('upstream failure'));
  await assert.rejects(b.result, /upstream failure/);
  assert.equal(b.getState(), 'failed');
  assert.equal(s.stats().active, 0);
  const clean = controlled(s, { runId: 'clean' }); await clean.started;
  clean.release('reused'); assert.equal(await clean.result, 'reused');
  await s.close();
});

test('shared process failure marks affected queued and running tasks without killing unrelated process work', async () => {
  const s = createSessionScheduler({ perUserLimit: 2, globalLimit: 3 });
  const a = controlled(s, { runId: 'a', processId: 'broken' });
  const a2 = controlled(s, { runId: 'a2', sessionId: 'a', processId: 'broken' });
  const b = controlled(s, { runId: 'b', processId: 'broken' });
  const other = controlled(s, { runId: 'other', userId: 'v', processId: 'healthy' });
  await Promise.all([a.started, b.started, other.started]);
  const failure = s.failProcess('broken', new Error('process exited'));
  assert.equal(a.received().signal.aborted, true);
  assert.equal(b.received().signal.aborted, true);
  assert.equal(other.received().signal.aborted, false);
  assert.equal(a2.calls(), 0);
  await assert.rejects(a2.result, { code: 'PROCESS_FAILED' });
  assert.equal(s.stats().running, 3, 'failed process tasks retain slots until executor acknowledges');
  a.release(); b.reject(new Error('process exit acknowledged'));
  assert.deepEqual((await failure).map((x) => x.state), ['failed', 'failed', 'failed']);
  await assert.rejects(a.result, { code: 'PROCESS_FAILED' });
  await assert.rejects(b.result, { code: 'PROCESS_FAILED' });
  assert.throws(() => controlled(s, { runId: 'new', processId: 'broken' }), { code: 'PROCESS_FAILED' });
  other.release('unaffected'); assert.equal(await other.result, 'unaffected');
  await s.close();
});

test('dispose and close reject new work, skip queued execution and await running settlement', async () => {
  const s = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });
  const a = controlled(s, { runId: 'a', sessionId: 'session' });
  const queued1 = controlled(s, { runId: 'q1', sessionId: 'session' });
  const queued2 = controlled(s, { runId: 'q2', sessionId: 'session' });
  await a.started;
  const disposal = s.disposeSession({ userId: 'u', sessionId: 'session' });
  assert.throws(() => controlled(s, { runId: 'reopen', sessionId: 'session' }), { code: 'SESSION_DISPOSED' });
  assert.equal(queued1.calls() + queued2.calls(), 0);
  a.release(); await disposal;
  for (const h of [a, queued1, queued2]) await assert.rejects(h.result, { code: 'SCHEDULER_CANCELLED' });
  const last = controlled(s, { runId: 'last' });
  const pending = controlled(s, { runId: 'pending' });
  await last.started;
  const close = s.close(); assert.equal(s.close(), close);
  assert.throws(() => controlled(s, { runId: 'closed' }), { code: 'SCHEDULER_CLOSED' });
  assert.equal(pending.calls(), 0);
  assert.equal(s.stats().running, 1);
  last.release(); await close;
  await assert.rejects(last.result, { code: 'SCHEDULER_CANCELLED' });
  await assert.rejects(pending.result, { code: 'SCHEDULER_CANCELLED' });
  assert.deepEqual(s.stats(), { running: 0, queued: 0, active: 0, closed: true });
});

test('invalid limits, duplicate active IDs and throwing executors fail visibly', async () => {
  assert.throws(() => createSessionScheduler({ globalLimit: 0 }), TypeError);
  const s = createSessionScheduler();
  const a = controlled(s, { runId: 'a' });
  assert.throws(() => controlled(s, { runId: 'a' }), { code: 'DUPLICATE_RUN' });
  const failed = s.submit({ runId: 'bad', userId: 'v', sessionId: 's', processId: 'p', execute() { throw new Error('sync throw'); } });
  await assert.rejects(failed.result, /sync throw/);
  a.release(); await a.result;
  assert.equal(s.stats().active, 0); await s.close();
});

test('adversarial: three same-session tasks retain FIFO while identical session labels across users overlap', async () => {
  const s = createSessionScheduler({ perUserLimit: 3, globalLimit: 3 });
  const starts = [];
  const a = controlled(s, { runId: 'a', sessionId: 'shared-label', onStart: () => starts.push('a') });
  const a2 = controlled(s, { runId: 'a2', sessionId: 'shared-label', onStart: () => starts.push('a2') });
  const a3 = controlled(s, { runId: 'a3', sessionId: 'shared-label', onStart: () => starts.push('a3') });
  const b = controlled(s, { runId: 'b', userId: 'other-user', sessionId: 'shared-label', onStart: () => starts.push('b') });
  await Promise.all([a.started, b.started]);
  assert.deepEqual(starts, ['a', 'b']);
  a.release(); await a.result; await a2.started;
  assert.equal(a3.calls(), 0);
  a2.release(); await a2.result; await a3.started;
  assert.deepEqual(starts, ['a', 'b', 'a2', 'a3']);
  a3.release(); b.release(); await Promise.all([a3.result, b.result]); await s.close();
});

test('adversarial: repeated cancellation shares settlement and failure overrides ordinary cancel', async () => {
  const s = createSessionScheduler({ globalLimit: 1 });
  const a = controlled(s, { runId: 'a' }); await a.started;
  const first = a.cancel();
  assert.equal(s.cancel('a'), first);
  assert.equal(a.cancel(), first);
  const processFailure = s.failProcess('p', new Error('process died after cancel'));
  assert.equal(s.stats().running, 1);
  a.release('late-success');
  assert.equal((await first).state, 'failed');
  await processFailure;
  await assert.rejects(a.result, { code: 'PROCESS_FAILED' });
  assert.equal(a.getState(), 'failed');
  assert.equal(s.stats().active, 0); await s.close();
});

test('adversarial: abort callback cannot admit replacement into an unreleased quota', async () => {
  const s = createSessionScheduler({ perUserLimit: 1, globalLimit: 1 });
  let replacement;
  const a = controlled(s, { runId: 'a', onStart: ({ signal }) => {
    signal.addEventListener('abort', () => { replacement = controlled(s, { runId: 'replacement', processId: 'new-process' }); }, { once: true });
  } });
  await a.started;
  const stopped = a.cancel();
  assert.ok(replacement);
  assert.equal(replacement.calls(), 0);
  assert.equal(s.stats().running, 1);
  a.reject(new Error('abort acknowledged')); await stopped;
  await assert.rejects(a.result, { code: 'SCHEDULER_CANCELLED' });
  await replacement.started; replacement.release('after-convergence');
  assert.equal(await replacement.result, 'after-convergence'); await s.close();
});

test('adversarial: disposing a purely queued session never starts any of its tasks', async () => {
  const s = createSessionScheduler({ globalLimit: 1 });
  const blocker = controlled(s, { runId: 'blocker', processId: 'other-process' });
  const q1 = controlled(s, { runId: 'q1', sessionId: 'dispose' });
  const q2 = controlled(s, { runId: 'q2', sessionId: 'dispose' });
  await blocker.started;
  const disposed = await s.disposeSession({ userId: 'u', sessionId: 'dispose' });
  assert.deepEqual(disposed.map((r) => r.state), ['cancelled', 'cancelled']);
  assert.equal(q1.calls() + q2.calls(), 0);
  for (const h of [q1, q2]) await assert.rejects(h.result, { code: 'SCHEDULER_CANCELLED' });
  assert.equal(blocker.received().signal.aborted, false);
  blocker.release(); await blocker.result; await s.close();
});

test('adversarial: completed handle cannot be retroactively cancelled; malformed contexts never execute', async () => {
  const s = createSessionScheduler();
  const a = controlled(s, { runId: 'a' }); await a.started; a.release('final');
  assert.equal(await a.result, 'final');
  assert.equal((await a.cancel()).state, 'completed');
  assert.equal(a.received().signal.aborted, false);
  for (const context of [null, [], { invalid: undefined }]) assert.throws(() => controlled(s, { runId: 'invalid', context }), TypeError);
  assert.equal(s.stats().active, 0); await s.close();
});

test('regression: close publishes its shared completion before synchronous abort-listener reentry', async () => {
  const s = createSessionScheduler();
  let reentrantClose;
  const a = controlled(s, { runId: 'close-reentrant', onStart: ({ signal }) => {
    signal.addEventListener('abort', () => { reentrantClose = s.close(); }, { once: true });
  } });
  await a.started;
  const outerClose = s.close();
  assert.equal(reentrantClose, outerClose);
  assert.equal(s.close(), outerClose);
  assert.equal(s.stats().running, 1, 'shared promise must still await actual convergence');
  a.release('late result');
  await outerClose;
  await assert.rejects(a.result, { code: 'SCHEDULER_CANCELLED' });
  assert.deepEqual(s.stats(), { running: 0, queued: 0, active: 0, closed: true });
});
