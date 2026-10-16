import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createStorage } = require('../../shell/storage/index.cjs');
async function freePort() { const server = createServer(); await new Promise((r, j) => server.once('error', j).listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }

test('independent integration: upgrade denies legacy password sessions/routes; callback provisions before cookie', { timeout: 30000 }, async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-google-integration-review-'));
  let storage, child, tenantId, secondTenantId;
  const runtimeDirs = [];
  try {
    const oldMigrations = path.join(tmp, 'old-migrations'); fs.mkdirSync(oldMigrations);
    for (const name of fs.readdirSync(path.join(root, 'shell/db-migrations'))) if (name.endsWith('.sql') && name < '012') fs.copyFileSync(path.join(root, 'shell/db-migrations', name), path.join(oldMigrations, name));
    const dbDir = path.join(tmp, 'db');
    storage = await createStorage({ dataDir: dbDir, masterKeyFile: path.join(tmp, 'key'), migrationsDir: oldMigrations });
    const registered = await storage.repositories.auth.register({ username: 'legacy-review', email: 'review@example.test', password: 'LegacyReview123' });
    assert.equal(registered.ok, true);
    tenantId = registered.user.tenant_id;
    const secondRegistered = await storage.repositories.auth.register({ username: 'second-review', email: 'second@example.test', password: 'SecondReview123' });
    assert.equal(secondRegistered.ok, true);
    secondTenantId = secondRegistered.user.tenant_id;
    const legacy = await storage.repositories.auth.login({ username: 'legacy-review', password: 'LegacyReview123' });
    assert.equal(legacy.ok, true);
    await storage.close(); storage = null;
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    const stopToken = 'review-stop-token';
    // Mock only the external verified identity exchange. Real routes, product composition,
    // PGlite sessions, migration, workspace initialization and Cookie responses remain real.
    const preload = path.join(tmp, 'verified-identity-fixture.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'); const load=Module._load; const crypto=require('node:crypto'); let stateNo=0;
Module._load=function(name,parent,isMain){ const loaded=load.apply(this,arguments); if(parent?.filename.endsWith('auth-google-routes.cjs') && name==='./auth-google.cjs') return {...loaded,createGoogleAuth:async({db})=>({begin:async()=>({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state='+(++stateNo===1?'fixture-state':'fixture-state-'+stateNo)}),callback:async({code})=>{const username=code==='second-user'?'second-review':'legacy-review';const user=(await db.query("SELECT id,username,email,role,tenant_id FROM users WHERE username=$1",[username])).rows[0]; const token=crypto.randomBytes(32).toString('base64url');const expiresAt=new Date(Date.now()+60000).toISOString();await db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,crypto.createHash('sha256').update(token).digest('hex'),expiresAt]);return {ok:true,user,token,expiresAt};}})}; if(parent?.filename.endsWith('/server.cjs') && name==='./tenant.cjs') return {...loaded,runDshForUser:async(userId,question,options)=>{if(question==='hold worker')await new Promise(resolve=>setTimeout(resolve,1200));return loaded.runDshForUser(userId,question,options);}}; return loaded;};`);
    const env = { PATH: process.env.PATH, HOME: tmp, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: path.join(tmp, 'key'), PT_LOG_DIR: path.join(tmp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_TEST_SHUTDOWN_TOKEN: stopToken, PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1', PT_RUNS_GLOBAL: '1', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_REDIRECT_URI: origin + '/api/auth/google/callback' };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
    let ready = false;
    for (let i = 0; i < 200; i++) { if (child.exitCode !== null) break; try { if ((await fetch(origin + '/healthz')).ok) { ready = true; break; } } catch {} await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(ready, output.slice(-3000));
    const oldMe = await fetch(origin + '/api/auth/me', { headers: { Cookie: 'pt_session=' + legacy.token } });
    assert.equal(oldMe.status, 401, 'pre-upgrade password session is revoked by product migration');
    for (const route of ['/api/login', '/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/change-password']) for (const method of ['GET', 'POST', 'PUT']) {
      const response = await fetch(origin + route, { method, headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ username: 'legacy-review', password: 'LegacyReview123' }) }) });
      assert.equal(response.status, 410, method + ' ' + route);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal((await fetch(origin + '/api/auth/google/start', { headers: { Origin: 'https://attacker.example' }, redirect: 'manual' })).status, 403);
    const begin = await fetch(origin + '/api/auth/google/start', { redirect: 'manual' });
    assert.equal(begin.status, 303);
    const binding = begin.headers.get('set-cookie'); assert.match(binding, /HttpOnly/); assert.match(binding, /SameSite=Lax/);
    const missingBinding = await fetch(origin + '/api/auth/google/callback?state=x&code=x', { headers: { Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(missingBinding.headers.get('location'), '/login?error=google_auth');
    assert.equal(missingBinding.headers.get('set-cookie'), null);
    const fixtureDirs = [path.join(root, 'runtime/workspaces', tenantId), path.join(root, 'runtime/workspaces', 'ws_' + tenantId), path.join(root, 'runtime/workspaces', secondTenantId), path.join(root, 'runtime/workspaces', 'ws_' + secondTenantId)];
    for (const dir of fixtureDirs) assert.equal(fs.existsSync(dir), false, 'synthetic workspace must not preexist');
    runtimeDirs.push(...fixtureDirs);
    const callback = await fetch(origin + '/api/auth/google/callback?state=fixture-state&code=fixture-code', { headers: { Cookie: binding.split(';')[0], Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
    const session = callback.headers.get('set-cookie'); assert.match(session, /^pt_session=/); assert.match(session, /HttpOnly/);
    assert.equal(fs.existsSync(path.join(runtimeDirs[0], '.dsh/skills')), true, 'DSH workspace exists before client receives session');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDirs[1], 'metadata.json'))).tenantId, tenantId);
    const me = await fetch(origin + '/api/auth/me', { headers: { Cookie: session.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, registered.user.id);
    const authCookie = session.split(';')[0];
    const keySaved = await fetch(origin + '/api/auth/key', { method: 'POST', headers: { Cookie: authCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fixture-pt-key' }) });
    assert.equal(keySaved.status, 200);
    const createdConversation = await fetch(origin + '/api/conversations', { method: 'POST', headers: { Cookie: authCookie } });
    assert.equal(createdConversation.status, 200);
    const conversationId = (await createdConversation.json()).id;
    const chatBody = { conversationId, message: 'durable run integration' };
    const chatHeaders = { Cookie: authCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'integration-chat-run-1' };
    const chat = await fetch(origin + '/api/chat', { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody) });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type') || '', /text\/event-stream/);
    const runId = chat.headers.get('x-agent-run-id');
    assert.ok(runId, 'chat response identifies its durable run');
    const chatFrames = await chat.text();
    assert.match(chatFrames, /\"done\":true/);
    let run;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(origin + '/api/runs/' + runId, { headers: { Cookie: authCookie } });
      run = (await response.json()).run;
      if (run && ['completed', 'failed', 'cancelled'].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(run.state, 'completed');
    const runEvents = await fetch(origin + '/api/runs/' + runId + '/events', { headers: { Cookie: authCookie } });
    const eventPage = await runEvents.json();
    assert.ok(eventPage.events.some((event) => event.type === 'delta'));
    assert.equal(eventPage.events.at(-1).type, 'done');
    const replay = await fetch(origin + '/api/chat', { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody) });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-agent-run-id'), runId, 'idempotent retry returns the original run');
    assert.match(await replay.text(), /\"done\":true/);
    const history = await fetch(origin + '/api/conversations/' + conversationId, { headers: { Cookie: authCookie } });
    assert.equal((await history.json()).conversation.messages.filter((message) => message.role === 'user').length, 1, 'idempotent retry does not append a duplicate user turn');

    const secondStart = await fetch(origin + '/api/auth/google/start', { redirect: 'manual' });
    assert.equal(secondStart.status, 303);
    const secondBinding = secondStart.headers.get('set-cookie');
    const secondCallback = await fetch(origin + '/api/auth/google/callback?state=fixture-state-2&code=second-user', { headers: { Cookie: secondBinding.split(';')[0], Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(secondCallback.status, 303);
    const secondCookie = secondCallback.headers.get('set-cookie').split(';')[0];
    const secondConversationResponse = await fetch(origin + '/api/conversations', { method: 'POST', headers: { Cookie: secondCookie } });
    const secondConversationId = (await secondConversationResponse.json()).id;
    const holdingResponse = await fetch(origin + '/api/chat', { method: 'POST', headers: { Cookie: authCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'integration-chat-hold' }, body: JSON.stringify({ conversationId, message: 'hold worker' }) });
    const holdingRunId = holdingResponse.headers.get('x-agent-run-id');
    assert.ok(holdingRunId, 'running chat immediately exposes its run ID');
    const holdingFrames = holdingResponse.text();
    const queuedResponse = await fetch(origin + '/api/chat', { method: 'POST', headers: { Cookie: secondCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'integration-chat-queued' }, body: JSON.stringify({ conversationId: secondConversationId, message: 'queued and cancel' }) });
    assert.equal(queuedResponse.status, 200);
    const queuedRunId = queuedResponse.headers.get('x-agent-run-id');
    assert.ok(queuedRunId, 'queued chat immediately exposes its run ID');
    const queuedBeforeCancel = await fetch(origin + '/api/runs/' + queuedRunId, { headers: { Cookie: secondCookie } });
    assert.equal((await queuedBeforeCancel.json()).run.state, 'queued', 'second user is actually queued behind the occupied global worker');
    const cancelResponse = await fetch(origin + '/api/runs/' + queuedRunId + '/cancel', { method: 'POST', headers: { Cookie: secondCookie } });
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).stopped, true, 'HTTP cancellation can stop a durably queued run');
    const queuedFrames = await queuedResponse.text();
    assert.match(queuedFrames, /"queued":true/);
    assert.match(queuedFrames, /"stopped":true/);
    const queuedRunResponse = await fetch(origin + '/api/runs/' + queuedRunId, { headers: { Cookie: secondCookie } });
    assert.equal((await queuedRunResponse.json()).run.state, 'cancelled');
    assert.match(await holdingFrames, /"done":true/);
    fs.writeFileSync(path.join(runtimeDirs[1], 'metadata.json'), 'broken-fixture-json');
    const failedProvision = await fetch(origin + '/api/auth/google/callback?state=fixture-state&code=fixture-code', { headers: { Cookie: binding.split(';')[0], Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(failedProvision.headers.get('location'), '/login?error=google_auth');
    assert.equal(failedProvision.headers.get('set-cookie'), null, 'workspace provisioning failure must not expose a session cookie');
    const crossLogout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: session.split(';')[0], Origin: 'https://attacker.example' } });
    assert.equal(crossLogout.status, 403);
    assert.equal(crossLogout.headers.get('set-cookie'), null);
    await fetch(origin + '/__test_shutdown', { method: 'POST', headers: { 'x-shutdown-token': stopToken } });
    await new Promise((r) => child.once('exit', r));
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
    if (storage) await storage.close();
    for (const dir of runtimeDirs) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
