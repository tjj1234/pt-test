import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archivePath = path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-19.tar.gz');
const unitPath = path.join(root, 'release-artifacts/northstar-shell-candidate-19.service');
const archiveSha = 'b433ec44795c455bcf40a83f8d5ecefd9181d25e0f40fc1e1688d4d65fd0eb1c';
const unitSha = 'b9743df3134e20c6154b63ba924f9d9eba982e03e4d85c3e8c85a54a01a7a071';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

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

test('candidate-19 frozen release pair matches published checksums', () => {
  const archive = fs.readFileSync(archivePath), unit = fs.readFileSync(unitPath);
  assert.equal(sha(archive), archiveSha);
  assert.equal(sha(unit), unitSha);
  assert.match(unit.toString(), /controlled-trial-20261022-candidate-19/);
});

test('candidate-19 has 322 safe USTAR members, 20 migrations and no AppleDouble paths', () => {
  const entries = parseUstar(fs.readFileSync(archivePath)), names = [...entries.keys()];
  assert.equal(names.length, 322);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.filter(name => name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '.' || part === '..')).length, 0);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  assert.equal(sha(entries.get('shell/server.cjs')?.data || Buffer.alloc(0)), '6b844fdc4aa0980eaf2460a416630bf7df8b9397146a86f99308f7e48e9df385', 'candidate-19 server snapshot stays bound to its frozen bytes');
  assert.deepEqual(entries.get('shell/storage/index.cjs')?.data, fs.readFileSync(path.join(root, 'shell/storage/index.cjs')));
  assert.match(entries.get('shell/persistent-runner.mjs')?.data.toString() || '', /raw\.modelCalls >= 0 \? raw\.modelCalls : null/);
});

test('candidate-20 binds the approved memory-cancellation scope', () => {
  const archive20 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-20.tar.gz'));
  const unit20 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-20.service'));
  assert.equal(sha(archive20), '4bc1f95b3f4797764fd33212171f1b98e6130dd37f4dd1342e4512d644b6dfbc');
  assert.equal(sha(unit20), 'aaa52f886c2ef577b75f62c39aa7fb4bbeceac38ce3da08b38750264f0a06046');
  const entries = parseUstar(archive20);
  assert.equal(entries.size, 322);
  const names = [...entries.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  const helper = entries.get('shell/tasks/memory-run-invalidation.cjs')?.data;
  assert.ok(helper);
  assert.deepEqual(helper, fs.readFileSync(path.join(root, 'shell/tasks/memory-run-invalidation.cjs')));
  assert.match(helper.toString(), /"running", "waiting_external", "awaiting_confirmation", "cancelling"/);
  assert.doesNotMatch(helper.toString(), /"queued"/);
});

test('candidate-21 binds initAuth migration failure cleanup', () => {
  const archive21 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-21.tar.gz'));
  const unit21 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-21.service'));
  assert.equal(sha(archive21), '81cc6cd4467c2ef34f320ca40f71e25c10e43f50ecfcda021614948988b0140a');
  assert.equal(sha(unit21), 'fd1ce0025cc06c384a7ff13ec5a7c7115bf22f73e9ac025cfac559f67019ed7f');
  const entries = parseUstar(archive21);
  assert.equal(entries.size, 322);
  const names = [...entries.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  const auth = entries.get('shell/auth.cjs')?.data;
  assert.ok(auth);
  assert.equal(sha(auth), 'a501d980efc5460c8409b70b87b1f0bcabdff1dd5d6e3ad1a4e8fd5b29cd1544');
  assert.match(auth.toString(), /dbmod\.migrate\(db, migrationsDir\)/);
  assert.match(auth.toString(), /Preserve the original initialization failure/);
});

test('candidate-22 binds migration and default-admin initialization cleanup', () => {
  const archive22 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-22.tar.gz'));
  const unit22 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-22.service'));
  assert.equal(sha(archive22), '0921e28b73727dec8ba9503d0bb1bd035c0e43e904df16f60f68acfa694be0f3');
  assert.equal(sha(unit22), '5e22ae8e8f0b98f032373c49362bcafcacc37c20fdf3a8686cc1cf2a06490862');
  const entries = parseUstar(archive22);
  assert.equal(entries.size, 322);
  const names = [...entries.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  const auth = entries.get('shell/auth.cjs')?.data;
  assert.ok(auth);
  assert.deepEqual(auth, fs.readFileSync(path.join(root, 'shell/auth.cjs')));
  assert.match(auth.toString(), /closeAfterInitializationFailure/);
  assert.match(auth.toString(), /ensureDefaultAdmin\(opts\.defaultAdmin\.username/);
});

test('candidate-23 binds T10, account-based widened limits, and fail-closed endpoint routing', () => {
  const archivePath23 = path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-23.tar.gz');
  const unitPath23 = path.join(root, 'release-artifacts/northstar-shell-candidate-23.service');
  const archive23 = fs.readFileSync(archivePath23), unit23 = fs.readFileSync(unitPath23);
  assert.equal(sha(archive23), '30568c8ea3f1c02369342b4338c9f484e64f61441a82491f0b5050c2afa2d4e2');
  assert.equal(sha(unit23), '12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072');
  const entries = parseUstar(archive23), names = [...entries.keys()];
  assert.equal(names.length, 323);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/*)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  for (const name of ['shell/server.cjs', 'shell/runtime/session-scheduler.cjs', 'shell/public/app.js', 'shell/models/task-router.cjs']) {
    assert.ok(entries.get(name)?.data, `${name} exists in the frozen candidate-23 snapshot`);
  }
  assert.match(entries.get('shell/models/task-router.cjs').data.toString(), /endpointCompatible !== true/);
  const server = entries.get('shell/server.cjs').data.toString();
  assert.match(server, /chatLimiter\.allow\(me\.user\.id\)/);
  assert.match(server, /PT_RATE_CHAT_PER_MIN \|\| 35/);
  assert.match(server, /PT_RUNS_PER_USER \|\| 4/);
  assert.match(server, /PT_RUNS_GLOBAL \|\| 16/);
  const scheduler = entries.get('shell/runtime/session-scheduler.cjs').data.toString();
  assert.match(scheduler, /perUserLimit = 4, globalLimit = 16/);
  const limits = entries.get('shell/northstar-limits.conf')?.data.toString();
  assert.equal(limits, '# Candidate-controlled chat and durable Run concurrency limits.\nPT_RATE_CHAT_PER_MIN=35\nPT_RUNS_PER_USER=4\nPT_RUNS_GLOBAL=16\n');
  assert.match(unit23.toString(), /EnvironmentFile=\/etc\/northstar\/northstar\.env\nEnvironmentFile=\/opt\/northstar\/releases\/controlled-trial-20261022-candidate-23\/shell\/northstar-limits\.conf/);
  assert.match(unit23.toString(), /Description=Northstar Shell \(Controlled Trial Candidate 23\)/);
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-23.md'), 'utf8');
  assert.match(runbook, new RegExp(sha(archive23)));
  assert.match(runbook, new RegExp(sha(unit23)));
  assert.match(runbook, /PT_RATE_CHAT_PER_MIN=35/);
  assert.match(runbook, /PT_RUNS_PER_USER=4/);
  assert.match(runbook, /PT_RUNS_GLOBAL=16/);
  assert.match(runbook, /ARCHIVE_MEMBERS=323/);
  assert.match(runbook, /router 在缺少 endpoint 兼容证据时拒绝放行/);
});

test('candidate-24 binds runner failure diagnostics over frozen candidate-23', () => {
  const archive24 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-24.tar.gz'));
  const unit24 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-24.service'));
  assert.equal(sha(archive24), '246706043e98a6b15fc0ac79db4515fada50f74d34fb67d525c28df2fb6d0d9e');
  assert.equal(sha(unit24), 'd458a1158d9f7c461298af563b3aac20a29c6c25d4d2eee30923bbcba37369d3');
  assert.match(unit24.toString(), /controlled-trial-20261022-candidate-24/);
  const entries = parseUstar(archive24), names = [...entries.keys()];
  assert.equal(names.length, 323);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  assert.equal(sha(entries.get('shell/persistent-runner.mjs')?.data || Buffer.alloc(0)), '1482784bc4eb26955dafb32de39b94fdd5d2b3da29b9b14a21ef70623ce1307b', 'candidate-24 runner remains bound to its frozen bytes');
  assert.equal(sha(entries.get('shell/server.cjs')?.data || Buffer.alloc(0)), 'f595626bad9e738ceb1831c6a86e4a480098a3e85195432236d4ce348d8502bc', 'candidate-24 server remains bound to its frozen bytes');
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-24.md'), 'utf8');
  assert.match(runbook, new RegExp(sha(archive24)));
  assert.match(runbook, new RegExp(sha(unit24)));
  assert.match(runbook, /candidate-02 至 candidate-23 均已作废/);
});

test('candidate-25 binds key-only preheader recovery over immutable candidate-24', () => {
  const archive25 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-25.tar.gz'));
  const unit25 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-25.service'));
  assert.equal(sha(archive25), '0c6cd34d6bba56c6434768653c0285a10e500caab5a0ddb16b9515cd82a239ad');
  assert.equal(sha(unit25), '56e469177320a6a87d7be0e2c647305493ed1b20d80f11df257696dea6b94e52');
  assert.match(unit25.toString(), /controlled-trial-20261022-candidate-25/);
  const entries = parseUstar(archive25), names = [...entries.keys()];
  assert.equal(names.length, 323);
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  assert.equal(sha(entries.get('shell/public/app.js')?.data || Buffer.alloc(0)), '4b97e21130e19e0851794e955b598010eea9d7d196bc743123be0ffe82294f5d', 'candidate-25 app remains bound to frozen bytes');
  assert.equal(sha(entries.get('shell/server.cjs')?.data || Buffer.alloc(0)), '1b154834db22e4b975e35a154acbc3dc743c9a6ce27abf2a1d572f0f4cfa22d1', 'candidate-25 server remains bound to frozen bytes');
  assert.equal(sha(entries.get('shell/tasks/store.cjs')?.data || Buffer.alloc(0)), '82b816895c91c55689fdda7e4b0782e559d8476116d3e85b76a0070d86a24b36', 'candidate-25 store remains bound to frozen bytes');
  assert.match(entries.get('shell/public/app.js').data.toString(), /conversationId === item\.conversationId/);
  assert.match(entries.get('shell/server.cjs').data.toString(), /\/api\/runs\/by-idempotency-key/);
  assert.match(entries.get('shell/tasks/store.cjs').data.toString(), /getRunByIdempotencyKey/);
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-25.md'), 'utf8');
  assert.match(runbook, new RegExp(sha(archive25)));
  assert.match(runbook, new RegExp(sha(unit25)));
  assert.match(runbook, /candidate-02 至 candidate-24 均已作废/);
  assert.match(runbook, /同一幂等键执行 GET 查找/);
});

test('candidate-26 fails closed when the browser cannot persist a recovery key', () => {
  const archive25 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-25.tar.gz'));
  const archive26 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-26.tar.gz'));
  const unit26 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-26.service'));
  assert.equal(sha(archive26), 'aeeeec81d1afe686e71d63f67a0887523fe7c39d2c5753ee1cb922667d54f419');
  assert.equal(sha(unit26), '9940ea1559b2e4ba28911df2ce36f28ebf66a4e874665fc61dd6059f1c1bb4bb');
  assert.match(unit26.toString(), /controlled-trial-20261022-candidate-26/);
  const entries25 = parseUstar(archive25), entries26 = parseUstar(archive26);
  assert.equal(entries26.size, 323);
  assert.equal([...entries26.keys()].filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal([...entries26.keys()].filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal([...entries26.keys()].filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  for (const [name, entry] of entries25) {
    if (name !== 'shell/public/app.js') assert.deepEqual(entries26.get(name)?.data, entry.data, `${name} is unchanged from immutable candidate-25`);
  }
  const app = entries26.get('shell/public/app.js')?.data || Buffer.alloc(0);
  assert.equal(sha(app), 'aa8f6ebdc6b0c8cb527435e9ff427d45e9500c38f070ffcdb73c14a10f68d90d');
  assert.match(app.toString(), /catch \{ return false; \/\* never submit a paid request without its recovery key \*\//);
  assert.match(app.toString(), /if \(!rememberPendingSubmission\(targetId, idempotencyKey\)\)/);
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-26.md'), 'utf8');
  assert.match(runbook, new RegExp(sha(archive26)));
  assert.match(runbook, new RegExp(sha(unit26)));
  assert.match(runbook, /candidate-02 至 candidate-25 均已作废/);
  assert.match(runbook, /写入失败时明确提示请求未发送/);
});

test('candidate-27 persists runner shutdown as interrupted over immutable candidate-26', () => {
  const archive26 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-26.tar.gz'));
  const archive27 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-controlled-trial-20261022-candidate-27.tar.gz'));
  const unit27 = fs.readFileSync(path.join(root, 'release-artifacts/northstar-shell-candidate-27.service'));
  assert.equal(sha(archive27), '91cf2af7a033c89d108b703ca9c39ee085d75f8db988ad44b3b6c808ecca367d');
  assert.equal(sha(unit27), 'ea50acb72e28910957273a108cf9c21f5c2e00331933f655615e7ed76769809a');
  assert.match(unit27.toString(), /controlled-trial-20261022-candidate-27/);
  const entries26 = parseUstar(archive26), entries27 = parseUstar(archive27);
  assert.equal(entries27.size, 323);
  const names = [...entries27.keys()];
  assert.equal(names.filter(name => /^shell\/db-migrations\/\d{3}[^/]*\.sql$/.test(name)).length, 20);
  assert.equal(names.filter(name => /(^|\/)\._|(^|\/)__MACOSX(\/|$)/.test(name)).length, 0);
  assert.equal(names.filter(name => /(^|\/)(\.env(?:\.|$)|node_modules\/|\.git\/|secrets\/)/.test(name)).length, 0);
  for (const [name, entry] of entries26) {
    if (name !== 'shell/tasks/execution.cjs') assert.deepEqual(entries27.get(name)?.data, entry.data, `${name} is unchanged from immutable candidate-26`);
  }
  const execution = entries27.get('shell/tasks/execution.cjs')?.data || Buffer.alloc(0);
  assert.deepEqual(execution, fs.readFileSync(path.join(root, 'shell/tasks/execution.cjs')));
  assert.match(execution.toString(), /const interrupted = outcome\?\.interrupted === true \|\| source\.code === "RUN_INTERRUPTED"/);
  assert.match(execution.toString(), /interrupted \? "interrupted"/);
  const runbook = fs.readFileSync(path.join(root, 'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-27.md'), 'utf8');
  assert.match(runbook, new RegExp(sha(archive27)));
  assert.match(runbook, new RegExp(sha(unit27)));
  assert.match(runbook, /candidate-02 至 candidate-26 均已作废/);
  assert.match(runbook, /RUN_INTERRUPTED/);
  assert.match(runbook, /gzip -cd \/tmp\/northstar-release-candidate-27\.tar\.gz \| file - \| grep -F 'POSIX tar archive'/);
});
