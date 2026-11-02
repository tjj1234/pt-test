import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const authModule = require('../../shell/auth.cjs');
const keysModule = require('../../shell/keys.cjs');
const conversationsModule = require('../../shell/conversations.cjs');
const memoryModule = require('../../shell/memory.cjs');
const { createStorage } = require('../../shell/storage/index.cjs');
const dbModule = require('../../shell/db.cjs');

test('post-auth repository initialization failure closes the auth-owned database and preserves the original error', async () => {
  const originals = {
    initAuth: authModule.initAuth,
    initKeys: keysModule.initKeys,
    initConversations: conversationsModule.initConversations,
    initMemory: memoryModule.initMemory,
  };
  const initializationError = new Error('fixture repository initialization failed');
  let closeCalls = 0;
  const db = { query: async () => ({ rows: [] }), transaction: async () => {} };
  authModule.initAuth = async () => ({ db, close: async () => { closeCalls++; throw new Error('fixture close failure'); } });
  keysModule.initKeys = async () => { throw initializationError; };
  conversationsModule.initConversations = async () => { throw new Error('unexpected initializer'); };
  memoryModule.initMemory = async () => { throw new Error('unexpected initializer'); };
  try {
    await assert.rejects(createStorage(), (error) => error === initializationError);
    assert.equal(closeCalls, 1, 'the auth-owned database close is attempted exactly once');
  } finally {
    authModule.initAuth = originals.initAuth;
    keysModule.initKeys = originals.initKeys;
    conversationsModule.initConversations = originals.initConversations;
    memoryModule.initMemory = originals.initMemory;
  }
});

test('auth initialization migration failure closes the auth-owned database and preserves the original error', async () => {
  const originals = { open: dbModule.open, migrate: dbModule.migrate };
  const migrationError = new Error('fixture migration failure');
  let closeCalls = 0;
  dbModule.open = async () => ({ db: {}, close: async () => { closeCalls++; throw new Error('fixture close failure'); } });
  dbModule.migrate = async () => { throw migrationError; };
  try {
    await assert.rejects(authModule.initAuth({ dataDir: 'unused-fixture-path' }), error => error === migrationError);
    assert.equal(closeCalls, 1, 'initAuth must close its database handle exactly once after migration fails');
  } finally {
    dbModule.open = originals.open;
    dbModule.migrate = originals.migrate;
  }
});

test('default-admin seeding failure closes the auth-owned database and preserves the original error', async () => {
  const originals = { open: dbModule.open, migrate: dbModule.migrate };
  const seedError = new Error('fixture default-admin seed failure');
  let closeCalls = 0;
  dbModule.open = async () => ({
    db: { query: async () => { throw seedError; }, transaction: async () => {} },
    close: async () => { closeCalls++; throw new Error('fixture close failure'); },
  });
  dbModule.migrate = async () => 0;
  try {
    await assert.rejects(authModule.initAuth({
      dataDir: 'unused-fixture-path',
      defaultAdmin: { username: 'fixture-admin', password: 'Fixture123456' },
    }), error => error === seedError);
    assert.equal(closeCalls, 1, 'initAuth must close its database handle exactly once after seeding fails');
  } finally {
    dbModule.open = originals.open;
    dbModule.migrate = originals.migrate;
  }
});
