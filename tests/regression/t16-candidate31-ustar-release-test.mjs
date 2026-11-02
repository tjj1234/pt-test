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
const archive30Sha = 'dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559';
const unit30Sha = '116cda02601ebef2dbb8a39d53787f03defe69ca16d669fe17ecb76fda7f3175';
const archive31Sha = 'c006237dd8d48fcae71f13f852f772ec4a87fc986696c6d2d1007088cab01fa8';
const unit31Sha = '17991a2eed391b3270e9bc85e572849146f988e7f410d20c02b80c14312c2a9e';
const overlays = [
  'shell/tasks/external-operations-store.cjs',
  'shell/server.cjs',
  'shell/public/app.js',
  'shell/public/index.html',
].sort();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Frozen release provenance; current-source equality belongs to the active candidate.
const frozenOverlayHashes = {
  "shell/tasks/external-operations-store.cjs": "369ebd8b29ecd32a959482961809ea449299107cfd92e4a405707cc8d5276fd6",
  "shell/server.cjs": "f4da5de3eab1a18050fa7144bf7f07195abdfed32d69cc6846b53a0fa531deb8",
  "shell/public/app.js": "35214035ce48c1912f08330ce5450143ae32736f41901d3f316545f471355d21",
  "shell/public/index.html": "10255d5b789f53869654618cd33d7dc5d03901f660f06bdf1e06ab0d0effa87a"
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

test('candidate-31 is a checksum-bound four-file usage overlay over candidate-30', () => {
  const archive30 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-30.tar.gz'));
  const unit30 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-30.service'));
  const archive31 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-31.tar.gz'));
  const unit31 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-31.service'));
  assert.equal(sha(archive30), archive30Sha);
  assert.equal(sha(unit30), unit30Sha);
  assert.equal(sha(archive31), archive31Sha);
  assert.equal(sha(unit31), unit31Sha);
  assert.match(unit31.toString(), /controlled-trial-20261022-candidate-31/);
  const entries30 = parseUstar(archive30), entries31 = parseUstar(archive31);
  assert.equal(entries30.size, 323);
  assert.equal(entries31.size, 323);
  assert.deepEqual([...entries30.keys()].sort(), [...entries31.keys()].sort());
  const names = [...entries31.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  const changed = [];
  for (const [name, entry] of entries30) if (!entries31.get(name)?.data.equals(entry.data)) changed.push(name);
  assert.deepEqual(changed.sort(), overlays);
  for (const name of overlays) assert.equal(sha(entries31.get(name)?.data), frozenOverlayHashes[name], name);
  assert.match(entries31.get('shell/tasks/external-operations-store.cjs').data.toString(), /costCoverage: "unknown"/);
  assert.match(entries31.get('shell/server.cjs').data.toString(), /\/api\/usage\/external-operations/);
  assert.match(entries31.get('shell/public/app.js').data.toString(), /unknown（待 PT 对账）/);
  assert.match(entries31.get('shell/public/index.html').data.toString(), /近期媒体外部操作/);
});

test('candidate-31 runbook is reproducible, checksum-bound, and shell-parseable', () => {
  const runbookPath = path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-31.md');
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  assert.match(runbook, /仅覆盖 `shell\/tasks\/external-operations-store\.cjs`、`shell\/server\.cjs`、`shell\/public\/app\.js` 与 `shell\/public\/index\.html`/);
  assert.match(runbook, /c006237dd8d48fcae71f13f852f772ec4a87fc986696c6d2d1007088cab01fa8/);
  assert.match(runbook, /17991a2eed391b3270e9bc85e572849146f988e7f410d20c02b80c14312c2a9e/);
  assert.match(runbook, /费用和币种保留 unknown/);
  assert.match(runbook, /candidate-02 至 candidate-30 均已作废/);
  assert.doesNotMatch(runbook, /candidate-31 从 candidate-27|仅覆盖 `shell\/model-catalog\.cjs`/);
  const blocks = [...runbook.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(match => match[1]);
  assert.equal(blocks.length, 8);
  for (const [i, block] of blocks.entries()) {
    const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
    assert.equal(result.status, 0, `bash block ${i + 1}: ${result.stderr}`);
  }
  const builder = spawnSync('python3', ['tests/helpers/check-frozen-release.py', '31'], { cwd: root, encoding: 'utf8' });
  assert.equal(builder.status, 0, builder.stderr || builder.stdout);
  assert.match(builder.stdout, /reproducibility: PASS/);
});
