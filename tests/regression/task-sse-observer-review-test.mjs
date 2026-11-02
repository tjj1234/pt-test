import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createRunExecutionService } = createRequire(import.meta.url)('../../shell/tasks/execution.cjs');

function fixture() {
  const events = [{ seq: 1, type: 'state' }, { seq: 2, type: 'delta' }];
  const store = { eventsAfter: async (_identity, _runId, { after, limit }) => {
    const remaining = events.filter(event => event.seq > after), page = remaining.slice(0, limit);
    return { events: page, nextCursor: page.at(-1)?.seq ?? after, hasMore: remaining.length > limit };
  } };
  // No local executor publishes: this instance observes another worker's log.
  const service = createRunExecutionService({ store, scheduler: {}, executor: async () => ({ ok: true }) });
  const identity = { userId: 'observer-review', tenantId: 'tenant-review' };
  const cleanups = [];
  async function observe(after) {
    let last = after, replaying = true;
    const received = [], pending = [];
    // Mirrors the HTTP route's per-connection replay/send cursor filtering.
    const send = event => { if (event.seq > last) { received.push(event); last = event.seq; } };
    cleanups.push(service.subscribe('shared-run', event => { if (replaying) pending.push(event); else send(event); }, { identity, after }));
    const prefix = await store.eventsAfter(identity, 'shared-run', { after, limit: 500 });
    prefix.events.forEach(send);
    replaying = false;
    pending.sort((a, b) => a.seq - b.seq).forEach(send);
    return received;
  }
  return { events, observe, close: () => cleanups.forEach(close => close()) };
}
async function until(predicate) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < 2500) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'persistent polling must deliver the remote terminal event');
}

test('future observer cursor cannot suppress live events for another connection', async t => {
  const f = fixture(); t.after(f.close);
  const future = await f.observe(100);
  const normal = await f.observe(2);
  f.events.push({ seq: 3, type: 'done' });
  await until(() => normal.some(event => event.type === 'done'));
  assert.deepEqual(normal.map(event => event.seq), [3]);
  assert.deepEqual(future, []);
});

test('observers with different replay cursors each receive ordered live terminal events once', async t => {
  const f = fixture(); t.after(f.close);
  const all = await f.observe(0), resumed = await f.observe(2);
  assert.deepEqual(all.map(event => event.seq), [1, 2]);
  assert.deepEqual(resumed, []);
  f.events.push({ seq: 3, type: 'delta' }, { seq: 4, type: 'done' });
  await until(() => all.some(event => event.type === 'done') && resumed.some(event => event.type === 'done'));
  assert.deepEqual(all.map(event => event.seq), [1, 2, 3, 4]);
  assert.deepEqual(resumed.map(event => event.seq), [3, 4]);
});
