import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');

test('conversation lease fencing keeps a stale session owner from saving or releasing its successor', { timeout: 20000 }, async (t) => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false,
    'this probe must use its isolated local PGlite database');
  const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-t04-conversation-fence-'));
  let storage;
  t.after(async () => {
    await storage?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  storage = await createStorage({
    dataDir: path.join(tempRoot, 'db'),
    masterKeyFile: path.join(tempRoot, 'master-key'),
  });
  const registered = await storage.repositories.auth.register({
    username: 't04-conversation-fence', password: 'FixturePass123',
  });
  assert.equal(registered.ok, true);
  const identity = { userId: registered.user.id, tenantId: registered.user.tenant_id };
  const conversation = await storage.repositories.conversations.create(identity.userId);
  const store = createTaskStore(storage.adapter);
  const makeRun = async (key, owner) => (await store.createRun(identity, {
    conversationId: conversation.id,
    idempotencyKey: key,
    request: { question: key },
  }, { owner, ttlMs: 10000 })).run;

  const oldRun = await makeRun('t04-conversation-owner-old', 'worker-old');
  const nextRun = await makeRun('t04-conversation-owner-next', 'worker-next');
  assert.equal(await store.acquireConversationLease(identity, oldRun.runId, 'worker-old', 10000), true);
  await store.transition(identity, oldRun.runId, 'running', 0, 'worker-old');
  assert.equal(await store.acquireConversationLease(identity, nextRun.runId, 'worker-next', 10000), false,
    'a live conversation lease excludes a second Run');

  await storage.adapter.query(
    "UPDATE agent_conversation_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE conversation_id=$1",
    [conversation.id],
  );
  assert.equal(await store.acquireConversationLease(identity, nextRun.runId, 'worker-next', 10000), true,
    'a successor can acquire after expiry');
  await store.transition(identity, nextRun.runId, 'running', 0, 'worker-next');

  const before = (await storage.adapter.query('SELECT messages FROM conversations WHERE id=$1', [conversation.id])).rows[0].messages;
  await assert.rejects(
    store.saveConversationMessages(identity, oldRun.runId, 'worker-old', conversation.id,
      [{ role: 'assistant', text: 'stale session write' }]),
    { code: 'LEASE_LOST' },
    'the stale Run cannot persist conversation history after its successor takes over',
  );
  assert.equal(await store.releaseConversationLease(identity, oldRun.runId, 'worker-old'), false,
    'the stale Run cannot release the successor lease');
  assert.equal(await store.renewConversationLease(identity, nextRun.runId, 'worker-next', 10000), true,
    'the successor remains the sole lease owner');
  const after = (await storage.adapter.query('SELECT messages FROM conversations WHERE id=$1', [conversation.id])).rows[0].messages;
  assert.deepEqual(after, before, 'rejected stale save leaves conversation history unchanged');
  const lease = (await storage.adapter.query('SELECT run_id,lease_owner FROM agent_conversation_leases WHERE conversation_id=$1',
    [conversation.id])).rows[0];
  assert.equal(lease.run_id, nextRun.runId);
  assert.equal(lease.lease_owner, 'worker-next');
});
