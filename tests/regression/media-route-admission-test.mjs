import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMediaRunHandler } = require('../../shell/tasks/media-run-handler.cjs');

function fixture(resolveRoute) {
  const calls = [];
  const controller = new AbortController();
  const identity = { userId: 'owner', tenantId: 'tenant' };
  const store = { externalOperations: {
    createIntent: async () => calls.push('intent'),
    recordSubmissionResult: async () => calls.push('result'),
  } };
  let keyReads = 0;
  const handler = createMediaRunHandler({
    store, identity, taskRun: { runId: 'run', leaseOwner: 'lease', signal: controller.signal },
    loadCredential: async () => { keyReads++; return 'fixture-key-' + keyReads; },
    resolveRoute: async (input) => { calls.push('qualify'); return resolveRoute(input, controller); },
    executeMedia: async (_identity, args, opts) => {
      calls.push('execute');
      assert.equal(opts.apiKey, 'fixture-key-1');
      assert.equal(opts.requireResolvedRoute, true);
      assert.equal(opts.resolvedRoute.model, 'qualified-model');
      assert.equal(args.prompt, 'fixture');
      await opts.onExternalIntent({ provider: 'fixture' });
      await opts.onExternalResult({ outcome: 'succeeded', providerStatus: 'succeeded' });
      return { url: 'https://result.invalid/image.png' };
    },
    fetchImpl: async () => { throw new Error('unexpected network'); },
  });
  const request = { requestId: randomUUID(), name: 'media.route', args: { taskType: 'text2image', prompt: 'fixture' } };
  return { handler, request, calls, keyReads: () => keyReads };
}

test('media admission qualifies the same credential before durable intent and execution', async () => {
  const f = fixture(async ({ identity, args, apiKey }) => {
    assert.deepEqual(identity, { userId: 'owner', tenantId: 'tenant' });
    assert.equal(apiKey, 'fixture-key-1');
    args.prompt = 'resolver mutation must not alter tool args';
    return { model: 'qualified-model' };
  });
  assert.equal((await f.handler.handle(f.request)).url, 'https://result.invalid/image.png');
  await f.handler.drain();
  assert.deepEqual(f.calls, ['qualify', 'execute', 'intent', 'result']);
  assert.equal(f.keyReads(), 1);
});

test('denied or missing media qualification never records intent or invokes executor', async () => {
  for (const value of [null, undefined, [], 'route']) {
    const f = fixture(async () => value);
    await assert.rejects(f.handler.handle(f.request), { code: 'MEDIA_ROUTE_UNAVAILABLE' });
    await f.handler.drain();
    assert.deepEqual(f.calls, ['qualify']);
  }
  const f = fixture(async () => { throw Object.assign(new Error('denied'), { code: 'NO_ELIGIBLE_MEDIA_MODEL' }); });
  await assert.rejects(f.handler.handle(f.request), { code: 'NO_ELIGIBLE_MEDIA_MODEL' });
  await f.handler.drain();
  assert.deepEqual(f.calls, ['qualify']);
});

test('cancellation during catalog qualification never invokes executor', async () => {
  const f = fixture(async (_input, controller) => { controller.abort(); return { model: 'qualified-model' }; });
  await assert.rejects(f.handler.handle(f.request), { code: 'SESSION_ABORTED' });
  await f.handler.drain();
  assert.deepEqual(f.calls, ['qualify']);
});
