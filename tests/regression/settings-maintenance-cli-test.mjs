import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = path.resolve('scripts/northstar-profile.cjs');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-settings-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'operator-secret-value', { mode: 0o600 });
  return home;
}
const run = (home, action, extra = []) => spawnSync(process.execPath, [cli, action, '--home', home, '--offline', ...extra], { encoding: 'utf8' });
test('settings CLI inspection is read only; adoption requires reviewed caller hashes and preserves YAML', t => {
  const home = fixture(t); const before = fs.readdirSync(home);
  const inspection = run(home, 'inspect-settings'); assert.equal(inspection.status, 0, inspection.stderr);
  const expected = JSON.parse(inspection.stdout); assert.equal(expected.status, 'untracked');
  assert.deepEqual(fs.readdirSync(home), before); assert.equal(inspection.stdout.includes('operator-secret-value'), false);
  const missing = run(home, 'adopt-settings', ['--reviewed']);
  assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stderr).code, 'SETTINGS_REVIEW_REQUIRED');
  assert.deepEqual(fs.readdirSync(home), before);
  const flags = ['--reviewed', '--settings-hash', expected.settingsHash, '--template-hash', expected.templateHash, '--baseline-hash', 'none'];
  const adopted = run(home, 'adopt-settings', flags); assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(JSON.parse(adopted.stdout).status, 'current');
  assert.equal(fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8'), 'operator-secret-value');
  const stale = run(home, 'adopt-settings', flags); assert.equal(stale.status, 1); assert.equal(JSON.parse(stale.stderr).code, 'SETTINGS_REVISION_CONFLICT');
});
test('settings CLI refuses duplicate and unrelated parameters, and baseline secrets never reach output', t => {
  const home = fixture(t);
  for (const extra of [['--offline'], ['--home', home], ['--reviewed'], ['--preserve-current']]) {
    const result = run(home, 'inspect-settings', extra); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
  const baseline = { schema: 1, settingsHash: 'a'.repeat(64), templateHash: 'b'.repeat(64), adoptedAt: new Date().toISOString(), apiKey: 'baseline-secret-value' };
  fs.writeFileSync(path.join(home, '.northstar-settings-version.json'), JSON.stringify(baseline), { mode: 0o600 });
  const result = run(home, 'inspect-settings'); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'SETTINGS_BASELINE_INVALID');
  assert.equal((result.stdout + result.stderr).includes('baseline-secret-value'), false);
});
