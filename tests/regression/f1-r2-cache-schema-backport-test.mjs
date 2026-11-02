/** Offline compatibility test: frozen r2 catalog + capabilities, single-file r5 cache patch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve('.');
const archive = path.join(root, 'release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz');
const patch = path.join(root, 'docs/refactor/candidates/candidate33-r5-cache-schema.patch');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const OLD = '05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a';
const NEW = '9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e';
const ARCHIVE = 'bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77';
const fields = ['shell/model-catalog.cjs','shell/models/capabilities.cjs','shell/models/catalog-cache.cjs'];
const policy = { enabled: true, source: 'offline fixture', version: '1' };
const adaptation = { adapterId: 'fixture', version: '1', endpoint: 'openai-chat-completions', source: 'offline fixture' };
const qualificationDefaults = { policy, adaptation };
function setup(t, applyPatch = true) {
  assert.equal(sha(fs.readFileSync(archive)), ARCHIVE);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r2-cache-backport-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const before = new Map();
  for (const name of fields) {
    const extracted = spawnSync('tar', ['-xOf', archive, name]); assert.equal(extracted.status, 0, extracted.stderr.toString());
    const target = path.join(temp, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, extracted.stdout); before.set(name, extracted.stdout);
  }
  assert.equal(sha(before.get(fields[2])), OLD);
  const cachePath = path.join(temp, fields[2]);
  if (applyPatch) {
  const applied = spawnSync('patch', ['--batch', '--fuzz=0', '-p1', '-i', patch], { cwd: temp, encoding: 'utf8' }); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(sha(fs.readFileSync(cachePath)), NEW);
  }
  for (const name of fields.slice(0, 2)) assert.deepEqual(fs.readFileSync(path.join(temp, name)), before.get(name));
  const cache = require(cachePath), cap = require(path.join(temp, fields[1])), catalog = require(path.join(temp, fields[0]));
  const dir = path.join(temp, 'cache'); fs.mkdirSync(dir);
  return { temp, dir, cache, cap, catalog };
}
function source(f, user, { stale = false, old = true, count = 80 } = {}) {
  const scope = f.cache.resolveScopeId({ apiKey: 'offline-only-fixture', scopeId: user });
  const at = new Date(Date.now() - (stale ? 2 * 86400000 : 0)).toISOString();
  const models = Array.from({ length: count }, (_, i) => f.cap.normalizePtRecord({ id: 'fixture-' + i, supported_endpoint_types: ['openai'] }, { scopeId: scope, observedAt: at, permission: true, localPolicy: policy, adaptations: { textChat: adaptation } }));
  if (old) for (const model of models) delete model.ptEndpointTasks;
  const snapshot = { scopeId: scope, models, lastSuccessfulAt: at };
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, scopeId: scope, snapshot }));
  const file = f.cache.cacheFile(f.dir, scope); fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { scope, snapshot, bytes, file, user };
}
function opts(f, input, success, counted) {
  return { apiKey: 'offline-only-fixture', scopeId: input.user, cacheDir: f.dir, qualificationDefaults, fallback: [{ id: 'display-only' }], fetchImpl: async () => {
    counted.calls++;
    return success ? { ok: true, json: async () => ({ data: [{ id: 'recovered', supported_endpoint_types: ['openai'] }] }) } : { ok: false, status: 503 };
  } };
}

test('unmodified frozen r2 accepts old-rich cache and deterministically throws before refresh can repair it', async t => {
  const f = setup(t, false);
  for (const stale of [false, true]) {
    const input = source(f, 'original-' + stale, { stale });
    assert.equal(f.cache.readScopedCache(f.dir, input.scope).models.length, 80);
    const counted = { calls: 0 };
    await assert.rejects(f.catalog.getCatalog(opts(f, input, true, counted)), TypeError);
    assert.equal(counted.calls, stale ? 1 : 0);
    assert.deepEqual(fs.readFileSync(input.file), input.bytes);
  }
});

test('r2 single-file backport recovers six 80-record old-rich caches with exact backups and fail-closed permission', async t => {
  const f = setup(t), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN'); }; t.after(() => { globalThis.fetch = originalFetch; });
  const oldReader = setup(t, false);
  let records = 0;
  for (let i = 0; i < 6; i++) {
    const input = source(f, 'user-' + i, { stale: i % 2 === 1 }); records += input.snapshot.models.length;
    assert.equal(f.cache.inspectScopedCache(f.dir, input.scope).status, 'invalid');
    const counted = { calls: 0 }, success = i >= 3;
    const result = await f.catalog.getCatalog(opts(f, input, success, counted));
    assert.equal(counted.calls, 1, 'invalid fresh and stale caches must refetch');
    const backup = input.file + '.invalid-' + sha(input.bytes) + '.bak';
    assert.deepEqual(fs.readFileSync(backup), input.bytes); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    if (success) {
      assert.equal(result.availability.status, 'available'); assert.deepEqual(result.availability.modelIds, ['recovered']);
      const recovered = result.models.find(m => m.id === 'recovered'); assert.equal(recovered.permission, true); assert.equal(recovered.tasks.textChat.value, true);
      assert.equal(recovered.states.textChat.adapted, true); assert.equal(recovered.states.textChat.verified, false); assert.equal(recovered.states.textChat.autoEligible, false);
      const downgradeCalls = { calls: 0 };
      const downgraded = await oldReader.catalog.getCatalog(opts(f, input, false, downgradeCalls));
      assert.equal(downgradeCalls.calls, 0, 'original r2 can read the replacement cache on rollback');
      assert.deepEqual(downgraded.availability.modelIds, ['recovered']);
      assert.equal(downgraded.models[0].states.textChat.autoEligible, false);
    } else {
      assert.equal(result.availability.status, 'unknown'); assert.deepEqual(result.availability.modelIds, []);
      assert.ok(result.models.every(m => m.permission !== true && m.states?.textChat?.autoEligible !== true));
    }
    assert.equal(f.cache.inspectScopedCache(f.dir, input.scope).status, 'valid');
  }
  assert.equal(records, 480);
});

test('backport preserves originals on backup failure, rejects symlinks and accepts normal r2 facts without fetch', async t => {
  const f = setup(t), broken = source(f, 'backup-denied');
  const backup = broken.file + '.invalid-' + sha(broken.bytes) + '.bak'; fs.writeFileSync(backup, 'wrong existing backup', { mode: 0o600 });
  const clean = source(f, 'normal', { old: false });
  assert.equal(f.cache.writeScopedCache(f.dir, broken.scope, { ...clean.snapshot, scopeId: broken.scope, models: [] }), false);
  assert.deepEqual(fs.readFileSync(broken.file), broken.bytes);
  const validBefore = fs.readFileSync(clean.file), counted = { calls: 0 };
  const result = await f.catalog.getCatalog({ ...opts(f, clean, false, counted), qualificationDefaults: undefined });
  assert.equal(counted.calls, 0); assert.equal(result.models.length, 80); assert.equal(result.availability.status, 'available');
  assert.equal(f.cache.inspectScopedCache(f.dir, clean.scope).status, 'valid');
  assert.deepEqual(JSON.parse(fs.readFileSync(clean.file)).snapshot.models.map(m => m.capabilityRevision), JSON.parse(validBefore).snapshot.models.map(m => m.capabilityRevision));
  const link = source(f, 'link', { old: false }); fs.unlinkSync(link.file); fs.symlinkSync(clean.file, link.file);
  const targetBefore = fs.readFileSync(clean.file);
  assert.equal(f.cache.inspectScopedCache(f.dir, link.scope).status, 'read_error');
  assert.equal(f.cache.writeScopedCache(f.dir, link.scope, { scopeId: link.scope, models: [], lastSuccessfulAt: null }), false);
  assert.equal(fs.lstatSync(link.file).isSymbolicLink(), true); assert.deepEqual(fs.readFileSync(clean.file), targetBefore);
});
