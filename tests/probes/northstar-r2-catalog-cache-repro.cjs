'use strict';
// Development-only reproduction against an operator-supplied copy of frozen r2.
// Reads four pinned source files and writes only disposable fixture caches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const pinned = {
  'server.cjs': '64ad1cdc9cc1f7fed1f90ef918f39e8c260eee294d15730715ac766fe9eafe54',
  'model-catalog.cjs': '934719b4f542c57d34a4121fdb91639a0e393013a7b49d999b4088d71f35e73d',
  'models/catalog-cache.cjs': '05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a',
  'models/capabilities.cjs': 'b569a61b7e09da7bd41e901f5da4a16c70cebc926baa8fd0306a2d6bec72b593',
};
async function main() {
  const root = process.argv[2];
  assert.ok(root && path.isAbsolute(root) && process.argv.length === 3, 'Pass the absolute frozen r2 shell directory');
  for (const [name, digest] of Object.entries(pinned)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), digest,
      'Frozen r2 source digest differs');
  }
  globalThis.fetch = async () => { throw new Error('External fetch is prohibited'); };
  const catalog = require(path.join(root, 'model-catalog.cjs'));
  const cap = require(path.join(root, 'models/capabilities.cjs'));
  const cache = require(path.join(root, 'models/catalog-cache.cjs'));
  const rows = [];
  for (const missing of [null, 'ptEndpointTasks', 'endpoints', 'inputModalities', 'outputModalities']) {
    for (const mode of ['fresh', 'backoff', 'stale-success', 'stale-failure', 'force-success']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-catalog-frozen-fixture-'));
      let fetches = 0;
      try {
        const now = Date.now();
        const options = { apiKey: 'offline-fixture', scopeId: 'fixture', cacheDir: dir, now,
          force: mode === 'force-success', qualificationDefaults: { policy: { enabled: true, source: 'fixture', version: '1' } },
          fetchImpl: async () => { fetches++; return mode === 'stale-failure' ? { ok: false, status: 503 }
            : { ok: true, json: async () => ({ data: [{ id: 'fixture', supported_endpoint_types: ['anthropic'] }] }) }; } };
        const scopeId = cache.resolveScopeId(options);
        const observedAt = new Date(now - 2 * 86400000).toISOString();
        const model = cap.normalizePtRecord({ id: 'fixture', supported_endpoint_types: ['anthropic'] }, { scopeId, observedAt });
        if (missing) delete model[missing];
        assert.equal(cache.writeScopedCache(dir, scopeId, { scopeId, models: [model],
          lastSuccessfulAt: new Date(['fresh', 'force-success'].includes(mode) ? now : now - 2 * 86400000).toISOString(),
          ...(mode === 'backoff' ? { nextSyncAt: new Date(now + 60000).toISOString() } : {}) }), true);
        let failure = null;
        try { await catalog.getCatalog(options); } catch (error) { failure = error; }
        if (missing) assert.equal(failure?.name, 'TypeError');
        else assert.equal(failure, null, 'Complete normalized records are a passing control');
        rows.push({ missing, mode, fixtureFetches: fetches, outcome: failure ? 'TypeError' : 'returned' });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  process.stdout.write(JSON.stringify({ pinnedSourceFiles: 4, externalRequests: 0, cases: rows.length, rows }) + '\n');
}
main().catch(() => { process.stderr.write('FROZEN_R2_REPRO_FAILED\n'); process.exitCode = 1; });
