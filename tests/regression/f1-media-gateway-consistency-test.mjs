import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const admissionPath = fileURLToPath(new URL('../../shell/models/media-route-admission.cjs', import.meta.url));
const probe = `
  const { resolveMediaRouteForRun } = require(process.argv[1]);
  let catalogCalls = 0;
  resolveMediaRouteForRun({
    identity: { userId: 'fixture-user' }, apiKey: 'fixture-key', args: { taskType: 'text2image' },
    getCatalog: async () => { catalogCalls++; return { catalogDiagnostics: { state: 'sync_failed' } }; },
  }).then(() => console.log(JSON.stringify({ code: 'UNEXPECTED_SUCCESS', catalogCalls })),
    (error) => console.log(JSON.stringify({ code: error.code, catalogCalls, message: error.message })));
`;

function runWithBase(baseUrl) {
  const env = { ...process.env };
  if (baseUrl === null) delete env.POWERTOKENS_BASE_URL;
  else env.POWERTOKENS_BASE_URL = baseUrl;
  const child = spawnSync(process.execPath, ['-e', probe, admissionPath], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

test('official media POST base and equivalent trailing slash share the catalog gateway', () => {
  for (const base of [null, 'https://api.powertokens.ai', 'https://api.powertokens.ai/']) {
    const result = runWithBase(base);
    assert.equal(result.code, 'MEDIA_CATALOG_UNAVAILABLE');
    assert.equal(result.catalogCalls, 1);
  }
});

test('a different origin or path is rejected before catalog read or external intent', () => {
  for (const base of ['https://other.example', 'https://api.powertokens.ai/proxy', 'http://api.powertokens.ai']) {
    const result = runWithBase(base);
    assert.equal(result.code, 'MEDIA_GATEWAY_MISMATCH');
    assert.equal(result.catalogCalls, 0);
    assert.equal(result.message, 'Media model qualification failed');
  }
});
