import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildDshChildEnv } = require('../../shell/runtime/dsh-adapter.cjs');

// Negative control only: no DSH, network, database, or real credential is used.
// This passes while the vulnerability is reproduced, and should be retired or
// inverted when the host-owned model gateway lands.
const syntheticKey = 'SYNTHETIC-BYOK-NEGATIVE-PROBE';
const env = buildDshChildEnv(process.env, { dshHome: '/tmp/t05-probe-home', powerTokensApiKey: syntheticKey });
const source = 'process.stdout.write(process.env.POWERTOKENS_API_KEY === ' + JSON.stringify(syntheticKey) + ' ? "BYOK_VISIBLE" : "BYOK_NOT_VISIBLE")';
const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', env, timeout: 5000 });
assert.equal(child.error, undefined, 'synthetic child probe spawned');
assert.equal(child.status, 0, 'synthetic child probe exited cleanly');
assert.equal(child.stdout, 'BYOK_VISIBLE', 'current DSH child environment exposes the synthetic BYOK');
console.log('EXPECTED NEGATIVE CONTROL: BYOK_VISIBLE; no external request made');
