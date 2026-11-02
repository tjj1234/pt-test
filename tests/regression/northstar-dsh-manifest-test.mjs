import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildDshManifest, checkDshManifest } from '../../scripts/northstar-dsh-manifest.mjs';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
function tar(entries) {
  const parts = [];
  for (const { name, value = '', type = '0' } of entries) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-release-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'shell/node_modules/@deepseek-ai/dsh');
  const files = { 'package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }),
    'lib/bin.js': 'import "./runtime.js";', 'lib/runtime.js': 'export const runtime=1;', 'config/profile.yml': 'profile: fixture' };
  for (const [name, bytes] of Object.entries(files)) { const filename = path.join(packageRoot, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes); }
  fs.mkdirSync(path.join(root, 'shell/vendor'));
  const spec = 'file:vendor/dsh-1.0.0.tgz';
  fs.writeFileSync(path.join(root, 'shell/package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': spec } }));
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { '@deepseek-ai/dsh': spec } }, 'node_modules/@deepseek-ai/dsh': { version: '1.0.0', resolved: spec } } };
  const replaceTar = entries => {
    const bytes = tar(entries); fs.writeFileSync(path.join(root, 'shell/vendor/dsh-1.0.0.tgz'), bytes);
    lock.packages['node_modules/@deepseek-ai/dsh'].integrity = 'sha512-' + hash(bytes, 'sha512', 'base64');
    fs.writeFileSync(path.join(root, 'shell/package-lock.json'), JSON.stringify(lock));
  };
  replaceTar([{ name: 'package/', type: '5' }, ...Object.entries(files).map(([name, value]) => ({ name: 'package/' + name, value }))]);
  return { root, packageRoot, files, lock, replaceTar };
}
test('manifest binds the complete vendor file set, installed version/entry and exact lock', t => {
  const f = fixture(t), manifest = buildDshManifest({ root: f.root });
  assert.equal(manifest.version, '1.0.0'); assert.equal(manifest.entry, 'lib/bin.js');
  assert.deepEqual(Object.keys(manifest.files), ['config/profile.yml', 'lib/bin.js', 'lib/runtime.js', 'package.json']);
  assert.equal(manifest.files['lib/runtime.js'], hash(f.files['lib/runtime.js']));
  assert.equal(checkDshManifest(manifest, { root: f.root }).fileCount, 4);
  fs.appendFileSync(path.join(f.root, 'shell/package-lock.json'), '\n');
  assert.throws(() => checkDshManifest(manifest, { root: f.root }), /manifest does not match/);
});
for (const mutation of ['imported runtime', 'config', 'extra file', 'environment file', 'missing file', 'symlink', 'ancestor symlink', 'dynamic directory', 'nested dependencies', 'entry override', 'version', 'vendor tamper']) {
  test(`manifest generation rejects ${mutation}`, t => {
    const f = fixture(t); const options = { root: f.root };
    if (mutation === 'imported runtime') fs.writeFileSync(path.join(f.packageRoot, 'lib/runtime.js'), 'changed');
    if (mutation === 'config') fs.writeFileSync(path.join(f.packageRoot, 'config/profile.yml'), 'changed');
    if (mutation === 'extra file') fs.writeFileSync(path.join(f.packageRoot, 'lib/extra.js'), 'changed');
    if (mutation === 'environment file') fs.writeFileSync(path.join(f.packageRoot, '.env'), 'fixture-secret-not-to-read');
    if (mutation === 'missing file') fs.unlinkSync(path.join(f.packageRoot, 'lib/runtime.js'));
    if (mutation === 'symlink') { fs.unlinkSync(path.join(f.packageRoot, 'lib/runtime.js')); fs.symlinkSync(path.join(f.packageRoot, 'lib/bin.js'), path.join(f.packageRoot, 'lib/runtime.js')); }
    if (mutation === 'ancestor symlink') { const scope = path.dirname(f.packageRoot), target = path.join(f.root, 'external-scope'); fs.renameSync(scope, target); fs.symlinkSync(target, scope); }
    if (mutation === 'dynamic directory') fs.mkdirSync(path.join(f.packageRoot, '.cache'));
    if (mutation === 'nested dependencies') fs.mkdirSync(path.join(f.packageRoot, 'node_modules'));
    if (mutation === 'entry override') { options.entry = path.join(f.root, 'external.js'); fs.writeFileSync(options.entry, f.files['lib/bin.js']); }
    if (mutation === 'version') fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' } }));
    if (mutation === 'vendor tamper') fs.appendFileSync(path.join(f.root, 'shell/vendor/dsh-1.0.0.tgz'), 'tampered');
    assert.throws(() => buildDshManifest(options), { code: 'DSH_MANIFEST_INVALID' });
  });
}
for (const entry of [{ name: 'package/../escape', value: 'bad' }, { name: 'package/link', type: '2' }, { name: '/absolute', value: 'bad' }, { name: 'package/package.json', value: 'duplicate' }]) {
  test(`vendor archive rejects unsafe or duplicate member ${entry.name} (${entry.type || '0'})`, t => {
    const f = fixture(t);
    f.replaceTar([...Object.entries(f.files).map(([name, value]) => ({ name: 'package/' + name, value })), entry]);
    assert.throws(() => buildDshManifest({ root: f.root }), { code: 'DSH_MANIFEST_INVALID' });
  });
}
for (const mutation of ['checksum mismatch', 'checksum trailing garbage']) {
  test(`archive rejects ${mutation} even when lock integrity matches the altered vendor`, t => {
    const f = fixture(t), filename = path.join(f.root, 'shell/vendor/dsh-1.0.0.tgz');
    const archive = gunzipSync(fs.readFileSync(filename));
    if (mutation === 'checksum mismatch') archive[100] ^= 1;
    else archive[154] = 120;
    const bytes = gzipSync(archive); fs.writeFileSync(filename, bytes);
    f.lock.packages['node_modules/@deepseek-ai/dsh'].integrity = 'sha512-' + hash(bytes, 'sha512', 'base64');
    fs.writeFileSync(path.join(f.root, 'shell/package-lock.json'), JSON.stringify(f.lock));
    assert.throws(() => buildDshManifest({ root: f.root }), /tar checksum/);
  });
}
