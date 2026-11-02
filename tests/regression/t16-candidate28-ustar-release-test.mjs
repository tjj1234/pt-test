import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'release-artifacts');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const archive27Sha = '91cf2af7a033c89d108b703ca9c39ee085d75f8db988ad44b3b6c808ecca367d';
const unit27Sha = 'ea50acb72e28910957273a108cf9c21f5c2e00331933f655615e7ed76769809a';
const archive28Sha = '1d50a46516ad1d3501889c3caaa814967a77e02e8b8bda9edcc1cb1f669789f4';
const unit28Sha = 'ccb75eeb1e36abe5602066beebe6fc206003969308d434e6f4df344b9d8b4b61';

// Historical overlays bind frozen bytes; the active-candidate gate owns current-source equality.
const frozenOverlayHashes = {
  "shell/model-catalog.cjs": "0f542b88fa6026a8b88af53ea188a8b4180cf0d07756040ec0af0d44dbc7f9c1"
};

function parseUstar(bytes) {
  const raw = zlib.gunzipSync(bytes), entries = new Map();
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return entries;
    assert.equal(header.subarray(257, 263).toString('ascii').replace(/\0.*$/, ''), 'ustar');
    const stored = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actual, stored, 'USTAR header checksum');
    const field = (start, end) => { const n = header.indexOf(0, start); return header.subarray(start, n < 0 || n >= end ? end : n).toString(); };
    const name = field(0, 100), prefix = field(345, 500), full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    assert.ok(type === '0' || type === '5');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    entries.set(full, { type, data: raw.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail('missing USTAR terminator');
}

test('candidate-28 release pair and maintainer runbook are hash-bound', () => {
  const archive27 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-27.tar.gz'));
  const unit27 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-27.service'));
  const archive28 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-28.tar.gz'));
  const unit28 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-28.service'));
  assert.equal(sha(archive27), archive27Sha);
  assert.equal(sha(unit27), unit27Sha);
  assert.equal(sha(archive28), archive28Sha);
  assert.equal(sha(unit28), unit28Sha);
  assert.match(unit28.toString(), /controlled-trial-20261022-candidate-28/);
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-28.md'), 'utf8');
  assert.match(runbook, new RegExp(archive28Sha));
  assert.match(runbook, new RegExp(unit28Sha));
  assert.match(runbook, /gzip -cd \/tmp\/northstar-release-candidate-28\.tar\.gz \| file - \| grep -F 'POSIX tar archive'/);
  assert.match(runbook, /candidate-02 至 candidate-27 均已作废/);
});

test('candidate-28 is a single-file overlay over immutable candidate-27', () => {
  const entries27 = parseUstar(fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-27.tar.gz')));
  const entries28 = parseUstar(fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-28.tar.gz')));
  assert.equal(entries27.size, 323);
  assert.equal(entries28.size, 323);
  assert.deepEqual([...entries27.keys()].sort(), [...entries28.keys()].sort());
  const names = [...entries28.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  for (const [name, entry] of entries27) {
    if (name !== 'shell/model-catalog.cjs') assert.deepEqual(entries28.get(name)?.data, entry.data, `${name} is unchanged from immutable candidate-27`);
  }
  const catalog = entries28.get('shell/model-catalog.cjs')?.data || Buffer.alloc(0);
  assert.equal(sha(catalog), frozenOverlayHashes['shell/model-catalog.cjs']);
  assert.match(catalog.toString(), /const listedIds = new Set\(fetched\.records\.map\(\(record\) => modelIdOf\(record\)\)\.filter\(Boolean\)\);/);
  assert.match(catalog.toString(), /listedIds\.has\(id\) \? true : null/);
  assert.match(catalog.toString(), /complete: fetched\.complete, records: fetched\.records/);
  assert.match(catalog.toString(), /responseHasUnfollowedPages/);
});
