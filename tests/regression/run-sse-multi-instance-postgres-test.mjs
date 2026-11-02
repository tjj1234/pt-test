import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const { createTaskStore } = require('../../shell/tasks/store.cjs');
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function observe(response) {
  const events = []; let error;
  const done = (async () => {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  done.catch(cause => { error = cause; });
  return { events, done, async until(seq) {
    const started = Date.now();
    while (!events.some(event => event.seq === seq)) {
      if (error) throw error;
      assert.ok(Date.now() - started < 10000, 'HTTP observer failed to receive durable sequence ' + seq);
      await pause(20);
    }
  } };
}
test('PostgreSQL HTTP observers replay and poll another pool without future-cursor interference', { timeout: 30000 }, async () => {
  assert.ok(process.env.PT_PG_DSN, 'Requires an isolated disposable PostgreSQL database');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-sse-pg-'));
  const children = [], controllers = [];
  const total = new AbortController();
  const deadline = setTimeout(() => total.abort(), 20000);
  let storage;
  try {
    storage = await createStorage({ dataDir: path.join(temp, 'unused'), masterKeyFile: path.join(temp, 'key') });
    const user = await storage.repositories.auth.register({ username: 'sse-pg-' + crypto.randomUUID(), password: 'FixturePass123' });
    assert.equal(user.ok, true);
    const identity = { userId: user.user.id, tenantId: user.user.tenant_id };
    const conversation = await storage.repositories.conversations.create(identity.userId);
    const token = crypto.randomBytes(32).toString('base64url');
    await storage.adapter.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [identity.userId, crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 120000).toISOString()]);
    const headers = { Cookie: 'pt_session=' + token };
    const store = createTaskStore(storage.adapter), owner = 'external-sse-writer';
    const created = await store.createRun(identity, { conversationId: conversation.id, idempotencyKey: crypto.randomUUID(), request: { question: 'no model execution' } }, { owner, ttlMs: 120000 });
    const runId = created.run.runId;
    await store.transition(identity, runId, 'running', created.run.revision, owner);
    const base = await store.eventsAfter(identity, runId, { after: 0, limit: 500 });
    const cursor = base.nextCursor;
    const origins = [];
    for (let i = 0; i < 2; i++) {
      total.signal.throwIfAborted();
      const port = await freePort(), origin = 'http://127.0.0.1:' + port;
      const env = { PATH: process.env.PATH, HOME: temp, PT_PG_DSN: process.env.PT_PG_DSN,
        PT_DB_DIR: path.join(temp, 'unused-' + i), PT_MASTER_KEY_FILE: path.join(temp, 'key'),
        PT_LOG_DIR: path.join(temp, 'logs-' + i), PT_LISTEN_HOST: '127.0.0.1', PT_SHELL_PORT: String(port),
        PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1' };
      const child = spawn(process.execPath, ['shell/server.cjs', '--port', String(port)], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let logs = '', spawnError;
      child.on('error', error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-2000); });
      let ready = false;
      for (let n = 0; n < 120; n++) {
        total.signal.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
        try { if ((await fetch(origin + '/healthz', { signal: AbortSignal.any([total.signal, AbortSignal.timeout(1000)]) })).ok) { ready = true; break; } } catch {}
        await pause(50);
      }
      assert.ok(ready, 'isolated server failed to start: ' + (spawnError?.code || logs));
      assert.equal((await fetch(origin + '/api/auth/me', { headers, signal: AbortSignal.any([total.signal, AbortSignal.timeout(2000)]) })).status, 200);
      origins.push(origin);
    }
    const url = origin => origin + '/api/runs/' + runId + '/events?stream=1';
    const marker = await store.appendEvent(identity, runId, { type: 'delta', payload: { delta: 'replay-marker' }, leaseOwner: owner });
    const futureControl = new AbortController(); controllers.push(futureControl);
    const future = await fetch(url(origins[1]), { headers: { ...headers, 'Last-Event-ID': '10000' }, signal: AbortSignal.any([total.signal, futureControl.signal]) });
    assert.equal(future.status, 200);
    const responses = [];
    for (const origin of origins) {
      const control = new AbortController(); controllers.push(control);
      const response = await fetch(url(origin), { headers: { ...headers, 'Last-Event-ID': String(cursor) }, signal: AbortSignal.any([total.signal, control.signal]) });
      assert.equal(response.status, 200); responses.push(observe(response));
    }
    await Promise.all(responses.map(observer => observer.until(marker.seq)));
    const live = await store.appendEvent(identity, runId, { type: 'delta', payload: { delta: 'external-pool-event' }, leaseOwner: owner });
    // This event did not exist when the marker's replay page was read.
    // Require actual streaming delivery before closing the durable Run.
    await Promise.all(responses.map(observer => observer.until(live.seq)));
    const running = await store.getRun(identity, runId);
    await store.transition(identity, runId, 'completed', running.revision, owner);
    const expected = (await store.eventsAfter(identity, runId, { after: cursor, limit: 500 })).events;
    assert.ok(expected.some(event => event.seq === live.seq));
    for (const observer of responses) {
      await observer.done;
      const events = observer.events;
      assert.deepEqual(events.map(event => event.seq), expected.map(event => event.seq), 'each HTTP process receives every external durable event once, in order');
      assert.equal(events.at(-1).type, 'done');
    }
    futureControl.abort(); await future.body.cancel().catch(() => {});
    const replayControl = new AbortController(); controllers.push(replayControl);
    const replay = await fetch(url(origins[1]), { headers: { ...headers, 'Last-Event-ID': String(live.seq) }, signal: AbortSignal.any([total.signal, replayControl.signal]) });
    const replayText = await replay.text();
    assert.deepEqual([...replayText.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1])), expected.filter(event => event.seq > live.seq).map(event => event.seq));
  } finally {
    clearTimeout(deadline);
    total.abort();
    for (const control of controllers) control.abort();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed;
    }
    await storage?.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});
