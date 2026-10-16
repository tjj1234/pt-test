import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createStorage, DEFAULT_MIGRATIONS_DIR } = require('../../shell/storage/index.cjs');
const dbmod = require('../../shell/db.cjs');
const legacyDir = path.join(root, 'shell/storage/migrations');
const migrationNames = (directory) => fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();

// Fail rather than run the fixture against an explicitly configured production PG.
function assertIsolatedEnvironment() {
  for (const name of Object.keys(process.env)) {
    assert.ok(!(/^PT_PG_/.test(name) && process.env[name]), 'Unset PostgreSQL configuration before running isolated PGlite test: ' + name);
  }
  assert.ok(dbmod.resolvePgliteEntry(), 'Install declared shell dependencies first; no fallback or skip');
}
async function snapshot(storage, userId) {
  const result = {};
  for (const table of ['users', 'sessions', 'conversations', 'user_memory', 'api_keys']) {
    const where = table === 'users' ? 'id' : 'user_id';
    const order = table === 'user_memory' ? 'key' : 'id';
    result[table] = (await storage.adapter.query(`SELECT * FROM ${table} WHERE ${where}=$1 ORDER BY ${order}`, [userId])).rows;
  }
  return result;
}

test('storage defaults to the same complete migration source as product auth', () => {
  assert.equal(DEFAULT_MIGRATIONS_DIR, path.join(root, 'shell/db-migrations'));
  assert.ok(migrationNames(DEFAULT_MIGRATIONS_DIR).includes('010_usage_and_tool_metadata.sql'));
  // Old applied names remain valid; they must never be renamed for this change.
  for (const name of migrationNames(legacyDir)) assert.ok(migrationNames(DEFAULT_MIGRATIONS_DIR).includes(name), name);
});

test('real legacy PGlite upgrades, preserves assets and sessions, and reopens idempotently', async () => {
  assertIsolatedEnvironment();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-storage-upgrade-'));
  const opts = { dataDir: path.join(tmp, 'db'), masterKeyFile: path.join(tmp, 'master.key') };
  let current;
  try {
    current = await createStorage({ ...opts, migrationsDir: legacyDir });
    const oldNames = (await current.adapter.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    assert.deepEqual(oldNames, migrationNames(legacyDir));
    assert.equal((await current.adapter.query("SELECT to_regclass('public.chat_usage') AS name")).rows[0].name, null);
    const reg = await current.repositories.auth.register({ username: 'upgrade-fixture', email: 'upgrade@example.test', password: 'UpgradeTest123' });
    assert.equal(reg.ok, true);
    const uid = reg.user.id;
    const login = await current.repositories.auth.login({ username: 'upgrade-fixture', password: 'UpgradeTest123' });
    assert.equal(login.ok, true);
    const conv = await current.repositories.conversations.create(uid);
    const messages = [{ role: 'user', text: '保留旧对话', ts: '2026-10-16T00:00:00.000Z' }, { role: 'assistant', text: '历史回答', ts: '2026-10-16T00:00:01.000Z' }];
    await current.repositories.conversations.saveMessages(uid, conv.id, messages);
    await current.repositories.conversations.rename(uid, conv.id, '升级保留测试');
    await current.repositories.conversations.setArchived(uid, conv.id, true);
    await current.repositories.memory.set(uid, 'company', '升级前资料');
    await current.repositories.memory.setModel(uid, 'fixture-model');
    const syntheticKey = 'pt_test_not_a_live_credential_4321';
    assert.equal((await current.repositories.keys.encryptApiKey(uid, syntheticKey)).ok, true);
    const before = await snapshot(current, uid);
    assert.notEqual(before.api_keys[0].ciphertext, syntheticKey);
    await current.close();
    current = null;

    current = await createStorage(opts);
    assert.equal(current.db, current.repositories.auth.db, 'storage shares the auth-owned real connection');
    assert.equal(current.ownsDb, false);
    assert.deepEqual(await snapshot(current, uid), before, 'upgrade leaves all old rows byte-value equivalent');
    assert.equal((await current.repositories.auth.getSession(login.token)).user.id, uid);
    assert.equal((await current.repositories.conversations.get(uid, conv.id)).archived, true);
    assert.deepEqual((await current.repositories.conversations.get(uid, conv.id)).messages, messages);
    assert.equal((await current.repositories.memory.list(uid))[0].value, '升级前资料');
    assert.equal(await current.repositories.memory.getModel(uid), 'fixture-model');
    assert.equal(await current.repositories.keys.decryptApiKey(uid), syntheticKey);
    const expected = migrationNames(DEFAULT_MIGRATIONS_DIR);
    const applied = async () => (await current.adapter.query('SELECT name, applied_at FROM schema_migrations ORDER BY name')).rows;
    const upgraded = await applied();
    assert.deepEqual(upgraded.map((r) => r.name), expected);
    assert.equal(new Set(upgraded.map((r) => r.name)).size, expected.length);
    for (const name of ['roles', 'tool_calls', 'auth_accounts', 'chat_usage']) assert.equal((await current.adapter.query('SELECT to_regclass($1) AS name', ['public.' + name])).rows[0].name, name);
    const columns = (await current.adapter.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='tool_calls' AND column_name IN ('token_count','category','model_name') ORDER BY column_name")).rows;
    assert.deepEqual(columns, [{ column_name: 'category', is_nullable: 'YES' }, { column_name: 'model_name', is_nullable: 'YES' }, { column_name: 'token_count', is_nullable: 'YES' }]);
    await current.migrate();
    assert.deepEqual(await applied(), upgraded, 'repeat migrate does not rewrite application records');
    const afterSessionTouch = await snapshot(current, uid);

    // shutdown requests may originate from both owners; the real handle closes once.
    let closes = 0;
    const ownedClose = current.repositories.auth.close;
    current.repositories.auth.close = async () => { closes++; return ownedClose(); };
    const firstClose = current.close();
    const secondClose = current.adapter.close();
    assert.equal(firstClose, secondClose, 'all callers share shutdown completion');
    await Promise.all([firstClose, secondClose]);
    await current.close();
    assert.equal(closes, 1);
    current = null;

    current = await createStorage(opts);
    assert.deepEqual(await applied(), upgraded, 'restart applies no duplicate migrations');
    assert.deepEqual(await snapshot(current, uid), afterSessionTouch, 'second reopen preserves rows and sessions');
    assert.equal(await current.repositories.keys.decryptApiKey(uid), syntheticKey);
    await current.adapter.transaction(async (tx) => {
      await tx.query('INSERT INTO user_memory (user_id,key,value) VALUES ($1,$2,$3)', [uid, 'committed', 'yes']);
    });
    await assert.rejects(current.adapter.transaction(async (tx) => {
      await tx.query('INSERT INTO user_memory (user_id,key,value) VALUES ($1,$2,$3)', [uid, 'rolled-back', 'no']);
      throw new Error('fixture rollback');
    }), /fixture rollback/);
    assert.equal((await current.adapter.query("SELECT value FROM user_memory WHERE user_id=$1 AND key='committed'", [uid])).rows[0].value, 'yes');
    assert.equal((await current.adapter.query("SELECT 1 FROM user_memory WHERE user_id=$1 AND key='rolled-back'", [uid])).rows.length, 0);
  } finally {
    try { if (current) await current.close(); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});
