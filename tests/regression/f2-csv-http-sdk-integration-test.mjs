/** Offline HTTP integration: real tenant, adapter, managed profile, locked SDK and CSV host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn,execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputFormat=process.env.NORTHSTAR_CSV_OUTPUT_FORMAT==='xlsx'?'xlsx':'csv';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sdkHarness = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(ROOT, 'shell/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter, CallId }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'
].map(load));
const ctx = new Context();
for (const [plugin, config] of [[Agents], [Sessions], [Llm], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) await ctx.plugin(plugin, ...(config === undefined ? [] : [config]));
ctx.provide('loader', { await: async () => {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'f2-fixture', model: 'fixture-chat' }) });
ctx.provide('appExit', code => process.exit(code));
class FixtureAdapter extends LlmAdapter {
  counts = new Map();
  async *stream(options) {
    const sid = String(options.sessionId);
    const n = (this.counts.get(sid) || 0) + 1; this.counts.set(sid, n);
    const block = n === 1
      ? { type: 'tool-call', id: CallId('call-' + sid), name: 'csv_analyze', arguments: JSON.parse(SELECTOR) }
      : { type: 'text', text: 'CSV sum completed' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  }
}
ctx.llm.registerAdapter(['f2-fixture'], new FixtureAdapter());
const { apply } = await import(pathToFileURL(path.join(path.join(process.env.DSH_HOME, 'profiles/run-persistent'), 'persistent-runner.mjs')));
apply(ctx);
`;

test('offline HTTP '+outputFormat+' Run traverses tenant/adapter/SDK, downloads and reopens its artifact', { timeout: 90000 }, async () => {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'f2-http-sdk-'));
  const runtime = path.join(temp, 'runtime'), dbDir = path.join(temp, 'db'), keyFile = path.join(temp, 'key');
  const selectorFile = path.join(temp, 'selector.json'), pidFile = path.join(temp, 'runner.pid');
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile: keyFile });
    const cookies = [], tenants = [];
    for (let i = 0; i < 2; i++) {
      const result = await storage.repositories.auth.register({ username: 'f2-sdk-' + i, email: `f2-sdk-${i}@example.test`, password: 'FixtureReview123' });
      assert.equal(result.ok, true);
      const user = result.user; tenants.push(user.tenant_id);
      await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)', ['https://accounts.google.com', 'f2-sdk-' + i, user.id, user.email]);
      const token = crypto.randomBytes(32).toString('hex');
      await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, sha(token), new Date(Date.now() + 120000).toISOString()]);
      cookies.push('pt_session=' + token);
    }
    await storage.close(); storage = null;
    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const entry = path.join(temp, 'fixture-sdk.mjs');
    fs.writeFileSync(entry, `import fs from 'node:fs';
const ROOT=${JSON.stringify(root)};
const SELECTOR=fs.readFileSync(${JSON.stringify(selectorFile)},'utf8');
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
` + sdkHarness);
    const preload = path.join(temp, 'fixture.cjs');
    // Only the catalog and child launcher are fixtures. The launcher preserves
    // adapter args/options and executes its freshly generated profile runner.
    fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;
Module._load=function(name,parent,isMain){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>["fixture-chat"]};

if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async()=>({models:[{id:'fixture-chat',availability:'present',permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-chat']},syncedAt:Date.now()})};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(cmd,args,opts)=>{if(cmd!==process.execPath||args[1]!=='--profile')throw Error('Unexpected fixture launcher');return value.spawn(cmd,[${JSON.stringify(entry)},...args.slice(1)],opts);}};
return value;};`);
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], { cwd: root,
      env: { PATH: process.env.PATH, HOME: temp, PT_RUNTIME_DIR: runtime, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: keyFile,
        PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const origin = 'http://127.0.0.1:' + port;
    const req = (route, { user = 0, method = 'GET', body } = {}) => fetch(origin + route, { method, headers: {
      ...(user === null ? {} : { Cookie: cookies[user] }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    const json = async (route, opts) => { const response = await req(route, opts); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await req('/api/auth/me')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output);
    await json('/api/auth/key', { method: 'POST', body: { key: 'fixture-no-paid-key' } });
    const bytes = Buffer.from('amount\n0\n2\n2\n');
    const uploaded = await json('/api/upload-doc', { method: 'POST', body: { name: 'sample.csv', data: bytes.toString('base64') } });
    const selection = { sourceRef: uploaded.url, sourceSha256: sha(bytes), headerRow: 1, startRow: 2, column: 1 };
    const preview = await json('/api/csv/selection-preview', { method: 'POST', body: { sourceRef: selection.sourceRef, headerRow: 1, startRow: 2, column: 1 } });
    assert.equal(preview.preview.type, 'decimal'); assert.equal(preview.preview.sourceSha256, sha(bytes));
    fs.writeFileSync(selectorFile, JSON.stringify({ sourceRef: uploaded.url, sourceSha256: sha(bytes), operation: 'sum', column: 1, startRow: 2, outputFormat }));
    const profiles = path.join(runtime, 'dsh-home/profiles');
    fs.mkdirSync(profiles, { recursive: true });
    fs.symlinkSync(path.join(root, 'shell/node_modules'), path.join(profiles, 'node_modules'), 'dir');
    const conversationId = (await json('/api/conversations', { method: 'POST' })).id;
    const chat = await req('/api/chat', { method: 'POST', body: { conversationId, message: 'Sum selected CSV column', documents: [uploaded.url], csvSelections: [selection] } });
    assert.equal(chat.status, 200);
    const frames = await chat.text();
    assert.match(frames, /"done":true/); assert.match(frames, /CSV sum completed/, frames + output + fs.readdirSync(path.join(runtime, '_tmp')).filter(f => f.endsWith('.err')).map(f => fs.readFileSync(path.join(runtime, '_tmp', f), 'utf8')).join('\n'));
    const runId = chat.headers.get('x-agent-run-id'); assert.ok(runId);
    assert.equal((await json('/api/runs/' + runId)).run.state, 'completed');
    const events = (await json('/api/runs/' + runId + '/events')).events;
    const budget = events.find(e => e.type === 'usage' && e.payload?.kind === 'run_budget');
    assert.ok(budget, JSON.stringify(events));
    assert.equal(budget.payload.limits.maxModelCalls, 2);
    assert.equal(budget.payload.limits.maxToolCalls, 1);
    assert.equal(budget.payload.snapshot.modelCalls, 2); assert.equal(budget.payload.snapshot.toolCalls, 1);
    assert.equal(events.filter(e => e.payload?.action === 'model_request_intent').length, 2);
    const artifactEvent = events.find(e => e.type === 'artifact'); assert.ok(artifactEvent);
    const artifact = artifactEvent.payload.artifact;
    assert.ok(artifact.rel.startsWith((outputFormat==='xlsx'?'spreadsheet-results/':'csv-results/') + runId + '/'));
    const url = '/api/artifact?p=' + encodeURIComponent(artifact.rel);
    const download = await req(url); assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    const downloaded=Buffer.from(await download.arrayBuffer());
    if(outputFormat==='csv'){
      assert.match(download.headers.get('content-type'), /^text\/csv/);
      const rows=require('../../shell/attachments/csv-parser.cjs').parseCsv(downloaded.toString('utf8')).rows;
      assert.deepEqual(rows[1].map(cell=>cell.value),['summary',sha(bytes),'sum','1','2','4','','','3']);
    }else{
      assert.match(download.headers.get('content-type'),/spreadsheetml.sheet/);
      const parsed=await require('../../shell/attachments/office-document-parser.cjs').parseOfficeDocument({bytes:downloaded,format:'xlsx'});
      assert.deepEqual(['A','B','C','D','E','F','G','H','I'].map(column=>parsed.blocks.find(block=>block.locator.cell===column+'2')?.text??''),['summary',sha(bytes),'sum','1','2','4','','','3']);
      assert.ok(parsed.blocks.every(block=>block.locator.formula===false));
    }
    assert.equal(sha(downloaded),artifact.sha256);
    assert.equal((await req(url, { user: null })).status, 401);
    assert.equal((await req(url, { user: 1 })).status, 404);
    const history = (await json('/api/conversations/' + conversationId)).conversation.messages;
    const assistant = history.find(m => m.role === 'assistant');
    assert.equal(assistant.runId, runId);
    assert.ok(assistant.artifacts.some(a => a.rel === artifact.rel));
    assert.equal(assistant.artifacts.find(a=>a.rel===artifact.rel).sha256,artifact.sha256);
    assert.deepEqual(history[0].csvSelections, [selection]);
    const historyDownload = await req(assistant.artifacts.find(a => a.rel === artifact.rel).url);
    assert.equal(historyDownload.status, 200);
    assert.deepEqual(Buffer.from(await historyDownload.arrayBuffer()),downloaded);
    const reopened = (await json('/api/runs/' + runId + '/events')).events;
    assert.ok(reopened.some(e => e.type === 'artifact' && e.payload.artifact.rel === artifact.rel));
    if(outputFormat==='xlsx'&&process.env.NORTHSTAR_XLSX_BROWSER==='1'){
      const session='x'+crypto.randomBytes(4).toString('hex');
      const cli=(...args)=>execFileSync('playwright-cli',['-s='+session,...args],{cwd:root,env:{...process.env,TMPDIR:'/private/tmp'},encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
      const driver=fs.readFileSync(path.join(root,'tests/probes/xlsx-browser-driver-20261102.js'),'utf8').trim();
      fs.mkdirSync(path.join(root,'.playwright-cli'),{recursive:true});const script=path.join(root,'.playwright-cli',session+'-driver.js');
      fs.writeFileSync(script,'async page => ('+driver+')(page,'+JSON.stringify({baseURL:origin,cookie:cookies[0].slice(11),screenshot:path.join(root,'docs/refactor/evidence/xlsx-browser-20261102.png')})+')');
      try{cli('open');const result=cli('run-code','--filename='+script);assert.match(result,/XLSX_BROWSER_CHAIN_PASS/,result);}
      finally{try{cli('close');}catch{}fs.rmSync(script,{force:true});}
    }

  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
