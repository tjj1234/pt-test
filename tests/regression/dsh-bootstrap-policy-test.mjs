import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertBootstrapPolicy } = require('../../shell/runtime/bootstrap-policy.cjs');
const { createDshRuntime } = require('../../shell/runtime/dsh-adapter.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const profileDir = path.join(home, 'profiles/run-persistent');
  fs.mkdirSync(profileDir, { recursive: true }); fs.mkdirSync(workspace);
  return { root, home, workspace, profileDir };
}
test('undeclared environment and module layers reject files, directories and dangling links without changing them', t => {
  const f = fixture(t);
  assertBootstrapPolicy(f);
  // The DSH-maintained shared fallback is permitted; it is not verified here.
  fs.mkdirSync(path.join(f.home, 'profiles/node_modules'));
  assertBootstrapPolicy(f);
  for (const target of [path.join(f.home, '.env'), path.join(f.workspace, '.env'), path.join(f.home, 'cordis.patch.yml'), path.join(f.home, 'node_modules'), path.join(f.profileDir, 'node_modules')]) {
    for (const type of ['file', 'directory', 'link']) {
      if (type === 'file') fs.writeFileSync(target, 'SYNTHETIC_SECRET');
      else if (type === 'directory') fs.mkdirSync(target);
      else fs.symlinkSync(path.join(f.root, 'absent'), target);
      assert.throws(() => assertBootstrapPolicy(f), error => error.code === 'DSH_BOOTSTRAP_INPUT_UNTRUSTED' && !error.message.includes('SYNTHETIC_SECRET'));
      assert.ok(fs.lstatSync(target));
      if (type === 'directory') fs.rmdirSync(target); else fs.unlinkSync(target);
    }
  }
});
test('adapter refuses a workspace env before child spawn or process logs and preserves tenant file', async t => {
  const f = fixture(t), logs = path.join(f.root, 'logs');
  fs.rmdirSync(f.profileDir); // Let the adapter create its managed profile.
  const filename = path.join(f.workspace, '.env'); fs.writeFileSync(filename, 'SYNTHETIC_SECRET=never-loaded');
  const runtime = createDshRuntime({ dshHome: f.home, tmpDir: logs, settingsTemplate: path.resolve('shell/dsh-settings.yaml'), persistentRunner: path.resolve('shell/persistent-runner.mjs') });
  t.after(() => runtime.close());
  const result = await runtime.run({ tenantId: 'bootstrap', userId: 'user', sessionKey: 'session', workspace: f.workspace, question: 'never sent' });
  assert.equal(result.ok, false); assert.equal(result.code, 'DSH_BOOTSTRAP_INPUT_UNTRUSTED');
  assert.equal(fs.existsSync(logs), false);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'SYNTHETIC_SECRET=never-loaded');
});
test('pending settings transaction blocks cold runtime before spawn and retains recovery evidence', async t => {
  const f = fixture(t), logs = path.join(f.root, 'logs');
  fs.rmdirSync(f.profileDir);
  const journal = path.join(f.home, '.northstar-settings-upgrade-journal.json');
  fs.writeFileSync(journal, 'pending transaction');
  const runtime = createDshRuntime({ dshHome: f.home, tmpDir: logs, settingsTemplate: path.resolve('shell/dsh-settings.yaml'), persistentRunner: path.resolve('shell/persistent-runner.mjs') });
  t.after(() => runtime.close());
  const result = await runtime.run({ tenantId: 'recovery', userId: 'user', sessionKey: 'session', workspace: f.workspace, question: 'never sent' });
  assert.equal(result.ok, false); assert.equal(result.code, 'SETTINGS_RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(logs), false);
  assert.equal(fs.readFileSync(journal, 'utf8'), 'pending transaction');
});
