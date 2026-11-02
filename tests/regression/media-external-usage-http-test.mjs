import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('recent media external operation usage is user-scoped and excludes raw audit payloads', { timeout: 45000 }, async () => {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false, 'fixture must not use a configured external database');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-media-usage-http-'));
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
  let storage, child, output = '';
  const users = [], cookies = [];
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const stop = async () => {
    if (!child || child.exitCode !== null) { child = null; return; }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer); child = null;
  };
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    for (let i = 0; i < 2; i++) {
      const registered = await storage.repositories.auth.register({ username: 'media-usage-' + i, email: `media-usage-${i}@example.test`, password: 'FixtureReview123' });
      assert.equal(registered.ok, true);
      const user = registered.user; users.push(user);
      const conversation = await storage.repositories.conversations.create(user.id);
      const runId = crypto.randomUUID(), opId = crypto.randomUUID();
      await storage.db.query(
        `INSERT INTO agent_runs (run_id,conversation_id,user_id,tenant_id,workspace_id,contract_version,policy_version,state,idempotency_scope,request_hash,request)
         VALUES ($1,$2,$3,$4,$5,'v1','fixture-policy','completed',$6,$7,$8::jsonb)`,
        [runId, conversation.id, user.id, user.tenant_id, 'ws_' + user.tenant_id, 'fixture-scope-' + i, 'a'.repeat(64), JSON.stringify({ message: 'synthetic media run' })],
      );
      await storage.db.query(
        `INSERT INTO run_external_operations (operation_id,run_id,operation_key,provider,status,task_id,query_attempts,last_query)
         VALUES ($1,$2,$3,'powertokens','manual_check',$4,3,$5::jsonb)`,
        [opId, runId, 'image:poster', 'fixture-task-' + i, JSON.stringify({ outcome: 'provider_state_unknown', observedAt: '2026-10-22T01:02:03.000Z', providerStatus: 'pending', reason: 'fixture', sensitiveResponse: { apiKey: 'never-return-this' } })],
      );
      const token = crypto.randomBytes(32).toString('hex');
      await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 120000).toISOString()]);
      cookies.push('pt_session=' + token);
      if (i === 0) {
        // Lexically older UUID makes a deterministic second page under the
        // store's descending UUID cursor. This row sits inside this calendar
        // week but can be older than a rolling seven-day window.
        await storage.db.query(
          `INSERT INTO run_external_operations (operation_id,run_id,operation_key,provider,status,task_id,query_attempts,last_query,updated_at)
           VALUES ($1,$2,'image:older','powertokens','manual_check','fixture-task-older',1,$3::jsonb,date_trunc('day',now()) - interval '7 days' + interval '1 hour')`,
          ['00000000-0000-4000-8000-000000000001', runId, JSON.stringify({ observedAt: '2026-10-16T01:00:00.000Z', sensitiveResponse: { apiKey: 'never-return-this' } })],
        );
      }
    }
    await storage.close(); storage = null;
    const env = { PATH: process.env.PATH, HOME: temp, PT_RUNTIME_DIR: path.join(temp, 'runtime'), PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1', PT_RUNS_GLOBAL: '1' };
    child = spawn(process.execPath, ['shell/server.cjs', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await fetch(origin + '/api/auth/me', { headers: { Cookie: cookies[0] } })).status === 200) break; } catch { /* server startup */ }
      if (i === 149) throw Error('server did not start: ' + output.slice(-2500));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const response = await fetch(origin + '/api/usage/external-operations?range=week&limit=1', { headers: { Cookie: cookies[0] } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.operations.length, 1, 'page is limited to one operation');
    assert.equal(body.hasMore, true, 'first page exposes a continuation');
    const operation = body.operations[0];
    assert.deepEqual(operation, {
      runId: operation.runId,
      operationKey: 'image:poster',
      provider: 'powertokens',
      taskId: 'fixture-task-0',
      status: 'manual_check',
      queryAttempts: 3,
      observedAt: '2026-10-22T01:02:03.000Z',
      cost: null,
      currency: null,
      costCoverage: 'unknown',
    });
    assert.ok(users[1]);
    assert.equal(JSON.stringify(body).includes('never-return-this'), false, 'raw provider audit payload is not exposed');
    const next = await fetch(origin + '/api/usage/external-operations?range=week&limit=1&afterOperationId=' + encodeURIComponent(body.nextCursor), { headers: { Cookie: cookies[0] } });
    assert.equal(next.status, 200, await next.clone().text());
    const nextBody = await next.json();
    assert.equal(nextBody.operations.length, 1, 'second page returns the remaining current-user operation');
    assert.equal(nextBody.operations[0].taskId, 'fixture-task-older');
    assert.equal(nextBody.hasMore, false, 'last page has no continuation');
    const today = await fetch(origin + '/api/usage/external-operations?range=today&limit=10', { headers: { Cookie: cookies[0] } });
    assert.deepEqual((await today.json()).operations.map(row => row.taskId), ['fixture-task-0'], 'today range excludes older calendar-week record');
    assert.equal((await fetch(origin + '/api/usage/external-operations?range=forever', { headers: { Cookie: cookies[0] } })).status, 400);
    const other = await fetch(origin + '/api/usage/external-operations?range=month', { headers: { Cookie: cookies[1] } });
    assert.deepEqual((await other.json()).operations.map(row => row.taskId), ['fixture-task-1']);
  } finally {
    await stop(); if (storage) await storage.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});
