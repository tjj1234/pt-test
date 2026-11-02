import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const base = 'release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz';
const candidate = 'release-artifacts/northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz';
const target = 'shell/models/catalog-cache.cjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readUstar(file) {
  const bytes = gunzipSync(fs.readFileSync(file)), entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString().split('\0')[0];
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(text(124, 136), 8) || 0;
    assert.equal(text(257, 263), 'ustar');
    assert.ok(['0', '5', ''].includes(text(156, 157)), 'no PAX, GNU, links or special nodes');
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\'));
    assert.ok(!name.split('/').some(part => part.startsWith('._') || part === '__MACOSX'));
    const expectedChecksum = Number.parseInt(text(148, 156), 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(actualChecksum, expectedChecksum);
    assert.ok(!entries.has(name), 'no duplicate paths');
    entries.set(name, { header, bytes: bytes.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('cache r5 is hash-bound, reproducible and a single-file USTAR overlay over deployed r2', () => {
  assert.equal(sha(fs.readFileSync(base)), 'bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77');
  assert.equal(sha(fs.readFileSync(candidate)), 'da4933064a310694c2ab12bfba49dd71b5d5be7fec993dbbe85fd3104a2af92b');
  const checked = spawnSync('python3', ['scripts/package-northstar-catalog-cache-r5.py', '--check'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  const oldEntries = readUstar(base), newEntries = readUstar(candidate);
  assert.equal(newEntries.size, 325);
  assert.deepEqual([...newEntries.keys()], [...oldEntries.keys()]);
  const changed = [];
  for (const [name, entry] of newEntries) {
    const previous = oldEntries.get(name);
    if (!entry.bytes.equals(previous.bytes)) changed.push(name);
    if (name !== target) assert.deepEqual(entry.header, previous.header, 'unmodified member metadata: ' + name);
  }
  assert.deepEqual(changed, [target]);
  assert.equal(sha(newEntries.get(target).bytes), '9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e');
  for (const name of newEntries.keys()) if (/package(-lock)?\.json$|\.sql$|persistent-runner|run-budget/.test(name)) {
    assert.deepEqual(newEntries.get(name).bytes, oldEntries.get(name).bytes, 'no dependency, migration or runner changes');
  }
});

test('cache r5 unit and checksums bind the new candidate without changing the old rollback unit', () => {
  const original = fs.readFileSync('release-artifacts/northstar-shell-candidate-33-draft-r2.service');
  assert.equal(sha(original), 'eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105');
  const unit = fs.readFileSync('release-artifacts/northstar-shell-catalog-cache-r5.service');
  assert.equal(sha(unit), '69960cd10ccad134babef955480b88602118f57019a54972a883b6426613a83a');
  assert.equal((unit.toString().match(/\/opt\/northstar\/releases\/controlled-trial-20261027-catalog-cache-r5/g) || []).length, 3);
  for (const line of fs.readFileSync('release-artifacts/northstar-catalog-cache-r5.sha256', 'utf8').trim().split('\n')) {
    const [digest, name] = line.split('  ');
    assert.equal(sha(fs.readFileSync('release-artifacts/' + name)), digest);
  }
});
