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
const archive32Sha = 'c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3';
const unit32Sha = '4c26ab4acf9347556e0e3bdedea822090862331b8f31a1d5ef0c25802a996bc5';
const overlays = [
  'shell/tasks/external-operations-store.cjs',
  'shell/server.cjs',
  'shell/public/app.js',
  'shell/public/index.html',
].sort();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Frozen release provenance; current-source equality belongs to the active candidate.
const frozenOverlayHashes = {
  "shell/tasks/external-operations-store.cjs": "cb2eb770b9af2cffa195c80028ebf5359ac659c6ae486061db7833cadb386c9a",
  "shell/server.cjs": "cad44b4ce3d09c4caa4c93fa38f0fcca2182738d598ebeb878e07b7e157b6f18",
  "shell/public/app.js": "ffffefa37b48e8a6384f609bd51156581cda1cda861497e45e10bd56aee42690",
  "shell/public/index.html": "3830bf04a925a3fdaa367eab0544d85b289ce2ad6af4c635a2bed4a07eb9b868"
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

test('candidate-32 is a checksum-bound paginated usage overlay over candidate-30', () => {
  const archive30 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-30.tar.gz'));
  const unit30 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-30.service'));
  const archive32 = fs.readFileSync(path.join(artifacts, 'northstar-controlled-trial-20261022-candidate-32.tar.gz'));
  const unit32 = fs.readFileSync(path.join(artifacts, 'northstar-shell-candidate-32.service'));
  assert.equal(sha(archive30), archive30Sha);
  assert.equal(sha(unit30), unit30Sha);
  assert.equal(sha(archive32), archive32Sha);
  assert.equal(sha(unit32), unit32Sha);
  assert.match(unit32.toString(), /controlled-trial-20261022-candidate-32/);
  const entries30 = parseUstar(archive30), entries32 = parseUstar(archive32);
  assert.equal(entries30.size, 323);
  assert.equal(entries32.size, 323);
  assert.deepEqual([...entries30.keys()].sort(), [...entries32.keys()].sort());
  const names = [...entries32.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  const changed = [];
  for (const [name, entry] of entries30) if (!entries32.get(name)?.data.equals(entry.data)) changed.push(name);
  assert.deepEqual(changed.sort(), overlays);
  for (const name of overlays.filter(name => name !== 'shell/server.cjs')) {
    assert.equal(sha(entries32.get(name)?.data), frozenOverlayHashes[name], name);
  }
  assert.match(entries32.get('shell/tasks/external-operations-store.cjs').data.toString(), /date_trunc\('day', now\(\)\)/);
  assert.match(entries32.get('shell/server.cjs').data.toString(), /afterOperationId/);
  assert.match(entries32.get('shell/public/app.js').data.toString(), /bizLoadMoreExternalOperations/);
  assert.match(entries32.get('shell/public/index.html').data.toString(), /usageExternalMore/);
  const server = entries32.get('shell/server.cjs').data.toString();
  assert.doesNotMatch(server, /retryableUsageError/, 'candidate-32 remains the frozen pre-retry server snapshot');
  assert.match(server, /PT_RATE_CHAT_PER_MIN \|\| 35/);
  assert.match(server, /chatLimiter\.allow\(me\.user\.id\)/, '35/minute limit is keyed by authenticated account');
  assert.match(server, /PT_RUNS_PER_USER \|\| 4/);
  assert.match(server, /PT_RUNS_GLOBAL \|\| 16/);
  const limits = entries32.get('shell/northstar-limits.conf').data.toString();
  assert.match(limits, /PT_RATE_CHAT_PER_MIN=35/);
  assert.match(limits, /PT_RUNS_PER_USER=4/);
  assert.match(limits, /PT_RUNS_GLOBAL=16/);
  assert.match(entries32.get('shell/runtime/dsh-adapter.cjs').data.toString(), /常驻 DSH 进程退出/);
  assert.match(entries32.get('shell/persistent-runner.mjs').data.toString(), /Agent task failed before a complete response/);
  assert.match(server, /await persistUsage\(\);[\s\S]*?if \(DRY_RUN_CHAT\)/, 'success path persists observed token usage before completing the Run');
});

test('candidate-32 runbook remains a frozen checksum-bound snapshot and shell-parseable', () => {
  const runbookPath = path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-32.md');
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  assert.equal(sha(runbook), '9c252a884e59c3bd88695f7f020e4aa3b09990c56f32dc9169b203a2858be9eb');
  assert.match(runbook, /仅覆盖 `shell\/tasks\/external-operations-store\.cjs`、`shell\/server\.cjs`、`shell\/public\/app\.js` 与 `shell\/public\/index\.html`/);
  assert.match(runbook, /c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3/);
  assert.match(runbook, /4c26ab4acf9347556e0e3bdedea822090862331b8f31a1d5ef0c25802a996bc5/);
  assert.match(runbook, /费用和币种保留 unknown/);
  assert.match(runbook, /candidate-02 至 candidate-31 均已作废/);
  assert.match(runbook, /candidate-32 相对 candidate-30/);
  assert.doesNotMatch(runbook, /candidate-32 从 candidate-27|仅覆盖 `shell\/model-catalog\.cjs`/);
  const blocks = [...runbook.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(match => match[1]);
  assert.equal(blocks.length, 8);
  for (const [i, block] of blocks.entries()) {
    const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
    assert.equal(result.status, 0, `bash block ${i + 1}: ${result.stderr}`);
  }
});
