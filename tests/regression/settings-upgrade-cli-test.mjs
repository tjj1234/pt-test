import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inspectSettings, adoptSettings } = require('../../shell/runtime/settings-version.cjs');
const { upgradeSettings } = require('../../shell/runtime/settings-upgrade.cjs');
const STATE = '.northstar-settings-version.json';
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-upgrade-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const release = path.join(temp, 'release'); fs.mkdirSync(path.join(release, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(release, 'shell/runtime'), { recursive: true });
  const cli = path.join(release, 'scripts/northstar-profile.cjs'); fs.copyFileSync(path.resolve('scripts/northstar-profile.cjs'), cli);
  // Copy unmodified production modules; no DSH execution, dependency installation, or module stubs.
  for (const name of ['dsh-adapter.cjs', 'contract.cjs', 'artifacts.cjs', 'usage.cjs', 'settings-version.cjs', 'settings-upgrade.cjs']) fs.copyFileSync(path.resolve('shell/runtime', name), path.join(release, 'shell/runtime', name));
  const template = path.join(release, 'shell/dsh-settings.yaml'); fs.writeFileSync(template, 'old release template');
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'old release template', { mode: 0o600 });
  adoptSettings({ home, template, expected: inspectSettings({ home, template }), reviewed: true });
  const oldBaseline = fs.readFileSync(path.join(home, STATE), 'utf8');
  fs.writeFileSync(template, 'new release template');
  return { home, template, cli, oldBaseline };
}
const run = (args, action, flags = []) => spawnSync(process.execPath, [args.cli, action, '--home', args.home, '--offline', ...flags], { encoding: 'utf8' });
const flagsFor = expected => ['--reviewed', '--settings-hash', expected.settingsHash, '--template-hash', expected.templateHash, '--baseline-hash', expected.baselineHash];
function pending(args) {
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (path.basename(target) === STATE) throw new Error('injected'); return rename(source, target); };
  try { assert.throws(() => upgradeSettings({ ...args, expected: inspectSettings(args), reviewed: true, offline: true }), { code: 'SETTINGS_RECOVERY_REQUIRED' }); }
  finally { fs.renameSync = rename; }
}
test('upgrade CLI requires operator supplied hashes/review and upgrades only with exact inspected revision', t => {
  const args = fixture(t);
  const expected = JSON.parse(run(args, 'inspect-settings').stdout); assert.equal(expected.status, 'template-drift');
  const flags = flagsFor(expected);
  for (const incomplete of [[], ['--reviewed'], flags.slice(1), flags.slice(0, -2)]) {
    const result = run(args, 'upgrade-settings', incomplete); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'SETTINGS_REVIEW_REQUIRED');
    assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release template');
  }
  const stale = run(args, 'upgrade-settings', flagsFor({ ...expected, settingsHash: 'a'.repeat(64) })); assert.equal(stale.status, 1); assert.equal(JSON.parse(stale.stderr).code, 'SETTINGS_REVISION_CONFLICT');
  const upgraded = run(args, 'upgrade-settings', flags); assert.equal(upgraded.status, 0, upgraded.stderr);
  const result = JSON.parse(upgraded.stdout); assert.equal(result.status, 'upgraded'); assert.equal(upgraded.stdout.includes('new release template'), false);
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'new release template');
  assert.equal(fs.readFileSync(path.join(args.home, result.transaction, 'old-baseline.json'), 'utf8'), args.oldBaseline);
  const current = JSON.parse(run(args, 'inspect-settings').stdout);
  const unchanged = run(args, 'upgrade-settings', flagsFor(current)); assert.equal(unchanged.status, 1); assert.equal(JSON.parse(unchanged.stderr).code, 'SETTINGS_UPGRADE_NOT_REQUIRED');
});
test('upgrade CLI rejects adopted custom configuration without replacing YAML or baseline', t => {
  const args = fixture(t); fs.writeFileSync(args.template, 'old release template');
  fs.writeFileSync(path.join(args.home, 'settings.yaml'), 'custom secret settings');
  adoptSettings({ ...args, expected: inspectSettings(args), reviewed: true });
  const baseline = fs.readFileSync(path.join(args.home, STATE), 'utf8'); fs.writeFileSync(args.template, 'new release template');
  const result = run(args, 'upgrade-settings', flagsFor(JSON.parse(run(args, 'inspect-settings').stdout)));
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'SETTINGS_OPERATOR_EDITS');
  assert.equal(result.stderr.includes('custom secret settings'), false);
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'custom secret settings');
  assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), baseline);
});
test('recovery CLI inspection is read only and rollback requires reviewed exact journal hash', t => {
  const args = fixture(t); pending(args);
  const before = fs.readdirSync(args.home); const inspected = run(args, 'inspect-settings-recovery'); assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(fs.readdirSync(args.home), before); assert.equal(inspected.stdout.includes('release template'), false);
  const journalHash = JSON.parse(inspected.stdout).journalHash;
  for (const flags of [[], ['--reviewed'], ['--journal-hash', journalHash]]) { const result = run(args, 'rollback-settings', flags); assert.equal(result.status, 1); }
  const wrong = run(args, 'rollback-settings', ['--reviewed', '--journal-hash', 'a'.repeat(64)]); assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stderr).code, 'SETTINGS_REVISION_CONFLICT');
  const result = run(args, 'rollback-settings', ['--reviewed', '--journal-hash', journalHash]); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release template'); assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), args.oldBaseline);
});
test('upgrade and recovery CLI reject duplicate, cross-action and missing offline arguments', t => {
  const args = fixture(t);
  for (const [action, flags] of [['upgrade-settings', ['--offline']], ['upgrade-settings', ['--journal-hash', 'a'.repeat(64)]], ['inspect-settings-recovery', ['--reviewed']], ['rollback-settings', ['--template-hash', 'b'.repeat(64)]]]) {
    const result = run(args, action, flags); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
  const result = spawnSync(process.execPath, [args.cli, 'upgrade-settings', '--home', args.home], { encoding: 'utf8' }); assert.equal(result.status, 1);
});
