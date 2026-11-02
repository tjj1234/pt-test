import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'release-artifacts');
const archive29Sha = 'e060ebbfed060e8b2d61366d926475abf35a2c178a1b66283b871ec32608cc1f';
const unit29Sha = '0e56a95c8b43df985a197d0ea32a08cb3614b5eb4436de2dc1bb23498fe7c3c6';
const archive30Sha = 'dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559';
const unit30Sha = '116cda02601ebef2dbb8a39d53787f03defe69ca16d669fe17ecb76fda7f3175';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Historical overlays bind frozen bytes; the active-candidate gate owns current-source equality.
const frozenOverlayHashes = {
  "shell/runtime/dsh-adapter.cjs": "19144998220ecb96423f6b3da3756884df1c7c3e9e2956f2c7bf112a34b32a3d"
};

function parseUstar(bytes) {
  const raw = zlib.gunzipSync(bytes), entries = new Map();
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return entries;
    assert.equal(header.subarray(257, 263).toString('ascii').replace(/\0.*$/, ''), 'ustar');
    assert.equal(header.subarray(263, 265).toString('ascii'), '00');
    const stored = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actual, stored, 'USTAR header checksum');
    const field = (start, end) => { const n = header.indexOf(0, start); return header.subarray(start, n < 0 || n >= end ? end : n).toString(); };
    const name = field(0, 100), prefix = field(345, 500), full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    assert.ok(type === '0' || type === '5', `unexpected USTAR type ${type}`);
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    entries.set(full, { type, data: raw.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail('missing USTAR terminator');
}

test('candidate-30 is a checksum-bound one-file adapter overlay over candidate-29', () => {
  const archive29 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-29.tar.gz'));
  const unit29 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-29.service'));
  const archive30 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-30.tar.gz'));
  const unit30 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-30.service'));
  assert.equal(sha(archive29), archive29Sha);
  assert.equal(sha(unit29), unit29Sha);
  assert.equal(sha(archive30), archive30Sha);
  assert.equal(sha(unit30), unit30Sha);
  assert.match(unit30.toString(), /controlled-trial-20261022-candidate-30/);
  const entries29 = parseUstar(archive29), entries30 = parseUstar(archive30);
  assert.equal(entries29.size, 323);
  assert.equal(entries30.size, 323);
  assert.deepEqual([...entries29.keys()].sort(), [...entries30.keys()].sort());
  const names = [...entries30.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  const changed = [];
  for (const [name, entry] of entries29) if (!entries30.get(name)?.data.equals(entry.data)) changed.push(name);
  assert.deepEqual(changed, ['shell/runtime/dsh-adapter.cjs']);
  assert.equal(sha(entries30.get('shell/runtime/dsh-adapter.cjs')?.data), frozenOverlayHashes['shell/runtime/dsh-adapter.cjs']);
  const adapter = entries30.get('shell/runtime/dsh-adapter.cjs').data.toString();
  assert.match(adapter, /frame\.type === "error" && !proc\.ready/);
  assert.match(adapter, /uncorrelated runner control error/);
  assert.deepEqual(entries30.get('shell/persistent-runner.mjs')?.data, entries29.get('shell/persistent-runner.mjs')?.data,
    'candidate-30 inherits candidate-29 runner diagnostics');
  assert.match(entries30.get('shell/persistent-runner.mjs')?.data.toString() || '', /PARENT_FRAME_INVALID/);
});

test('candidate-30 runbook is reproducible, checksum-bound, and shell-parseable', () => {
  const runbookPath = path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-30.md');
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  assert.match(runbook, /仅覆盖 `shell\/runtime\/dsh-adapter\.cjs`/);
  assert.match(runbook, /dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559/);
  assert.match(runbook, /116cda02601ebef2dbb8a39d53787f03defe69ca16d669fe17ecb76fda7f3175/);
  assert.match(runbook, /candidate-02 至 candidate-29 均已作废/);
  assert.doesNotMatch(runbook, /candidate-30 从 candidate-27|仅覆盖 `shell\/model-catalog\.cjs`/);
  const blocks = [...runbook.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(match => match[1]);
  assert.equal(blocks.length, 8);
  for (const [i, block] of blocks.entries()) {
    const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
    assert.equal(result.status, 0, `bash block ${i + 1}: ${result.stderr}`);
  }
  const builder = spawnSync('python3', ['tests/helpers/check-frozen-release.py', '30'], { cwd: root, encoding: 'utf8' });
  assert.equal(builder.status, 0, builder.stderr || builder.stdout);
  assert.match(builder.stdout, /reproducibility: PASS/);
});
