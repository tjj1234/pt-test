import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { callMediaRoute } = require('../../business/media/powertokens.cjs');

test('media POST normalizes an equivalent trailing slash before the PT path', async () => {
  const requested = [];
  const result = await callMediaRoute({}, { taskType: 'text2image', prompt: 'fixture' }, {
    apiKey: 'fixture-key', baseUrl: 'https://api.powertokens.ai/',
    fetchImpl: async (url, init) => {
      requested.push({ url, method: init.method });
      return { ok: true, json: async () => ({ data: [{ url: 'https://example.test/result.jpg' }] }) };
    },
  });
  assert.deepEqual(requested, [{ url: 'https://api.powertokens.ai/v1/images/generations', method: 'POST' }]);
  assert.equal(result.url, 'https://example.test/result.jpg');
});
