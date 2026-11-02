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
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assetHost = 'https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev';
const expected = {
  image: { type: 'image', url: assetHost + '/fixture-image.png' },
  video: { type: 'video', url: assetHost + '/fixture-video.mp4' },
};

test('local HTTP/PGlite persists fixture media and serves the browser render/CSP chain', { timeout: 45000 }, async () => {
  assert.equal(Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key]), false);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-f1-ui-media-http-'));
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({ username: 'f1-ui-media', email: 'f1-ui-media@example.test', password: 'FixtureReview123' });
    assert.equal(registered.ok, true);
    const user = registered.user, token = crypto.randomBytes(32).toString('hex');
    await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',
      ['https://accounts.google.com', 'fixture-f1-ui-media', user.id, user.email]);
    await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',
      [user.id, sha(token), new Date(Date.now() + 120000).toISOString()]);
    await storage.close(); storage = null;

    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const preload = path.join(temp, 'fixture.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>["fixture-chat"]};

if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>({models:[{id:'fixture-chat',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-chat']},syncedAt:Date.now()})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(_uid,question)=>{if(question.includes('failure'))return {ok:false,error:'fixture media outcome unknown',steps:[{name:'media_route',args:JSON.stringify({taskType:'text2video',prompt:'fixture private prompt'}),result:'fixture private result',isError:true}]};const video=question.includes('video');return {ok:true,text:video?'fixture video reply':'fixture image reply',steps:[{name:'media_route',args:JSON.stringify({taskType:video?'text2video':'text2image',prompt:'fixture private prompt'})},{name:'media_route',result:'fixture private result',isError:false}],media:[{type:video?'video':'image',url:${JSON.stringify(assetHost)}+(video?'/fixture-video.mp4':'/fixture-image.png')}],modelIdentity:{coverage:'reported',responses:[{responseSeq:1,configuredModelId:'fixture-chat',providerReportedModelId:'fixture-upstream',evidence:'provider_response_model'}]}};}};
return loaded;};`);
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: temp, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile,
        PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1',
        PT_KEY_LIVE_VERIFY: '0', PT_CHAT_DRYRUN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const request = (route, { method = 'GET', body, auth = true } = {}) => fetch(origin + route, {
      method, headers: { ...(auth ? { Cookie: 'pt_session=' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await request('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output.slice(-2500));
    let response = await request('/api/auth/key', { method: 'POST', body: { key: 'fixture-no-paid-model-key' } });
    assert.equal(response.status, 200, await response.clone().text());
    response = await request('/api/conversations', { method: 'POST' });
    assert.equal(response.status, 200, await response.clone().text());
    const { id } = await response.json();

    const runIds = [];
    for (const kind of ['image', 'video']) {
      response = await request('/api/chat', { method: 'POST', body: { conversationId: id, message: 'fixture ' + kind } });
      assert.equal(response.status, 200, await response.clone().text());
      const runId = response.headers.get('x-agent-run-id');
      assert.match(runId || '', /^[0-9a-f-]{36}$/i);
      runIds.push(runId);
      const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const done = frames.find(frame => frame.done);
      assert.equal(done?.ok, true);
      assert.deepEqual(done.messages.at(-1).media, [expected[kind]]);
      assert.equal(done.messages.at(-1).runId, runId);
    }
    response = await request('/api/conversations/' + id);
    assert.equal(response.status, 200, await response.clone().text());
    const history = (await response.json()).conversation.messages;
    assert.deepEqual(history.filter(message => message.role === 'assistant').map(message => message.media), [[expected.image], [expected.video]]);
    assert.deepEqual(history.filter(message => message.role === 'assistant').map(message => message.runId), runIds);
    for (const runId of runIds) {
      assert.equal((await request('/api/runs/' + runId)).status, 200);
      assert.notEqual((await request('/api/runs/' + runId, { auth: false })).status, 200);
      const eventsResponse = await request('/api/runs/' + runId + '/events?after=0&limit=100');
      assert.equal(eventsResponse.status, 200);
      const identityEvent = (await eventsResponse.json()).events.find(event => event.type === 'state' && event.payload?.action === 'model_identity_evidence');
      assert.equal(identityEvent?.payload?.coverage, 'reported');
      assert.equal(identityEvent?.payload?.responses?.[0]?.providerReportedModelId, 'fixture-upstream');
    }
    response = await request('/api/chat', { method: 'POST', body: { conversationId: id, message: 'fixture failure' } });
    assert.equal(response.status, 200, await response.clone().text());
    const failedRunId = response.headers.get('x-agent-run-id');
    assert.match(failedRunId || '', /^[0-9a-f-]{36}$/i);
    const failedFrames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(failedFrames.find(frame => frame.done)?.ok, false);
    response = await request('/api/conversations/' + id);
    const failedHistory = (await response.json()).conversation.messages.at(-1);
    assert.equal(failedHistory.runId, failedRunId);
    assert.equal(Object.hasOwn(failedHistory, 'steps'), false, 'failed history does not persist raw tool arguments');
    assert.equal((await request('/api/runs/' + failedRunId)).status, 200);
    const anonymous = await request('/api/conversations/' + id, { auth: false });
    assert.notEqual(anonymous.status, 200, 'anonymous request cannot reopen this history');

    const home = await request('/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /assets\/chat-media\.js/);
    assert.match(html, /assets\/app\.js/);
    const csp = home.headers.get('content-security-policy') || '';
    for (const directive of ['img-src', 'media-src', 'connect-src']) assert.match(csp, new RegExp(directive + "[^;]*" + assetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const script of ['/assets/chat-media.js', '/assets/app.js']) {
      const asset = await request(script);
      assert.equal(asset.status, 200, script);
      assert.ok((await asset.text()).length > 100, script + ' must serve executable source');
    }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
