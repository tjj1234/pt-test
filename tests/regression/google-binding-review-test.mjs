import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createGoogleAuth, ISSUER } = require('../../shell/auth-google.cjs');
const config = { GOOGLE_CLIENT_ID: 'binding-review-client', GOOGLE_CLIENT_SECRET: 'synthetic-not-live', GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8098/api/auth/google/callback' };
async function fixture(t) {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-binding-review-'));
  const storage = await createStorage({ dataDir: path.join(dir, 'db'), masterKeyFile: path.join(dir, 'key') });
  t.after(async () => { try { await storage.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const reg = async (name) => {
    const registered = await storage.repositories.auth.register({ username: name, password: 'BindingReview123', email: name + '@example.test' });
    assert.equal(registered.ok, true);
    const login = await storage.repositories.auth.login({ username: name, password: 'BindingReview123' });
    assert.equal(login.ok, true);
    return { user: registered.user, token: login.token };
  };
  const noNetwork = async () => { throw new Error('Unexpected external call during trusted binding review'); };
  return { storage, reg, makeAuth: (db = storage.db) => createGoogleAuth({ db, config, fetchImpl: noNetwork }) };
}

test('independent trusted binding revokes all target sessions but preserves unrelated sessions and assets', async (t) => {
  const f = await fixture(t);
  const a = await f.reg('bind-review-a'); const b = await f.reg('bind-review-b');
  const second = await f.storage.repositories.auth.login({ username: 'bind-review-a', password: 'BindingReview123' });
  const conv = await f.storage.repositories.conversations.create(a.user.id);
  await f.storage.repositories.conversations.saveMessages(a.user.id, conv.id, [{ role: 'user', text: 'retained asset' }]);
  const auth = await f.makeAuth();
  await auth.bindIdentity({ issuer: ISSUER, subject: 'binding-review-subject', userId: a.user.id, email: 'bind-review-a@example.test', approvedBy: 'trusted-review-operator' });
  assert.equal(await f.storage.repositories.auth.getSession(a.token), null);
  assert.equal(await f.storage.repositories.auth.getSession(second.token), null);
  assert.equal((await f.storage.repositories.auth.getSession(b.token)).user.id, b.user.id);
  assert.equal((await f.storage.db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [a.user.id])).rows[0].n, 0);
  assert.equal((await f.storage.db.query('SELECT user_id FROM google_identities WHERE subject=$1', ['binding-review-subject'])).rows[0].user_id, a.user.id);
  assert.equal((await f.storage.repositories.conversations.get(a.user.id, conv.id)).messages[0].text, 'retained asset');
  assert.equal((await f.storage.db.query('SELECT tenant_id FROM users WHERE id=$1', [a.user.id])).rows[0].tenant_id, a.user.tenant_id);
  await assert.rejects(auth.bindIdentity({ issuer: ISSUER, subject: 'binding-review-subject', userId: b.user.id, email: 'bind-review-b@example.test', approvedBy: 'trusted-review-operator' }), { code: '23505' });
  assert.equal((await f.storage.repositories.auth.getSession(b.token)).user.id, b.user.id, 'failed duplicate bind must not revoke unrelated sessions');
});

test('independent revoke failure rolls back identity binding and preserves old session atomically', async (t) => {
  const f = await fixture(t); const a = await f.reg('bind-rollback-review');
  let deleteAttempted = false;
  const failingDb = {
    query: (...args) => f.storage.db.query(...args),
    transaction: (callback) => f.storage.db.transaction((tx) => callback({ query: async (sql, params) => {
      if (/^DELETE FROM sessions WHERE user_id=\$1/.test(sql)) { deleteAttempted = true; throw new Error('synthetic revocation failure'); }
      return tx.query(sql, params);
    } })),
  };
  const auth = await f.makeAuth(failingDb);
  await assert.rejects(auth.bindIdentity({ issuer: ISSUER, subject: 'rollback-review-subject', userId: a.user.id, email: 'bind-rollback-review@example.test', approvedBy: 'trusted-review-operator' }), /synthetic revocation failure/);
  assert.equal(deleteAttempted, true);
  assert.equal((await f.storage.db.query('SELECT count(*)::int AS n FROM google_identities WHERE user_id=$1', [a.user.id])).rows[0].n, 0, 'identity INSERT rolls back if session revocation fails');
  assert.equal((await f.storage.repositories.auth.getSession(a.token)).user.id, a.user.id);
});
