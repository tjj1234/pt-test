/**
 * T08 no-paid-call integration probe. Exercises the real Shell Server upload,
 * durable attachment, task worker and imageNote. A preload replaces only
 * tenant.runDshForUser with a local capture that formats the task through the
 * production assembleSystemPrompt contract. The separate fake-provider probe
 * covers runner text-block projection; this probe makes no provider call.
 * Synthetic PNG bytes are only upload-path fixtures, not decoded image pixels.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZ8AAAAASUVORK5CYII=', 'base64');

let temp, stage, markerPath, storage, child, listener;
const tenants = [], cookies = [];
let output = '';
const finish = async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const exited = await waitForChildClose(child, 8000).catch(() => false);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      if (!(await waitForChildClose(child, 3000).catch(() => false))) throw new Error('server process exit was not confirmed; preserving owned staging');
    }
  }
  if (listener) await new Promise(resolve => listener.close(resolve));
  if (storage) await storage.close();
  if (temp && fs.existsSync(temp)) {
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'northstar-t08-upload-probe-owned-v1\n', 'refusing cleanup without owned temp marker');
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (temp) console.log(`CLEANUP ${fs.existsSync(temp) ? 'FAIL' : 'PASS'} removed owned staging after server exit`);
};

function waitForChildClose(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.off('close', onClose); reject(new Error('child close timeout')); }, timeoutMs);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    proc.once('close', onClose);
    if (proc.exitCode !== null || proc.signalCode !== null) onClose();
  });
}

try {
  temp = fs.mkdtempSync('/private/tmp/northstar-t08-upload-http-');
  markerPath = path.join(temp, 'ownership.marker');
  fs.writeFileSync(markerPath, 'northstar-t08-upload-probe-owned-v1\n', { flag: 'wx' });
  stage = path.join(temp, 'checkout');
  fs.mkdirSync(stage);
  const ignoredNames = new Set(['node_modules', '.git', '.cache', 'coverage']);
  const mutable = new Set(['shell/runtime/dsh-home','shell/runtime/workspace','shell/runtime/workspaces','shell/runtime/_tmp','shell/runtime/_uploads','shell/runtime/logs']);
  const filteredSensitivePaths = new Set();
  let dependencyLinkCount = 0;
  const dependencyLinkRoots = new Set();
  const sourceReal = fs.realpathSync(sourceRoot);
  const isWithin = (rootPath, candidate) => candidate === rootPath || candidate.startsWith(rootPath + path.sep);
  const isSensitive = (relative) => {
    const parts = relative.split('/');
    const base = parts.at(-1).toLowerCase();
    if (parts.some(part => /^\.env(?:$|\.)/i.test(part) || ['.npmrc','.netrc','.pypirc','.ssh','.aws'].includes(part.toLowerCase()))) return true;
    if (parts.some(part => /^(?:logs?|credentials|secrets?)$/i.test(part))) return true;
    if (parts.some(part => /^(?:db|database)$/i.test(part)) && parts.some(part => /^(?:runtime|data|var)$/i.test(part))) return true;
    return /\.(?:sqlite3?|db|log(?:\.\d+)*(?:\.gz)?|pem|key|p12|pfx|sql\.gz)$/i.test(base)
      || /^(?:credentials|secrets?)(?:\.|$)/i.test(base)
      || /(?:^|[_-])service[_-]account(?:[_-].*)?\.json$/i.test(base)
      || /^(?:access[_-])?token\.json$/i.test(base)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/i.test(base)
      || /(?:^|[._-])private[._-]?key(?:$|[._-])/i.test(base)
      || /^(?:(?:backup|db|database|dump)[._-]?(?:\d{8}|\d{4}[-_]\d{2}[-_]\d{2})|(?:\d{8}|\d{4}[-_]\d{2}[-_]\d{2})[._-](?:backup|db|database|dump))(?:[._-].*)?\.(?:sql|dump|backup|bak|json)$/i.test(base);
  };
  for (const sample of ['.env.local','.npmrc','service-account-prod.json','google_service_account_key.json','service_account.json','token.json','access_token.json','id_rsa','id_dsa','id_ecdsa','id_ed25519.pub','private_key','app.log.1','app.log.2.gz','snapshot.sql.gz','backup-20261020.sql','backup-2026-10-20.sql','20261020-db.backup','runtime/db/state.json']) assert.equal(isSensitive(sample),true,`sensitive path should be excluded: ${sample}`);
  for (const sample of ['token.js','analytics/backend/db/001_init.sql','shell/tasks/chat-request.cjs','runtime/example.txt']) assert.equal(isSensitive(sample),false,`ordinary source should remain copyable: ${sample}`);
  function assertTrustedDependency(source, trustedRoot) {
    const rootReal = fs.realpathSync(trustedRoot);
    const sourceRealPath = fs.realpathSync(source);
    assert.ok(isWithin(sourceReal, sourceRealPath), `dependency escaped checkout root: ${source}`);
    assert.ok(isWithin(rootReal, sourceRealPath), `dependency escaped its node_modules tree: ${source}`);
    assert.ok(fs.statSync(sourceRealPath).isDirectory(), `dependency is not a directory: ${source}`);
    return sourceRealPath;
  }
  function linkTrustedDependency(source, target, trustedRoot) {
    const stat = fs.lstatSync(source);
    assert.ok(stat.isDirectory() || stat.isSymbolicLink(), `dependency entry is not a directory/link: ${source}`);
    const sourceRealPath = assertTrustedDependency(source, trustedRoot);
    fs.symlinkSync(sourceRealPath, target, 'dir');
    assert.equal(fs.realpathSync(target), sourceRealPath, `staged dependency link changed target: ${target}`);
    dependencyLinkCount++;
    dependencyLinkRoots.add(path.relative(sourceRoot, trustedRoot).split(path.sep).join('/'));
  }
  function copyTree(relativeRoot) {
    const from = path.join(sourceRoot, relativeRoot), to = path.join(stage, relativeRoot);
    function walk(src, dst, rel) {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const source = path.join(src, entry.name), target = path.join(dst, entry.name), relative = path.posix.join(rel, entry.name);
        if (isSensitive(relative)) { filteredSensitivePaths.add(relative); continue; }
        if (ignoredNames.has(entry.name) || mutable.has(relative)) continue;
        const stat = fs.lstatSync(source);
        assert.ok(!stat.isSymbolicLink(), `refusing staging symlink: ${relative}`);
        if (stat.isDirectory()) { fs.mkdirSync(target, { recursive: true }); walk(source, target, relative); }
        else if (stat.isFile()) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
      }
    }
    fs.mkdirSync(to, { recursive: true }); walk(from, to, relativeRoot);
  }
  for (const relative of ['shell','business','analytics']) copyTree(relative);
  assert.ok(filteredSensitivePaths.has('shell/.npmrc'), 'current source tree .npmrc must be excluded from staging');
  fs.mkdirSync(path.join(stage,'shell/node_modules'),{recursive:true});
  const shellModules = path.join(sourceRoot,'shell/node_modules');
  const shellModulesReal = fs.realpathSync(shellModules);
  for (const entry of fs.readdirSync(shellModules,{withFileTypes:true})) {
    const source=path.join(sourceRoot,'shell/node_modules',entry.name), target=path.join(stage,'shell/node_modules',entry.name);
    if(entry.name==='@deepseek-ai'&&entry.isDirectory()){
      assertTrustedDependency(source, shellModulesReal);
      fs.mkdirSync(target,{recursive:true});
      for(const pkg of fs.readdirSync(source,{withFileTypes:true})){
        const from=path.join(source,pkg.name),to=path.join(target,pkg.name);
        if(pkg.name==='dsh'&&pkg.isDirectory()) { assertTrustedDependency(from, shellModulesReal); copyTree('shell/node_modules/@deepseek-ai/dsh'); }
        else linkTrustedDependency(from,to,shellModulesReal);
      }
    } else if(entry.isDirectory() || entry.isSymbolicLink()) linkTrustedDependency(source,target,shellModulesReal);
  }
  for (const relative of ['business/attribution/node_modules','analytics/node_modules']) {
    const from = path.join(sourceRoot,relative), to = path.join(stage,relative);
    assertTrustedDependency(from, path.dirname(from));
    fs.mkdirSync(path.dirname(to),{recursive:true}); linkTrustedDependency(from,to,path.dirname(from));
  }
  root = stage;
  const dbDir = path.join(temp, 'db'), masterKeyFile = path.join(temp, 'key');
  const captureFile = path.join(temp, 'image-notes.jsonl');
  storage = await createStorage({ dataDir: dbDir, masterKeyFile });
  for (let i = 0; i < 4; i++) {
    const registered = await storage.repositories.auth.register({ username: `t08-http-${i}`, email: `t08-http-${i}@example.test`, password: 'FixtureReview123' });
    assert.equal(registered.ok, true);
    const user = registered.user; tenants.push(user.tenant_id);
    const token = crypto.randomBytes(32).toString('hex');
    await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, sha(token), new Date(Date.now() + 120000).toISOString()]);
    cookies.push('pt_session=' + token);
  }
  await storage.close(); storage = null;

  const portProbe = createNetServer();
  await new Promise((resolve, reject) => portProbe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;

  const preload = path.join(temp, 'fixtures.cjs');
  const legacyConversationFile = path.join(temp, 'legacy-conversation-id');
  fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),load=Module._load;
Module._load=function(name,parent){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>({models:[{id:'fixture-text',availability:'present',permission:true,localPolicy:{enabled:true},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,verified:true,autoEligible:true}}}],availability:{status:'available',modelIds:['fixture-text']},syncedAt:Date.now()})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./conversations.cjs')return {...loaded,initConversations:async(...args)=>{const conv=await loaded.initConversations(...args);return {...conv,get:async(userId,id)=>{const value=await conv.get(userId,id);let legacyId='';try{legacyId=fs.readFileSync(${JSON.stringify(legacyConversationFile)},'utf8')}catch{}if(value&&id===legacyId)value.messages=value.messages.map(({imageEvidence,...message})=>message);return value}}}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(uid,q,opts)=>{const {assembleSystemPrompt}=require(path.join(${JSON.stringify(root)},'shell/runtime/contract.cjs'));const task=assembleSystemPrompt({...opts,question:q});fs.appendFileSync(${JSON.stringify(captureFile)},JSON.stringify({uid,question:q,tenantId:opts.tenantId,imageNote:opts.imageNote,task})+'\\n');return {ok:true,text:'fixture response',steps:[]};}};
return loaded;};`);
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), DSH_HOME: path.join(temp, 'dsh-home'), TMPDIR: path.join(temp, 'tmp'), TEMP: path.join(temp, 'tmp'), TMP: path.join(temp, 'tmp'), LANG: 'C', PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(temp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_KEY_LIVE_VERIFY: '0', PT_TASK_POLL_MS: '10', PT_HEARTBEAT_ENABLED: '0' };
  for (const dir of [env.HOME, env.DSH_HOME, env.TMPDIR, env.PT_LOG_DIR]) fs.mkdirSync(dir, { recursive: true });
  let spawnError = null;
  child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const req = (route, user, method='GET', body) => fetch(origin + route, { method, headers: { Cookie: cookies[user], ...(body ? { 'Content-Type':'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let ready = false;
  for (let i = 0; i < 200; i++) { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error(output); try { if ((await req('/api/auth/me', 0)).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.equal(ready, true, output.slice(-2500));
  for (let i=0;i<4;i++) { const key=await req('/api/auth/key',i,'POST',{key:'fixture-no-paid-provider-key'}); assert.equal(key.status,200,await key.text()); }
  const json = async (route,user,method='GET',body) => { const res=await req(route,user,method,body); assert.equal(res.status,200,await res.clone().text()); return res.json(); };
  const conversations = await Promise.all([0,1,2,3].map(user=>json('/api/conversations',user,'POST')));
  const upload = async (user, bytes) => json('/api/upload',user,'POST',{image:'data:image/png;base64,'+bytes.toString('base64')});
  const uploaded = await upload(0,png);
  assert.match(uploaded.url,new RegExp('^/uploads/'+tenants[0]+'/'));
  const sendChat = async (user,taskType,url,message) => req('/api/chat',user,'POST',{conversationId:conversations[user].id,message,image:url,...(taskType?{taskType}:{})});
  const readTasks = () => fs.existsSync(captureFile) ? fs.readFileSync(captureFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  let response=await sendChat(0,null,uploaded.url,'branch-auto-image'); assert.equal(response.status,200); const autoFrames=await response.text(); assert.match(autoFrames,/"done":true/); assert.match(autoFrames,/"ok":true/,autoFrames.slice(-1200));
  let frame=readTasks().find(x=>x.question==='branch-auto-image');
  assert.ok(frame,'durable worker reached the local tenant capture');
  const savedConversation = await json(`/api/conversations/${conversations[0].id}`,0);
  const savedImageMessage = savedConversation.conversation.messages.find(m=>m.role==='user');
  assert.deepEqual(savedImageMessage.imageEvidence,{ref:uploaded.url,sha256:sha(png),size:png.length},'new image message persists tenant-local digest/size evidence');
  assert.ok(frame.imageNote.includes('data:image/png;base64,'+png.toString('base64')),'auto branch injects uploaded bytes into imageNote as text data URL');
  assert.ok(frame.task.includes('data:image/png;base64,'+png.toString('base64')),'production prompt contract carries imageNote as task text');
  const uploadedTextBranch=await upload(1,png);
  response=await sendChat(1,'text2image',uploadedTextBranch.url,'branch-text2image'); assert.equal(response.status,200); await response.text();
  frame=readTasks().find(x=>x.question==='branch-text2image');
  assert.ok(frame); assert.equal(frame.imageNote.includes(png.toString('base64')),false,'explicit text2image branch does not leak uploaded bytes');
  assert.equal(frame.task.includes(png.toString('base64')),false);

  const big=Buffer.concat([png,Buffer.alloc(10*1024*1024+1-png.length,0x61)]);
  const bigUpload=await upload(2,big);
  response=await sendChat(2,'image2image',bigUpload.url,'branch-over-limit'); assert.equal(response.status,200); const overLimitFrames=await response.text(); assert.match(overLimitFrames,/"done":true/); assert.match(overLimitFrames,/"ok":true/,overLimitFrames.slice(-1200));
  frame=readTasks().find(x=>x.question==='branch-over-limit');
  assert.ok(frame,`over-limit branch did not reach local tenant capture; ${overLimitFrames.slice(-1200)}`); assert.equal(frame.imageNote.includes('data:image/png;base64,'),false,'over-10-MiB branch carries fallback text, not partial bytes');

  const beforeBad=readTasks().length;
  const invalid=await req('/api/upload',0,'POST',{image:Buffer.from('not an image').toString('base64')});
  assert.equal(invalid.status,400); assert.equal(readTasks().length,beforeBad,'bad upload reaches no tenant capture');
  response=await sendChat(3,null,uploaded.url,'cross-tenant-image'); assert.equal(response.status,400); await response.text();
  assert.equal(readTasks().some(x=>x.question==='cross-tenant-image'),false,'cross-tenant ref reaches no tenant capture');

  const imageConversationId=conversations[0].id;
  const unchangedCount=readTasks().length;
  response=await req('/api/chat',0,'POST',{conversationId:imageConversationId,regenerate:true}); assert.equal(response.status,200); const unchanged=await response.text();
  assert.match(unchanged,/"done":true/); assert.match(unchanged,/"ok":true/,unchanged.slice(-1200));
  assert.equal(readTasks().length,unchangedCount+1,'unchanged historical image regenerates through the fixture once');
  const afterRegenerate=await json(`/api/conversations/${imageConversationId}`,0);
  const firstAssistant=afterRegenerate.conversation.messages.find(m=>m.role==='assistant');
  assert.ok(firstAssistant?.ts,'first assistant timestamp is available for branch replay');
  const beforeBranch=readTasks().length;
  response=await req('/api/chat',0,'POST',{conversationId:imageConversationId,branchFrom:firstAssistant.ts}); assert.equal(response.status,200); const branchFrames=await response.text();
  assert.match(branchFrames,/"done":true/); assert.match(branchFrames,/"ok":true/,branchFrames.slice(-1200));
  assert.equal(readTasks().length,beforeBranch+1,'unchanged historical image branches through the fixture once');

  const legacyConversation=await json('/api/conversations',0,'POST');
  const legacyUpload=await upload(0,png);
  response=await req('/api/chat',0,'POST',{conversationId:legacyConversation.id,message:'legacy-image-history',image:legacyUpload.url}); assert.equal(response.status,200); const legacyInitial=await response.text();
  assert.match(legacyInitial,/"ok":true/,legacyInitial.slice(-1200));
  fs.writeFileSync(legacyConversationFile,legacyConversation.id);
  const beforeLegacy=readTasks().length;
  response=await req('/api/chat',0,'POST',{conversationId:legacyConversation.id,regenerate:true}); assert.equal(response.status,200); const legacyRegen=await response.text();
  assert.match(legacyRegen,/"ok":false/); assert.match(legacyRegen,/CHAT_ATTACHMENT_EVIDENCE_MISSING/);
  assert.equal(readTasks().length,beforeLegacy,'legacy image history without evidence is rejected before fixture capture');
  const legacyAssistant=(await json(`/api/conversations/${legacyConversation.id}`,0)).conversation.messages.find(m=>m.role==='assistant');
  response=await req('/api/chat',0,'POST',{conversationId:legacyConversation.id,branchFrom:legacyAssistant.ts}); assert.equal(response.status,200); const legacyBranch=await response.text();
  assert.match(legacyBranch,/"ok":false/); assert.match(legacyBranch,/CHAT_ATTACHMENT_EVIDENCE_MISSING/);
  assert.equal(readTasks().length,beforeLegacy,'legacy image branch without evidence is rejected before fixture capture');
  fs.rmSync(legacyConversationFile,{force:true});

  const uploadedPath=path.join(root,'runtime/_uploads',tenants[0],path.basename(uploaded.url));
  fs.writeFileSync(uploadedPath,Buffer.from('replacement bytes'));
  const beforeChangedMessages=(await json(`/api/conversations/${imageConversationId}`,0)).conversation.messages;
  const beforeChanged=readTasks().length;
  response=await req('/api/chat',0,'POST',{conversationId:imageConversationId,regenerate:true}); assert.equal(response.status,200); const changed=await response.text();
  assert.match(changed,/"ok":false/); assert.match(changed,/CHAT_ATTACHMENT_CHANGED/);
  assert.equal(readTasks().length,beforeChanged,'changed image is rejected before tenant/model fixture capture');
  assert.deepEqual((await json(`/api/conversations/${imageConversationId}`,0)).conversation.messages,beforeChangedMessages,'failed changed-image regenerate leaves durable history unchanged');
  const beforeChangedBranch=readTasks().length;
  const currentAssistant=(await json(`/api/conversations/${imageConversationId}`,0)).conversation.messages.find(m=>m.role==='assistant');
  response=await req('/api/chat',0,'POST',{conversationId:imageConversationId,branchFrom:currentAssistant.ts}); assert.equal(response.status,200); const changedBranch=await response.text();
  assert.match(changedBranch,/"ok":false/); assert.match(changedBranch,/CHAT_ATTACHMENT_CHANGED/);
  assert.equal(readTasks().length,beforeChangedBranch,'changed image branch is rejected before tenant/model fixture capture');
  assert.deepEqual((await json(`/api/conversations/${imageConversationId}`,0)).conversation.messages,beforeChangedMessages,'failed changed-image branch leaves durable history unchanged');

  console.log(JSON.stringify({status:'PASS',networkAccess:'loopback HTTP only; no socket-level egress monitoring',serverUploadAndDurableVerification:true,stagingExclusions:{method:'best-effort path/name patterns; file contents are not scanned',sensitivePaths:[...filteredSensitivePaths].sort(),dependencyLinkCount,dependencyLinkRoots:[...dependencyLinkRoots].sort()},productionImageNotesCaptured:readTasks().length,assertions:{autoDataUrlAsText:true,text2imageNoDataUrl:true,over10MiBFallbackNoBytes:true,invalidUploadRejected:true,crossTenantNoCapture:true,imageEvidencePersisted:true,unchangedRegenerate:true,unchangedBranch:true,legacyEvidenceMissingRegenerateRejected:true,legacyEvidenceMissingBranchRejected:true,changedRegenerateRejectedBeforeFixture:true,changedBranchRejectedBeforeFixture:true,changedRegenerateHistoryUnchanged:true,changedBranchHistoryUnchanged:true},boundary:'real HTTP upload, durable worker verification and server imageNote are exercised; tenant DSH is an in-process fixture, with no real provider; production assembleSystemPrompt formats the captured note; runner projection is separately covered by northstar-t08-persistent-runner-fake-provider.mjs; no image decoding or visual understanding is tested'},null,2));
} finally {
  await finish();
}
