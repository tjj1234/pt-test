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
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('memory edits request reset only that user’s DSH sessions', { timeout: 45000 }, async () => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-memory-invalidate-'));
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
    const closeLog = path.join(temp, 'closed-sessions.jsonl');
    const failCloseMarker = path.join(temp, 'fail-close-session-id');
  let storage, child, output = '';
  const cookies = [];
  const readClosed = () => fs.existsSync(closeLog)
    ? fs.readFileSync(closeLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    for (let index = 0; index < 2; index++) {
      const registered = await storage.repositories.auth.register({
        username: `memory-http-${index}`, email: `memory-${index}@example.test`, password: 'FixtureReview123',
      });
      assert.equal(registered.ok, true);
      const user = registered.user;
      await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)', [
        'https://accounts.google.com', `fixture-memory-${index}`, user.id, user.email,
      ]);
      const token = crypto.randomBytes(32).toString('hex');
      await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [
        user.id, sha(token), new Date(Date.now() + 120000).toISOString(),
      ]);
      cookies.push('pt_session=' + token);
    }
    await storage.close(); storage = null;

    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const preload = path.join(temp, 'fixtures.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs'),load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,closeDshSession:sessionId=>{if(fs.existsSync(${JSON.stringify(failCloseMarker)})&&fs.readFileSync(${JSON.stringify(failCloseMarker)},'utf8')===sessionId)throw new Error('fixture close failure');fs.appendFileSync(${JSON.stringify(closeLog)},JSON.stringify({sessionId})+'\\n')}};
return loaded;};`);
    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      PT_RUNTIME_DIR: path.join(temp, 'runtime'),
      PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, 'logs'),
      PT_SHELL_PORT: String(port),
      PT_LISTEN_HOST: '127.0.0.1',
      PT_KEY_LIVE_VERIFY: '0',
      PT_CHAT_DRYRUN: '1',
    };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    async function req(route, { user = 0, method = 'GET', body } = {}) {
      return fetch(origin + route, {
        method,
        headers: { Cookie: cookies[user], ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }
    async function json(route, options) {
      const response = await req(route, options);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await req('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output.slice(-2500));

    const userAConversations = [
      (await json('/api/conversations', { method: 'POST' })).id,
      (await json('/api/conversations', { method: 'POST' })).id,
    ];
    const userBConversation = (await json('/api/conversations', { user: 1, method: 'POST' })).id;

    await json('/api/memory', { method: 'POST', body: { key: 'preference', value: 'A-only context' } });
    assert.deepEqual(readClosed().map(item => item.sessionId).sort(), [...userAConversations].sort(),
      'updating memory requests closure of every conversation session owned by the writer');
    assert.equal(userAConversations.includes(userBConversation), false);
    const userAMemories = await json('/api/memory');
    assert.deepEqual(userAMemories.memories.map(item => item.value), ['A-only context']);

    const afterSet = readClosed().length;
    await json('/api/memory', { user: 1, method: 'POST', body: { key: 'preference', value: 'B-only context' } });
    assert.deepEqual(readClosed().slice(afterSet).map(item => item.sessionId), [userBConversation],
      'another user’s memory edit must not close or inspect A’s sessions');
    const userBMemories = await json('/api/memory', { user: 1 });
    assert.deepEqual(userBMemories.memories.map(item => item.value), ['B-only context']);

    const beforeDelete = readClosed().length;
    await json('/api/memory?key=preference', { method: 'DELETE' });
    assert.deepEqual(readClosed().slice(beforeDelete).map(item => item.sessionId).sort(), [...userAConversations].sort(),
      'deleting memory requests closure of the writer’s existing sessions before reuse');
    assert.deepEqual((await json('/api/memory')).memories, []);
    assert.deepEqual((await json('/api/memory', { user: 1 })).memories.map(item => item.value), ['B-only context']);

    fs.writeFileSync(failCloseMarker, userAConversations[0]);
    const failedRefresh = await req('/api/memory', { method: 'POST', body: { key: 'confirmed', value: 'already saved' } });
    assert.equal(failedRefresh.status, 503);
    assert.deepEqual(await failedRefresh.json(), {
      ok: false, memorySaved: true, code: 'MEMORY_CONTEXT_INVALIDATION_FAILED',
      error: '记忆已更新，但上下文清理未完成；请重试操作后继续。',
    });
    assert.deepEqual((await json('/api/memory')).memories.map(item => item.key), ['confirmed'],
      'the explicit failure response must identify that storage succeeded while invalidation did not');
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
    }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
