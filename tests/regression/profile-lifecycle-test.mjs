import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { manageProfile } = require('../../shell/runtime/profile-lifecycle.cjs');
const NAME = 'run-persistent';
const MF = 'northstar-profile-manifest.json';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'profile-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, 'template.yaml'); fs.writeFileSync(template, 'plugins: {}\n');
  const files = { 'runner.mjs': 'original' };
  const manifest = { formatVersion: 1, rpcProtocolVersion: 1, files: { 'runner.mjs': crypto.createHash('sha256').update(files['runner.mjs']).digest('hex') } };
  const args = { dshHome: path.join(root, 'home'), settingsTemplate: template, files, manifest };
  const run = extra => manageProfile({ ...args, ...extra });
  return { root, args, run, profiles: path.join(args.dshHome, 'profiles'), dir: path.join(args.dshHome, 'profiles', NAME) };
}
test('ensure creates verified profile, reuses it and preserves unknown files', t => {
  const f = fixture(t); f.run(); fs.writeFileSync(path.join(f.dir, 'user.txt'), 'keep');
  assert.equal(f.run().dir, f.dir); assert.equal(fs.readFileSync(path.join(f.dir, 'user.txt'), 'utf8'), 'keep');
});
test('rebuild preserves unknown files with self-validating old profile', t => {
  const f = fixture(t); f.run(); fs.writeFileSync(path.join(f.dir, 'user.txt'), 'keep');
  const files = { 'runner.mjs': 'next' }; const manifest = structuredClone(f.args.manifest); manifest.files['runner.mjs'] = crypto.createHash('sha256').update('next').digest('hex');
  assert.throws(() => f.run({ files, manifest }), { code: 'PROFILE_STALE' });
  const result = f.run({ files, manifest, mode: 'rebuild' });
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'user.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(f.dir, 'runner.mjs'), 'utf8'), 'next');
});
test('rebuild refuses damaged or unmanaged profile', t => {
  const f = fixture(t); f.run(); fs.writeFileSync(path.join(f.dir, 'runner.mjs'), 'damaged');
  assert.throws(() => f.run({ mode: 'rebuild' }), { code: 'PROFILE_FILE_MISMATCH' });
  fs.unlinkSync(path.join(f.dir, MF)); assert.throws(() => f.run({ mode: 'rebuild' }), { code: 'PROFILE_MANIFEST_MISSING' });
});
test('existing lock fails closed and is retained', t => {
  const f = fixture(t); f.run(); const lock = path.join(f.profiles, `.${NAME}.northstar-lock`); fs.mkdirSync(lock);
  assert.throws(() => f.run(), { code: 'PROFILE_BUSY' }); assert.ok(fs.existsSync(lock));
});
test('interrupted journal blocks startup; explicit recovery restores backup and preserves current files', t => {
  const f = fixture(t); f.run(); const backup = `.${NAME}.northstar-backup-test`; fs.renameSync(f.dir, path.join(f.profiles, backup));
  fs.mkdirSync(f.dir); fs.writeFileSync(path.join(f.dir, 'user.txt'), 'survive');
  fs.writeFileSync(path.join(f.profiles, `.${NAME}.northstar-journal.json`), JSON.stringify({ version: 1, backup, staging: `.${NAME}.northstar-staging-test`, oldManifest: f.args.manifest }));
  assert.throws(() => f.run(), { code: 'PROFILE_RECOVERY_REQUIRED' });
  const r = f.run({ mode: 'recover', recovery: { action: 'restore-backup', preserveCurrent: true } });
  assert.equal(fs.readFileSync(path.join(r.preservedDir, 'user.txt'), 'utf8'), 'survive');
  assert.equal(fs.readFileSync(path.join(f.dir, 'runner.mjs'), 'utf8'), 'original');
});
test('recovery rejects traversal journal', t => {
  const f = fixture(t); f.run(); fs.writeFileSync(path.join(f.profiles, `.${NAME}.northstar-journal.json`), JSON.stringify({ backup: '../outside' }));
  assert.throws(() => f.run({ mode: 'recover', recovery: { action: 'restore-backup' } }), { code: 'PROFILE_RECOVERY_INVALID' });
});
test('publish failure rolls back old profile and retains staged evidence', t => {
  const f = fixture(t); f.run(); const original = fs.renameSync;
  fs.renameSync = function(from, to) { if (String(from).includes('northstar-staging-') && to === f.dir) throw Object.assign(new Error('injected'), { code: 'EIO' }); return original(from, to); };
  try { assert.throws(() => f.run({ mode: 'rebuild' }), { code: 'EIO' }); } finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(path.join(f.dir, 'runner.mjs'), 'utf8'), 'original');
  assert.ok(fs.readdirSync(f.profiles).some(n => n.includes('northstar-staging-'))); f.run();
});
test('manifest traversal cannot write outside staging', t => {
  const f = fixture(t); const manifest = structuredClone(f.args.manifest); manifest.files = { '../escape': 'a'.repeat(64) };
  assert.throws(() => f.run({ files: { '../escape': 'x' }, manifest }), { code: 'PROFILE_MANIFEST_INVALID' });
});

test('pre-switch crash permits explicit keep-current and retains staged evidence', t => {
  const f = fixture(t); f.run();
  fs.writeFileSync(path.join(f.profiles, `.${NAME}.northstar-journal.json`), JSON.stringify({ version: 1, backup: `.${NAME}.northstar-backup-not-created`, staging: `.${NAME}.northstar-staging-test`, oldManifest: f.args.manifest }));
  assert.throws(() => f.run(), { code: 'PROFILE_RECOVERY_REQUIRED' });
  assert.equal(f.run({ mode: 'recover', recovery: { action: 'keep-current' } }).recovered, true); f.run();
});
test('writable managed profile entries fail closed', t => {
  const f = fixture(t); f.run(); fs.chmodSync(path.join(f.dir, 'runner.mjs'), 0o666);
  assert.throws(() => f.run(), { code: 'PROFILE_TARGET_UNSAFE' });
});
test('failed rollback retains journal and fails with recovery required', t => {
  const f = fixture(t); f.run(); const original = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === f.dir && (String(from).includes('northstar-staging-') || String(from).includes('northstar-backup-'))) throw Object.assign(new Error('injected'), { code: 'EIO' });
    return original(from, to);
  };
  try { assert.throws(() => f.run({ mode: 'rebuild' }), { code: 'PROFILE_RECOVERY_REQUIRED' }); } finally { fs.renameSync = original; }
  assert.ok(fs.existsSync(path.join(f.profiles, `.${NAME}.northstar-journal.json`)));
  assert.throws(() => f.run(), { code: 'PROFILE_RECOVERY_REQUIRED' });
  assert.equal(f.run({ mode: 'recover', recovery: { action: 'restore-backup' } }).recovered, true);
});
