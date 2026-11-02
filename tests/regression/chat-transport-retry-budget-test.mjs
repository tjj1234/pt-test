import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, flush } from '../helpers/app-harness.mjs';

test('controlled trial URL disables the automatic preheader chat replay', async () => {
  const app = await bootApp({
    search: '?northstarNoChatRetry=1',
    rejectFirstChatFetch: true,
    setTimeout: (fn, delay) => setTimeout(fn, delay === 1000 ? 0 : delay),
    modelCatalogResponse: { ok: true, auto: 'AUTO', current: 'fixture-chat', models: [{ id: 'fixture-chat', chat: true, availability: 'present', runtimeStatus: 'verified' }], eligibility: { 'fixture-chat': { ok: true, mode: 'manual' } } },
    conversations: { A: { id: 'A', title: 'A', archived: false, messages: [] } },
  });
  await app.awaitRun("openConversation('A')");
  await app.awaitRun('loadModels()');
  await flush(6);
  app.el('modelSelect').value = 'fixture-chat';
  await app.awaitRun("ask('controlled trial')");
  assert.equal(app.db.chatAttempts, 1);
  assert.equal(app.db.chatCalls.length, 0);
});
