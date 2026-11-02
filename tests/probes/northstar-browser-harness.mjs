// Controlled real server/UI/storage; fixture OAuth/model only. No paid calls.
// Start: node tests/probes/northstar-browser-harness.mjs
// Control: node tests/probes/northstar-browser-harness.mjs --control <controlDir> status|release A|release B|disconnect-streams|shutdown
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
function evidence(directory) {
 const file = path.join(directory, 'evidence.jsonl');
 return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function status(directory) {
 const events = evidence(directory);
 return { requests: events.filter(e => e.type === 'request').length, chatRequests: events.filter(e => e.type === 'request' && e.route === '/api/chat').length,
  createdRuns: events.filter(e => e.type === 'run' && !e.replayed).length, runAdmissions: events.filter(e => e.type === 'run').length,
  streamDisconnectCommands: events.filter(e => e.type === 'stream_disconnected').length, disconnectedStreams: events.filter(e => e.type === 'stream_disconnected').reduce((sum, event) => sum + event.count, 0),
  modelInvocations: events.filter(e => e.type === 'start').length, completed: events.filter(e => e.type === 'finish').length, events };
}
if (process.argv[2] === '--control') {
 const directory = fs.realpathSync(process.argv[3]);
 if (!path.basename(directory).startsWith('northstar-browser-') || !fs.existsSync(path.join(directory, 'harness-marker'))) throw Error('Not a harness control directory');
 const [command, label] = process.argv.slice(4);
 if (command === 'status') console.log(JSON.stringify(status(directory)));
 else if (command === 'release' && ['A', 'B'].includes(label)) { fs.writeFileSync(path.join(directory, 'release-' + label), 'release\n'); console.log(JSON.stringify({ released: label })); }
 else if (command === 'disconnect-streams') { fs.writeFileSync(path.join(directory, 'disconnect-streams'), crypto.randomUUID()); console.log(JSON.stringify({ requested: 'disconnect-streams' })); }
 else if (command === 'shutdown') fs.writeFileSync(path.join(directory, 'shutdown'), 'shutdown\n');
 else throw Error('Usage: --control <controlDir> status|release A|release B|disconnect-streams|shutdown');
} else {
 // A configured external database would defeat fixture isolation.
 if (Object.keys(process.env).some(key => key.startsWith('PT_PG_') && process.env[key])) throw Error('Unset PT_PG_* before starting isolated browser harness');
 const { createStorage } = require('../../shell/storage/index.cjs');
 const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-browser-'));
 fs.writeFileSync(path.join(tmp, 'harness-marker'), 'controlled-browser-fixture-v1\n');
 let child, storage, tenantId, closePromise, controlTimer;
 async function cleanup() {
  if (closePromise) return closePromise;
  closePromise = (async () => {
   clearInterval(controlTimer);
   if (child?.pid && child.exitCode === null && child.signalCode === null) {
    let timer;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(timer); }
   }
   await storage?.close();
   if (tenantId && /^[A-Za-z0-9_-]+$/.test(tenantId)) for (const id of [tenantId, 'ws_' + tenantId]) fs.rmSync(path.join(process.env.PT_RUNTIME_DIR || path.join(root, 'runtime'), 'workspaces', id), { recursive: true, force: true });
   fs.rmSync(tmp, { recursive: true, force: true });
  })(); return closePromise;
 }
 const shutdown = async () => { await cleanup(); process.exit(0); };
 process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
 try {
  const dbDir = path.join(tmp, 'db'), masterKeyFile = path.join(tmp, 'key');
  storage = await createStorage({ dataDir: dbDir, masterKeyFile });
  const registered = await storage.repositories.auth.register({ username: 'browser-fixture', email: 'browser@example.test', password: 'Fixture123456' });
  if (!registered.ok) throw Error('Fixture registration failed');
  tenantId = registered.user.tenant_id; await storage.close(); storage = null;
  const listener = net.createServer(); await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const preload = path.join(tmp, 'preload.cjs');
  fs.writeFileSync(preload, String.raw`
const Module=require('node:module'),load=Module._load,crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
let sequence=0,invocations=0;
const record=event=>fs.appendFileSync(path.join(process.env.FIXTURE_CONTROL_DIR,'evidence.jsonl'),JSON.stringify({seq:++sequence,...event})+'\n');
const chatResponses=new Set();let lastDisconnectToken='',streamSequence=0;
const disconnectTimer=setInterval(()=>{
 let token;try{token=fs.readFileSync(path.join(process.env.FIXTURE_CONTROL_DIR,'disconnect-streams'),'utf8');}catch(error){if(error.code==='ENOENT')return;record({type:'control_error',code:'CONTROL_READ_FAILED'});return;}
 if(!token||token===lastDisconnectToken)return;lastDisconnectToken=token;
 const targets=[...chatResponses].filter(entry=>!entry.res.destroyed&&!entry.res.writableEnded&&String(entry.res.getHeader('content-type')||'').includes('text/event-stream'));
 const streamIds=targets.map(entry=>entry.streamId);
 for(const entry of targets)entry.res.destroy();
 record({type:'stream_disconnected',count:targets.length,streamIds});
},50);disconnectTimer.unref();
Module._load=function(name,parent,isMain){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='http')return {...value,createServer:handler=>value.createServer((req,res)=>{
 const route=new URL(req.url,'http://fixture').pathname;
 if(route==='/api/chat'||route.startsWith('/api/runs/'))record({type:'request',method:req.method,route});
 if(route==='/api/chat'){
  const entry={res,streamId:++streamSequence};chatResponses.add(entry);
  res.once('close',()=>chatResponses.delete(entry));res.once('finish',()=>chatResponses.delete(entry));
 }
 return handler(req,res);
})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tasks/store.cjs')return {...value,createTaskStore:(...args)=>{const store=value.createTaskStore(...args);return {...store,createRun:async(...input)=>{const result=await store.createRun(...input);record({type:'run',runId:result.run.runId,conversationId:result.run.conversationId,replayed:!!result.replayed});return result;}};}};
if(parent?.filename.endsWith('/auth-google-routes.cjs')&&name==='./auth-google.cjs')return {...value,createGoogleAuth:async({db})=>({begin:async()=>({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=browser-fixture'}),callback:async()=>{const user=(await db.query("SELECT id,username,email,role,tenant_id FROM users WHERE username='browser-fixture'")).rows[0];const token=crypto.randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+3600000).toISOString();await db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,crypto.createHash('sha256').update(token).digest('hex'),expiresAt]);return {ok:true,user,token,expiresAt};}})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async()=>({models:[{id:'fixture-chat',name:'受控文本模型',chat:true,capabilityStatus:'supported',runtimeStatus:'verified',availability:'present',permission:true,localPolicy:{enabled:true},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-chat']},syncedAt:Date.now(),auto:'AUTO'}),routeModelFor:()=> 'fixture-chat',pickDefaultModel:()=> 'fixture-chat'};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...value,runDshForUser:async(user,question,opts)=>{
 const invocationId=++invocations,label=question==='hold A'?'A':question==='hold B'?'B':null;
 record({type:'start',invocationId,label,conversationId:opts.conversationId});
 if(!label)throw Object.assign(Error('Use exactly hold A or hold B in this fixture'),{code:'FIXTURE_INPUT_REQUIRED'});
 let stopped=false,timedOut=false;opts.onSpawn?.({abort(){stopped=true;},kill(){stopped=true;}});opts.onDelta?.('受控任务进行中');
 const deadline=Date.now()+90000;
 while(!stopped&&!fs.existsSync(path.join(process.env.FIXTURE_CONTROL_DIR,'release-'+label))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
 timedOut=!stopped&&Date.now()>=deadline;
 record({type:'finish',invocationId,label,conversationId:opts.conversationId,stopped,timedOut});
 return {ok:!stopped&&!timedOut,stopped:stopped||timedOut,stopReason:stopped?'user':timedOut?'timeout':undefined,text:stopped||timedOut?'':question+' completed',steps:[],usage:{inputTokens:4,outputTokens:1,totalTokens:5},usageEvidence:{observedResponses:1,coverage:'complete',responses:[{responseSeq:1,usage:{inputTokens:4,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null}}]}};
}};
return value;};`);
  const runtimeDir = path.join(tmp, 'northstar-runtime');
  const env = { PATH: process.env.PATH, HOME: tmp, PT_RUNTIME_DIR: runtimeDir, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(tmp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0', PT_RUNS_GLOBAL: '4', PT_RUNS_PER_USER: '2', GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture', GOOGLE_REDIRECT_URI: origin + '/api/auth/google/callback', FIXTURE_CONTROL_DIR: tmp };
  child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError; child.once('error', () => { spawnError = true; });
  child.stdout.resume(); child.stderr.resume();
  let ready = false;
  for (let n = 0; n < 200; n++) {
   if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
   try { if ((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
   await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!ready) throw Error('Controlled server failed to start; raw logs withheld');
  const fixtureFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const begin = await fixtureFetch(origin + '/api/auth/google/start', { redirect: 'manual' });
  if (!begin.headers.get('set-cookie')) throw Error('Controlled login start failed: ' + begin.status);
  const binding = begin.headers.get('set-cookie').split(';')[0];
  const callback = await fixtureFetch(origin + '/api/auth/google/callback?state=browser-fixture&code=fixture', { headers: { Cookie: binding }, redirect: 'manual' });
  if (!callback.headers.get('set-cookie')) throw Error('Controlled login callback failed');
  const cookie = callback.headers.get('set-cookie').split(';')[0];
  const keyResult = await fixtureFetch(origin + '/api/auth/key', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'controlled-not-a-real-key' }) });
  if (!keyResult.ok) throw Error('Controlled key fixture failed: ' + keyResult.status);
  const catalog = await fixtureFetch(origin + '/api/models', { headers: { Cookie: cookie } });
  if (!catalog.ok) throw Error('Controlled catalog endpoint failed');
  const statePath = path.join(tmp, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: 'pt_session', value: cookie.slice('pt_session='.length), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'ready', origin, statePath, controlDir: tmp, runtimeDir, evidencePath: path.join(tmp, 'evidence.jsonl'), scope: 'controlled identity/model; real server/UI/storage; fixture usage only' }));
  controlTimer = setInterval(() => { if (fs.existsSync(path.join(tmp, 'shutdown'))) void shutdown(); }, 100);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
   if (line === 'status') console.log(JSON.stringify(status(tmp)));
   else if (['release A', 'release B'].includes(line)) fs.writeFileSync(path.join(tmp, 'release-' + line.at(-1)), 'release\n');
   else if (line === 'disconnect-streams') fs.writeFileSync(path.join(tmp, 'disconnect-streams'), crypto.randomUUID());
   else if (line === 'shutdown') void shutdown();
  });
 } catch (error) { console.error(error.message); await cleanup(); process.exitCode = 1; }
}
