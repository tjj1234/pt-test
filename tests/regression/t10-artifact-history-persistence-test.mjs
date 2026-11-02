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

test('successful assistant artifact metadata is persisted and replayed from conversation history', { timeout: 45000 }, async () => {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-artifact-history-'));
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
  const runtimeDir = path.join(temp, 'runtime');
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({ username: 'artifact-history', email: 'artifact-history@example.test', password: 'FixtureReview123' });
    assert.equal(registered.ok, true);
    const user = registered.user, token = crypto.randomBytes(32).toString('hex');
    await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)', ['https://accounts.google.com', 'artifact-history', user.id, user.email]);
    await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, sha(token), new Date(Date.now() + 120000).toISOString()]);
    await storage.close(); storage = null;
    const csvFile = path.join(runtimeDir, 'workspaces', user.tenant_id, 'csv-results', 'fixture-run', 'result.csv');
    fs.mkdirSync(path.dirname(csvFile), { recursive: true });
    fs.writeFileSync(csvFile, 'result\r\n4\r\n');

    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const preload = path.join(temp, 'fixtures.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>['fixture-artifact']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>({models:[{id:'fixture-artifact',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-artifact']},syncedAt:Date.now()})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async()=>({ok:true,text:'fixture reply',steps:[],artifacts:[{rel:'reports/verified.pdf',name:'ignored name',url:'https://attacker.example/payload',kind:'html',size:17,mtime:23},{rel:'csv-results/fixture-run/result.csv',name:'result.csv',url:'https://attacker.example/unsafe',kind:'html',size:12,mtime:24},{rel:'../escape.pdf',url:'/unsafe'}]})};
return loaded;};`);
    const env = { PATH: process.env.PATH, HOME: temp, PT_DB_DIR: dbDir, PT_RUNTIME_DIR: runtimeDir, PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1' };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const request = (route, { method = 'GET', body } = {}) => fetch(origin + route, { method, headers: { Cookie: 'pt_session=' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await request('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output.slice(-2500));
    let response = await request('/api/auth/key', { method: 'POST', body: { key: 'fixture-no-paid-model-key' } });
    assert.equal(response.status, 200, await response.clone().text());
    response = await request('/api/conversations', { method: 'POST' });
    assert.equal(response.status, 200, await response.clone().text());
    const { id } = await response.json();
    response = await request('/api/chat', { method: 'POST', body: { conversationId: id, message: 'make an artifact' } });
    assert.equal(response.status, 200, await response.clone().text());
    const frames = await response.text();
    assert.match(frames, /"done":true/);
    const done = frames.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(frame => frame.done);
    const expectedArtifacts = [
      { name: 'ignored name', rel: 'reports/verified.pdf', kind: 'pdf', url: '/api/artifact?p=reports%2Fverified.pdf', size: 17, mtime: 23 },
      { name: 'result.csv', rel: 'csv-results/fixture-run/result.csv', kind: 'csv', url: '/api/artifact?p=csv-results%2Ffixture-run%2Fresult.csv', size: 12, mtime: 24 },
    ];
    assert.deepEqual(done.messages.at(-1).artifacts, expectedArtifacts);
    response = await request('/api/conversations/' + id);
    assert.equal(response.status, 200, await response.clone().text());
    const messages = (await response.json()).conversation.messages;
    assert.deepEqual(messages.at(-1).artifacts, expectedArtifacts);
    response = await request('/api/artifact?p=csv-results%2Ffixture-run%2Fresult.csv');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="result.csv"');
    assert.equal(await response.text(), 'result\r\n4\r\n');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
