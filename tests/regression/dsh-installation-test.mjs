import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveDshInstallation } = require('../../shell/runtime/dsh-installation.cjs');
const hash = (bytes, kind = 'sha256', encoding = 'hex') => crypto.createHash(kind).update(bytes).digest(encoding);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-installation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/@deepseek-ai/dsh'); fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
  const pkg = JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin: { dsh: 'lib/bin.js' } });
  const bin = 'console.log("fixture");\n'; fs.writeFileSync(path.join(packageRoot, 'package.json'), pkg); fs.writeFileSync(path.join(packageRoot, 'lib/bin.js'), bin);
  const vendor = Buffer.from('fixture artifact identity'); const resolved = 'file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz'; const integrity = 'sha512-' + hash(vendor, 'sha512', 'base64');
  fs.mkdirSync(path.join(root, 'vendor')); fs.writeFileSync(path.join(root, resolved.slice(5)), vendor);
  const lockfilePath = path.join(root, 'package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@deepseek-ai/dsh': resolved } }, 'node_modules/@deepseek-ai/dsh': { version: '0.1.1-rc.2', resolved, integrity } } }));
  const manifest = { schemaVersion: 1, packageName: '@deepseek-ai/dsh', version: '0.1.1-rc.2', entry: 'lib/bin.js', files: { 'package.json': hash(pkg), 'lib/bin.js': hash(bin) }, lock: { resolved, integrity }, vendorSha256: hash(vendor) };
  const manifestPath = path.join(root, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const args = { packageRoot, lockfilePath, manifestPath }; const run = extra => resolveDshInstallation({ ...args, ...extra });
  return { root, args, run, manifest, entry: path.join(packageRoot, 'lib/bin.js') };
}
test('verified packaged entry resolves with exact explicit and environment path', t => {
  const f = fixture(t); const result = f.run({ explicitEntry: f.entry, envEntry: f.entry });
  assert.equal(result.entry, f.entry); assert.equal(result.version, '0.1.1-rc.2');
  assert.deepEqual(result.integrityScope, ['lib/bin.js', 'package.json']); assert.equal(result.vendorVerified, true);
  assert.equal(result.manifestSha256, hash(fs.readFileSync(f.args.manifestPath)));
  assert.equal(result.lockfileSha256, hash(fs.readFileSync(f.args.lockfilePath)));
  assert.equal(result.vendorSha256, f.manifest.vendorSha256); assert.equal(result.packageFileCount, 2);
});
test('invalid or empty explicit/environment entries never fall back', t => {
  const f = fixture(t);
  for (const override of ['', '/global/lib/bin.js', 'relative/lib/bin.js', 42]) {
    assert.throws(() => f.run({ explicitEntry: override }), { code: 'DSH_ENTRY_UNTRUSTED' });
    assert.throws(() => f.run({ envEntry: override }), { code: 'DSH_ENTRY_UNTRUSTED' });
  }
});
test('installed bin or metadata changes are rejected even with unchanged version', t => {
  const f = fixture(t); fs.appendFileSync(f.entry, 'changed'); assert.throws(() => f.run(), { code: 'DSH_FILE_MISMATCH' });
  const g = fixture(t); fs.appendFileSync(path.join(g.args.packageRoot, 'package.json'), ' '); assert.throws(() => g.run(), { code: 'DSH_FILE_MISMATCH' });
});
test('lockfile and vendor identity changes are rejected', t => {
  const f = fixture(t); const lock = JSON.parse(fs.readFileSync(f.args.lockfilePath)); lock.packages['node_modules/@deepseek-ai/dsh'].version = 'other'; fs.writeFileSync(f.args.lockfilePath, JSON.stringify(lock)); assert.throws(() => f.run(), { code: 'DSH_LOCK_MISMATCH' });
  const g = fixture(t); fs.appendFileSync(path.join(g.root, g.manifest.lock.resolved.slice(5)), 'changed'); assert.throws(() => g.run(), { code: 'DSH_VENDOR_MISMATCH' });
});
test('missing local installation does not search global or current-directory alternatives', t => {
  const f = fixture(t); fs.unlinkSync(f.entry); assert.throws(() => f.run(), { code: 'DSH_INSTALLATION_MISSING' });
});
test('symlink entry and package ancestor are rejected', t => {
  const f = fixture(t); const actual = path.join(f.root, 'actual.js'); fs.renameSync(f.entry, actual); fs.symlinkSync(actual, f.entry); assert.throws(() => f.run(), { code: 'DSH_INSTALLATION_INVALID' });
  const g = fixture(t); const linked = path.join(g.root, 'linked'); fs.symlinkSync(path.dirname(g.args.packageRoot), linked); assert.throws(() => g.run({ packageRoot: path.join(linked, 'dsh') }), { code: 'DSH_ENTRY_UNTRUSTED' });
});
test('trusted release manifest is required and exact in scope', t => {
  const f = fixture(t); f.manifest.files['extra.js'] = 'a'.repeat(64); fs.writeFileSync(f.args.manifestPath, JSON.stringify(f.manifest)); assert.throws(() => f.run(), { code: 'DSH_FILE_MISMATCH' });
});

test('additional installed files and symlinked nested files fail closed', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.args.packageRoot, 'lib/extra.js'), 'extra');
  assert.throws(() => f.run(), { code: 'DSH_FILE_MISMATCH' });
  const g = fixture(t); fs.symlinkSync(g.entry, path.join(g.args.packageRoot, 'extra.js'));
  assert.throws(() => g.run(), { code: 'DSH_INSTALLATION_INVALID' });
});

test('untrusted write permissions on installed files, trust metadata and ancestors fail closed', t => {
  for (const target of ['bin', 'package', 'manifest', 'lock', 'vendor', 'parent']) {
    const f = fixture(t);
    const filename = target === 'bin' ? f.entry : target === 'package' ? path.join(f.args.packageRoot, 'package.json') : target === 'manifest' ? f.args.manifestPath : target === 'lock' ? f.args.lockfilePath : target === 'vendor' ? path.join(f.root, f.manifest.lock.resolved.slice(5)) : f.root;
    fs.chmodSync(filename, target === 'parent' ? 0o777 : 0o666);
    try { assert.throws(() => f.run(), { code: 'DSH_INSTALLATION_UNSAFE' }); } finally { fs.chmodSync(filename, target === 'parent' ? 0o700 : 0o600); }
  }
});
