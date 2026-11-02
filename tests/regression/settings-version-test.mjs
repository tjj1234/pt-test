import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { inspectSettings, adoptSettings } = createRequire(import.meta.url)('../../shell/runtime/settings-version.cjs');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const template = path.join(home, 'template.yaml');
  const settings = path.join(home, 'settings.yaml');
  fs.writeFileSync(template, 'release template'); fs.writeFileSync(settings, 'operator secret value', { mode: 0o600 });
  return { home, template, settings };
}
const adopt = (args, expected = inspectSettings(args)) => adoptSettings({ ...args, expected, reviewed: true });
test('legacy settings remain untracked until explicit reviewed adoption; inspection is read only and secret free', t => {
  const args = fixture(t); const names = fs.readdirSync(args.home);
  const result = inspectSettings(args);
  assert.equal(result.status, 'untracked'); assert.equal(result.baselineHash, null);
  assert.deepEqual(fs.readdirSync(args.home), names);
  assert.equal(JSON.stringify(result).includes('operator secret'), false);
  assert.throws(() => adoptSettings({ ...args, expected: result }), { code: 'SETTINGS_REVIEW_REQUIRED' });
  for (const key of ['settingsHash', 'templateHash']) assert.throws(() => adoptSettings({ ...args, reviewed: true, expected: { ...result, [key]: [result[key]] } }), { code: 'SETTINGS_REVIEW_REQUIRED' });
  assert.equal(adopt(args).status, 'current');
  assert.equal(fs.statSync(path.join(args.home, '.northstar-settings-version.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(args.settings, 'utf8'), 'operator secret value');
});
test('operator edits and template drift are distinct; reviewed adoption preserves old baseline and settings', t => {
  const args = fixture(t); adopt(args);
  const state = path.join(args.home, '.northstar-settings-version.json');
  const original = fs.readFileSync(state, 'utf8');
  fs.writeFileSync(args.settings, 'edited');
  assert.equal(inspectSettings(args).status, 'operator-edited');
  fs.writeFileSync(args.template, 'next template');
  assert.equal(inspectSettings(args).status, 'template-drift');
  assert.equal(adopt(args).status, 'current');
  const backups = fs.readdirSync(args.home).filter(x => x.startsWith('.northstar-settings-version-backup-'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(args.home, backups[0]), 'utf8'), original);
  assert.equal(fs.readFileSync(args.settings, 'utf8'), 'edited');
});
test('stale settings, template and baseline revisions are refused', t => {
  const args = fixture(t); let expected = inspectSettings(args);
  fs.writeFileSync(args.settings, 'changed');
  assert.throws(() => adopt(args, expected), { code: 'SETTINGS_REVISION_CONFLICT' });
  expected = inspectSettings(args); fs.writeFileSync(args.template, 'changed template');
  assert.throws(() => adopt(args, expected), { code: 'SETTINGS_REVISION_CONFLICT' });
  expected = inspectSettings(args); adopt(args);
  assert.throws(() => adopt(args, expected), { code: 'SETTINGS_REVISION_CONFLICT' });
});
test('damaged, symlink and unsafe baseline refuse adoption without destroying evidence', t => {
  const args = fixture(t); adopt(args);
  const state = path.join(args.home, '.northstar-settings-version.json');
  fs.writeFileSync(state, '{broken');
  assert.throws(() => inspectSettings(args), { code: 'SETTINGS_BASELINE_INVALID' });
  assert.equal(fs.readFileSync(state, 'utf8'), '{broken');
  fs.unlinkSync(state); fs.symlinkSync(args.settings, state);
  assert.throws(() => inspectSettings(args));
  fs.unlinkSync(state); adopt(args); fs.chmodSync(state, 0o666);
  assert.throws(() => inspectSettings(args), { code: 'SETTINGS_FILE_UNSAFE' });
});
test('unsafe settings, symlink home and outstanding maintenance lock fail closed', t => {
  const args = fixture(t); const expected = inspectSettings(args);
  fs.writeFileSync(path.join(args.home, '.northstar-settings-version.lock'), '');
  assert.throws(() => adopt(args, expected), { code: 'SETTINGS_LOCKED' });
  fs.chmodSync(args.settings, 0o666);
  assert.throws(() => inspectSettings(args), { code: 'SETTINGS_FILE_UNSAFE' });
  fs.chmodSync(args.settings, 0o600);
  const alias = args.home + '-alias'; fs.symlinkSync(args.home, alias); t.after(() => fs.unlinkSync(alias));
  assert.throws(() => inspectSettings({ ...args, home: alias }), { code: 'SETTINGS_PATH_UNSAFE' });
});
test('publication failure retains prior baseline and backup, releases lock, and permits explicit retry', t => {
  const args = fixture(t); adopt(args);
  const state = path.join(args.home, '.northstar-settings-version.json');
  const before = fs.readFileSync(state, 'utf8'); fs.writeFileSync(args.template, 'next');
  const expected = inspectSettings(args); const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); };
  try { assert.throws(() => adopt(args, expected), { code: 'EIO' }); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(state, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(args.home, '.northstar-settings-version.lock')), false);
  const backups = fs.readdirSync(args.home).filter(x => x.startsWith('.northstar-settings-version-backup-'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(args.home, backups[0]), 'utf8'), before);
  assert.equal(adopt(args, expected).status, 'current');
});
test('baseline schema rejects null, arrays and extra secret fields with a uniform safe error', t => {
  const args = fixture(t); adopt(args);
  const state = path.join(args.home, '.northstar-settings-version.json');
  const valid = JSON.parse(fs.readFileSync(state, 'utf8'));
  for (const bad of [null, [], 'secret-value', 7, { ...valid, apiKey: 'secret-value' }, { ...valid, settingsHash: [valid.settingsHash] }, { ...valid, templateHash: [valid.templateHash] }, { ...valid, adoptedAt: 'Mon, 19 Oct 2026 00:00:00 GMT (SYNTHETIC_SECRET)' }]) {
    fs.writeFileSync(state, JSON.stringify(bad));
    assert.throws(() => inspectSettings(args), error => error.code === 'SETTINGS_BASELINE_INVALID' && error.message === 'SETTINGS_BASELINE_INVALID');
    assert.equal(fs.readFileSync(state, 'utf8'), JSON.stringify(bad));
  }
});
