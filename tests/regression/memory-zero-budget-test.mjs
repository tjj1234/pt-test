import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../shell/package.json', import.meta.url));
const { initMemory } = require('./memory.cjs');

test('an explicit zero character budget includes no memory and is not replaced by the default', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /FROM user_memory WHERE user_id = \$1/);
      assert.deepEqual(params, ['user-1']);
      return { rows: [{ key: 'preference', value: 'always use metric', updated_at: '2026-10-22T00:00:00.000Z' }] };
    },
  };
  const memory = await initMemory(db);
  const snapshot = await memory.memorySnapshot('user-1', { maxChars: 0 });
  assert.deepEqual(snapshot.lines, []);
  assert.equal(snapshot.maxChars, 0);
  assert.equal(snapshot.includedChars, 0);
  assert.equal(snapshot.totalCount, 1);
  assert.equal(snapshot.omittedCount, 1);
  assert.deepEqual(await memory.memoryLines('user-1', { maxChars: 0 }), []);
  assert.deepEqual(await memory.memoryLines('user-1'), ['preference=always use metric']);
});
