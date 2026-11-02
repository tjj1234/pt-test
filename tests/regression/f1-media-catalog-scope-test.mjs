import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveMediaRouteForRun } = require('../../shell/models/media-route-admission.cjs');
const { resolveScopeId } = require('../../shell/models/catalog-cache.cjs');
const { DEFAULT_BASE_URL } = require('../../shell/model-catalog.cjs');

test('media admission refreshes the same credential scope as the visible catalog', async () => {
  const apiKey = 'fixture-only-key';
  const userId = 'fixture-owner';
  const visibleScope = resolveScopeId({ apiKey, baseURL: DEFAULT_BASE_URL, scopeId: userId });
  let observedScope = null;
  await assert.rejects(resolveMediaRouteForRun({
    identity: { userId }, apiKey, args: { taskType: 'text2image' },
    getCatalog: async (options) => {
      assert.equal(options.force, true);
      observedScope = resolveScopeId(options);
      return { catalogDiagnostics: { state: 'sync_failed', errorCode: 'PT_HTTP_ERROR' } };
    },
  }), { code: 'MEDIA_CATALOG_UNAVAILABLE' });
  assert.equal(observedScope, visibleScope);
});
