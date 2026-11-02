import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { inspectSettings, adoptSettings } = require('../../shell/runtime/settings-version.cjs');
const { upgradeSettings, recoverSettings, inspectSettingsRecovery } = require('../../shell/runtime/settings-upgrade.cjs');
const STATE = '.northstar-settings-version.json';
const JOURNAL = '.northstar-settings-upgrade-journal.json';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-upgrade-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const template = path.join(home, 'template.yaml');
  fs.writeFileSync(template, 'old release'); fs.writeFileSync(path.join(home, 'settings.yaml'), 'old release', { mode: 0o600 });
  adoptSettings({ home, template, expected: inspectSettings({ home, template }), reviewed: true });
  const oldBaseline = fs.readFileSync(path.join(home, STATE), 'utf8');
  fs.writeFileSync(template, 'new release');
  return { home, template, oldBaseline };
}
const upgrade = args => upgradeSettings({ ...args, expected: inspectSettings(args), reviewed: true, offline: true });
const recover = args => recoverSettings({ ...args, expectedJournalHash: inspectSettingsRecovery(args).journalHash, reviewed: true, offline: true });
function pending(args, destination) {
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (path.basename(target) === destination) throw Object.assign(new Error('injected'), { code: 'EIO' }); return rename(source, target); };
  try { assert.throws(() => upgrade(args), { code: 'SETTINGS_RECOVERY_REQUIRED' }); }
  finally { fs.renameSync = rename; }
}
test('explicit pristine tracked upgrade preserves old pair, publishes new pair and private evidence', t => {
  const args = fixture(t); const result = upgrade(args);
  assert.equal(result.status, 'upgraded'); assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'new release');
  assert.equal(inspectSettings(args).status, 'current');
  const transaction = path.join(args.home, result.transaction);
  assert.equal(fs.readFileSync(path.join(transaction, 'old-settings.yaml'), 'utf8'), 'old release');
  assert.equal(fs.readFileSync(path.join(transaction, 'old-baseline.json'), 'utf8'), args.oldBaseline);
  assert.equal(fs.statSync(transaction).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(transaction)) assert.equal(fs.statSync(path.join(transaction, name)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(args.home, JOURNAL)), false);
  assert.equal(JSON.stringify(result).includes('new release'), false);
});
test('upgrade refuses edited, untracked, unreviewed, online, stale and unchanged-template states', t => {
  const args = fixture(t); const expected = inspectSettings(args);
  for (const options of [{}, { reviewed: true }, { offline: true }]) assert.throws(() => upgradeSettings({ ...args, expected, ...options }), { code: 'SETTINGS_REVIEW_REQUIRED' });
  assert.throws(() => upgradeSettings({ ...args, expected: { ...expected, templateHash: 'a'.repeat(64) }, reviewed: true, offline: true }), { code: 'SETTINGS_REVISION_CONFLICT' });
  fs.writeFileSync(path.join(args.home, 'settings.yaml'), 'operator secret edits');
  assert.throws(() => upgrade(args), { code: 'SETTINGS_OPERATOR_EDITS' });
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'operator secret edits');
  fs.writeFileSync(path.join(args.home, 'settings.yaml'), 'old release'); fs.writeFileSync(args.template, 'old release');
  assert.throws(() => upgrade(args), { code: 'SETTINGS_UPGRADE_NOT_REQUIRED' });
  fs.unlinkSync(path.join(args.home, STATE)); assert.throws(() => upgrade(args), { code: 'SETTINGS_REVIEW_REQUIRED' });
});
for (const destination of ['settings.yaml', STATE, 'completed-journal.json']) test(`failure at ${destination} leaves recoverable journal and exact old pair backup`, t => {
  const args = fixture(t); pending(args, destination);
  assert.throws(() => inspectSettings(args), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  assert.throws(() => adoptSettings({ ...args, expected: { settingsHash: 'a'.repeat(64), templateHash: 'b'.repeat(64), baselineHash: 'c'.repeat(64) }, reviewed: true }), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  const evidence = inspectSettingsRecovery(args); assert.equal(JSON.stringify(evidence).includes('old release'), false);
  assert.throws(() => recoverSettings({ ...args, expectedJournalHash: 'd'.repeat(64), reviewed: true, offline: true }), { code: 'SETTINGS_REVISION_CONFLICT' });
  assert.equal(recover(args).status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release');
  assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), args.oldBaseline);
  assert.equal(inspectSettings(args).status, 'template-drift');
});
test('rollback publication failure can be retried without losing either pair', t => {
  const args = fixture(t); pending(args, 'completed-journal.json');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (path.basename(target) === STATE) throw new Error('injected'); return rename(source, target); };
  try { assert.throws(() => recover(args), { code: 'SETTINGS_RECOVERY_REQUIRED' }); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release');
  assert.equal(recover(args).status, 'rolled-back'); assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), args.oldBaseline);
});
test('recovery refuses unknown operator bytes and damaged backup without overwriting anything', t => {
  const args = fixture(t); pending(args, STATE);
  fs.writeFileSync(path.join(args.home, 'settings.yaml'), 'operator changed during outage');
  assert.throws(() => recoverSettings({ ...args, expectedJournalHash: 'a'.repeat(64), reviewed: true, offline: true }), { code: 'SETTINGS_REVISION_CONFLICT' });
  assert.throws(() => inspectSettingsRecovery(args), { code: 'SETTINGS_RECOVERY_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'operator changed during outage');
  const journal = JSON.parse(fs.readFileSync(path.join(args.home, JOURNAL), 'utf8'));
  fs.writeFileSync(path.join(args.home, journal.transaction, 'old-settings.yaml'), 'corrupt');
  assert.throws(() => inspectSettingsRecovery(args), { code: 'SETTINGS_UPGRADE_INVALID' });
});
test('journal arbitrary paths, extra fields, symlinks and unsafe evidence are rejected', t => {
  const args = fixture(t); pending(args, STATE);
  const journalPath = path.join(args.home, JOURNAL); const original = fs.readFileSync(journalPath);
  const journal = JSON.parse(original);
  for (const bad of [null, { ...journal, transaction: '../outside' }, { ...journal, secret: 'secret' }]) {
    fs.writeFileSync(journalPath, JSON.stringify(bad)); assert.throws(() => inspectSettingsRecovery(args), { code: 'SETTINGS_UPGRADE_INVALID' });
  }
  fs.writeFileSync(journalPath, original); fs.chmodSync(journalPath, 0o666);
  assert.throws(() => inspectSettingsRecovery(args), { code: 'SETTINGS_FILE_UNSAFE' });
  fs.chmodSync(journalPath, 0o600); fs.unlinkSync(journalPath); fs.symlinkSync(args.template, journalPath);
  assert.throws(() => inspectSettingsRecovery(args));
});
test('active maintenance owner cannot be stolen even with matching token', t => {
  const args = fixture(t); pending(args, STATE);
  const token = 'a'.repeat(32); const lock = path.join(args.home, '.northstar-settings-version.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  assert.throws(() => recoverSettings({ ...args, expectedJournalHash: inspectSettingsRecovery(args).journalHash, reviewed: true, offline: true, staleLockToken: token }), { code: 'SETTINGS_LOCKED' });
  assert.equal(fs.existsSync(lock), true);
});
test('pre-journal staging failure preserves installed pair and leaves evidence without blocking inspect', t => {
  const args = fixture(t); const write = fs.writeFileSync;
  fs.writeFileSync = (filename, ...rest) => { if (typeof filename === 'string' && path.basename(filename) === 'manifest.json') throw new Error('injected'); return write(filename, ...rest); };
  try { assert.throws(() => upgrade(args), /injected/); } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release');
  assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), args.oldBaseline);
  assert.equal(fs.existsSync(path.join(args.home, JOURNAL)), false);
  assert.equal(inspectSettings(args).status, 'template-drift');
  assert.equal(fs.readdirSync(args.home).some(name => name.startsWith('.northstar-settings-upgrade-')), true);
});
test('process crash recovery requires matching dead owner token and expected journal hash', t => {
  const args = fixture(t);
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const {inspectSettings} = require('./shell/runtime/settings-version.cjs');
    const {upgradeSettings} = require('./shell/runtime/settings-upgrade.cjs');
    const home = process.argv[1], template = process.argv[2];
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => { if (path.basename(target) === '.northstar-settings-version.json') process.exit(73); return rename(source, target); };
    upgradeSettings({home, template, expected: inspectSettings({home, template}), reviewed:true, offline:true});
  `, args.home, args.template], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const owner = JSON.parse(fs.readFileSync(path.join(args.home, '.northstar-settings-version.lock'), 'utf8'));
  const expectedJournalHash = inspectSettingsRecovery(args).journalHash;
  const input = { ...args, expectedJournalHash, reviewed: true, offline: true };
  assert.throws(() => recoverSettings({ ...input, staleLockToken: 'b'.repeat(32) }), { code: 'SETTINGS_LOCKED' });
  assert.equal(recoverSettings({ ...input, staleLockToken: owner.token }).status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'old release');
  assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), args.oldBaseline);
});

test('reviewed adoption of custom YAML does not authorize replacement by an entire release template', t => {
  const args = fixture(t);
  fs.writeFileSync(args.template, 'old release');
  fs.writeFileSync(path.join(args.home, 'settings.yaml'), 'custom operator configuration');
  adoptSettings({ ...args, expected: inspectSettings(args), reviewed: true });
  const baseline = fs.readFileSync(path.join(args.home, STATE), 'utf8');
  fs.writeFileSync(args.template, 'next release');
  assert.throws(() => upgrade(args), { code: 'SETTINGS_OPERATOR_EDITS' });
  assert.equal(fs.readFileSync(path.join(args.home, 'settings.yaml'), 'utf8'), 'custom operator configuration');
  assert.equal(fs.readFileSync(path.join(args.home, STATE), 'utf8'), baseline);
  assert.equal(fs.existsSync(path.join(args.home, JOURNAL)), false);
});
