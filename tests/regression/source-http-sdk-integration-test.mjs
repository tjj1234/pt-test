import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('source search citations and revocation traverse durable Runs, native SDK and cold history',{timeout:90000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'source-http-sdk-')),runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'key'),trace=path.join(temp,'trace'),pid=path.join(temp,'pid');
 let storage,child,logs='';
 try{
  storage=await createStorage({dataDir,masterKeyFile});const cookies=[];
  for(const suffix of ['owner','other']){
   const u=(await storage.repositories.auth.register({username:'image-'+suffix,email:suffix+'@example.test',password:'FixturePass123'})).user;
   await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',['https://accounts.google.com','image-'+suffix,u.id,u.email]);
   const token=crypto.randomBytes(32).toString('hex');await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[u.id,sha(token),new Date(Date.now()+120000).toISOString()]);cookies.push('pt_session='+token);
  }
  await storage.close();storage=null;
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const entry=path.join(temp,'sdk.mjs');fs.writeFileSync(entry,`
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(${JSON.stringify(path.join(root,'shell/package.json'))});const load=n=>import(pathToFileURL(require.resolve(n)));
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter},{default:Prompt},{default:Tools},{default:Loop},{default:Attachments}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-attachment-local'].map(load));
const ctx=new Context();for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}],[Attachments,{dshHome:process.env.DSH_HOME}]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'powertokens',model:'fixture-office'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],...(model==='fixture-office'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
 async *stream(options){const text=JSON.stringify(options.messages)+' '+JSON.stringify(options.system||'');fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({revoked:text.includes('REVOKED_SOURCE_MARKER'),beta:text.includes('RETAINED_BETA_MARKER'),citations:text.includes('UNTRUSTED_VERIFIED_SOURCE_CITATIONS'),inflight:text.includes('INFLIGHT_SOURCE_TEST')})+'\\n');if(text.includes('INFLIGHT_SOURCE_TEST'))await new Promise((resolve,reject)=>{if(options.signal?.aborted)reject(Error('cancelled'));else options.signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'SOURCE_CHAIN_OK'}};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};}
}
ctx.llm.registerAdapter(['powertokens'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-office','fixture-plain']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const models=['fixture-office','fixture-plain'].map(id=>normalizePtRecord({id,supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models.find(m=>m.id===id)?.verifications||{}})).map(model=>({...model,chat:model.tasks.textChat.value,kind:'chat',capabilityStatus:'supported',runtimeStatus:model.states.textChat.verified?'verified':'adapted_unverified'}));
value.writeScopedCache(scopeId,{scopeId,models,lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0});
return {models,scopeId,availability:{status:'available',modelIds:models.map(m=>m.id)},catalogDiagnostics:{state:'fresh',errorCode:null}};}};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(command,args,opts)=>value.spawn(command,[${JSON.stringify(entry)},...args.slice(1)],opts)};return value;};`);
  const profiles=path.join(runtime,'dsh-home/profiles');fs.mkdirSync(profiles,{recursive:true});fs.symlinkSync(path.join(root,'shell/node_modules'),path.join(profiles,'node_modules'),'dir');
  child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const req=(url,{user=0,method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const json=async(url,opts)=>{const r=await req(url,opts);assert.equal(r.status,200,await r.clone().text());return r.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready,logs);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-not-paid-key'}});
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const calls=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const upload=async(name,text)=>json('/api/upload-doc',{method:'POST',body:{name,data:Buffer.from(text).toString('base64')}});
  const original=await upload('alpha.txt','REVOKED_SOURCE_MARKER project Delta 730');
  await upload('beta.txt','RETAINED_BETA_MARKER project Echo 921');
  const records=(await json('/api/sources')).sources;assert.equal(records.length,2);
  const alpha=records.find(source=>source.sourceRef===original.url),beta=records.find(source=>source.name==='beta.txt');
  assert.equal((await json('/api/sources',{user:1})).sources.length,0);
  assert.equal((await req('/api/sources/search',{user:1,method:'POST',body:{sourceIds:[alpha.id],query:'project'}})).status,404);
  const result=await json('/api/sources/search',{method:'POST',body:{sourceIds:[alpha.id,beta.id],query:'project'}});
  assert.equal(result.returnedCount,2);assert.equal(result.results.some(hit=>Object.hasOwn(hit,'rawText')),false);
  const hit=result.results.find(hit=>hit.documentId===alpha.sourceRef);
  const citation={sourceRef:hit.documentId,sourceSha256:hit.sourceSha256,version:hit.documentVersion,blockIndex:hit.blockIndex,textSha256:hit.textSha256};
  const run=async(body)=>{const response=await req('/api/chat',{method:'POST',body:{conversationId,...body}});const text=await response.text();assert.match(text,/SOURCE_CHAIN_OK/,text+logs);const id=response.headers.get('x-agent-run-id');assert.equal((await json('/api/runs/'+id)).run.state,'completed');return id;};
  await run({message:'Use selected source',sourceCitations:[citation]});assert.equal(calls()[0].revoked,true);assert.equal(calls()[0].citations,true);
  assert.equal((await req('/api/sources/'+alpha.id,{user:1,method:'DELETE'})).status,404);
  assert.equal((await json('/api/sources/'+alpha.id,{method:'DELETE'})).deleted,true);
  assert.equal((await req(original.url)).status,404);
  assert.equal((await req('/api/sources/search',{method:'POST',body:{sourceIds:[alpha.id],query:'project'}})).status,404);
  assert.equal((await req('/api/chat',{method:'POST',body:{conversationId,message:'Old citation',sourceCitations:[citation]}})).status,409);
  assert.equal(calls().length,1);
  const oldBranch=await req('/api/chat',{method:'POST',body:{conversationId,branchFrom:0}});assert.match(await oldBranch.text(),/SOURCE_CONTEXT_EXPIRED/);assert.equal(calls().length,1);
  await run({message:'New independent question'});assert.equal(calls().at(-1).revoked,false,'deleted source must not return through native warm state or cold history');
  const history=(await json('/api/conversations/'+conversationId)).conversation;assert.equal(history.messages.length,4);assert.equal(history.source_context_start,2);
  await upload('alpha-reimport.txt','REVOKED_SOURCE_MARKER project Delta new version');
  assert.equal((await json('/api/sources')).sources.length,2);
  if(process.env.NORTHSTAR_SOURCE_BROWSER==='1'){
   const session='s'+crypto.randomBytes(4).toString('hex');const cli=(...args)=>execFileSync('playwright-cli',['-s='+session,...args],{cwd:root,env:{...process.env,TMPDIR:'/private/tmp'},encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
   const driver=fs.readFileSync(path.join(root,'tests/probes/source-browser-driver-20261102.js'),'utf8').trim();fs.mkdirSync(path.join(root,'.playwright-cli'),{recursive:true});const script=path.join(root,'.playwright-cli',session+'-driver.js');
   fs.writeFileSync(script,'async page => ('+driver+')(page,'+JSON.stringify({baseURL:'http://127.0.0.1:'+port,cookie:cookies[0].slice(11),screenshot:path.join(root,'docs/refactor/evidence/source-browser-20261102.png')})+')');
   try{cli('open');const output=cli('run-code','--filename='+script);assert.match(output,/confirm.*dialog|dialog.*confirm/);cli('dialog-accept');
    const finished=cli('--raw','run-code',"async page => { await page.waitForFunction(()=>!document.querySelector('#sourceList').textContent.includes('beta.txt')); return {status:'SOURCE_BROWSER_CHAIN_PASS'}; }");
    assert.equal(JSON.parse(finished).status,'SOURCE_BROWSER_CHAIN_PASS');cli('screenshot','--filename='+path.join(root,'docs/refactor/evidence/source-browser-20261102.png'));assert.ok(fs.existsSync(path.join(root,'docs/refactor/evidence/source-browser-20261102.png')));
   }finally{try{cli('close');}catch{}fs.rmSync(script,{force:true});}
   assert.equal((await req('/api/sources/search',{method:'POST',body:{sourceIds:[beta.id],query:'project'}})).status,404);
   await run({message:'New after browser deletion'});assert.equal(calls().at(-1).beta,false);assert.equal(calls().at(-1).revoked,false);
  }

  const current=(await json('/api/sources')).sources.find(source=>source.name==='alpha-reimport.txt');
  const activeHit=(await json('/api/sources/search',{method:'POST',body:{sourceIds:[current.id],query:'project'}})).results[0];
  const activeCitation={sourceRef:activeHit.documentId,sourceSha256:activeHit.sourceSha256,version:activeHit.documentVersion,blockIndex:activeHit.blockIndex,textSha256:activeHit.textSha256};
  const pending=await req('/api/chat',{method:'POST',body:{conversationId,message:'INFLIGHT_SOURCE_TEST',sourceCitations:[activeCitation]}});
  const pendingId=pending.headers.get('x-agent-run-id');assert.ok(pendingId);
  let started=false;for(let attempt=0;attempt<100;attempt++){if(calls().at(-1)?.inflight){started=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(started,true);
  assert.equal((await json('/api/sources/'+current.id,{method:'DELETE'})).deleted,true);
  await pending.text();assert.equal((await json('/api/runs/'+pendingId)).run.state,'cancelled');
  await run({message:'Independent after active source revocation'});assert.equal(calls().at(-1).inflight,false);assert.equal(calls().at(-1).revoked,false);

 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
