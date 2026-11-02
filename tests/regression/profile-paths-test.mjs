import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepareProfilePaths, seedSettings } = require('../../shell/runtime/profile-paths.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-paths-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const template = path.join(temp, 'template.yaml');
  fs.writeFileSync(template, 'model: explicit\n');
  return { temp, template, home: path.join(temp, 'home') };
}
test('creates private owned home and profiles; settings seed preserves operator edits', (t) => {
  const { home, template } = fixture(t);
  const paths = prepareProfilePaths(home);
  assert.equal(fs.statSync(paths.home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.profilesDir).mode & 0o777, 0o700);
  seedSettings(home, template);
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'operator edits');
  seedSettings(home, template);
  assert.equal(fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8'), 'operator edits');
  assert.deepEqual(fs.readdirSync(home).sort(), ['profiles', 'settings.yaml']);
});
test('rejects home, ancestor and profiles symlinks before writing through them', (t) => {
  const { temp } = fixture(t);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  const alias = path.join(temp, 'alias'); fs.symlinkSync(outside, alias);
  assert.throws(() => prepareProfilePaths(alias), { code: 'PROFILE_PATH_UNSAFE' });
  assert.throws(() => prepareProfilePaths(path.join(alias, 'home')), { code: 'PROFILE_PATH_UNSAFE' });
  assert.deepEqual(fs.readdirSync(outside), []);
  const home = path.join(temp, 'home'); fs.mkdirSync(home);
  fs.symlinkSync(outside, path.join(home, 'profiles'));
  assert.throws(() => prepareProfilePaths(home), { code: 'PROFILE_PATH_UNSAFE' });
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('rejects writable ancestors and managed directories', (t) => {
  const { temp, home } = fixture(t);
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o770);
  assert.throws(() => prepareProfilePaths(home), { code: 'PROFILE_PATH_UNSAFE' });
  fs.chmodSync(home, 0o700); fs.chmodSync(temp, 0o777);
  assert.throws(() => prepareProfilePaths(home), { code: 'PROFILE_PATH_UNSAFE' });
  fs.chmodSync(temp, 0o700);
});
test('settings symlinks and writable files fail closed; missing template blocks seed', (t) => {
  const { temp, home, template } = fixture(t);
  prepareProfilePaths(home);
  const destination = path.join(home, 'settings.yaml');
  const outside = path.join(temp, 'outside.yaml'); fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, destination);
  assert.throws(() => seedSettings(home, template), { code: 'PROFILE_SETTINGS_UNSAFE' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  fs.unlinkSync(destination);
  assert.throws(() => seedSettings(home, path.join(temp, 'missing')), { code: 'PROFILE_SETTINGS_FAILED' });
  assert.equal(fs.existsSync(destination), false);
  fs.writeFileSync(destination, 'operator'); fs.chmodSync(destination, 0o666);
  assert.throws(() => seedSettings(home, template), { code: 'PROFILE_SETTINGS_UNSAFE' });
});
