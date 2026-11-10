import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('official billing native tool uses distinct owned credential and preserves unknown Run correlation',{timeout:180000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'office-http-sdk-')),runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'key'),trace=path.join(temp,'trace'),pid=path.join(temp,'pid');
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
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'fixture',model:'fixture-billing'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 counts=new Map();async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text']};}
 async *stream(options){const key=String(options.sessionId),n=(this.counts.get(key)||0)+1;this.counts.set(key,n);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({n})+'\\n');
 const block=n===1?{type:'tool-call',id:'billing-query-1',name:'billing_query',arguments:{kind:'usage'}}:{type:'text',text:'BILLING_CHAIN_OK'};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
 }
}
ctx.llm.registerAdapter(['fixture'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {default:Web}=await load('@deepseek-ai/dsh-web');await ctx.plugin(Web,{searchProvider:'northstar-host',fetchProvider:'northstar-host'});const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./web/host-service.cjs')return {...value,createWebHostService:options=>value.createWebHostService({...options,getPolicy:()=>({trustedDomains:['safe.example','duckduckgo.com'],provider:'fixture',revision:'fixture-v1',maxBytes:131072,timeoutMs:1000}),transportFactory:()=>async url=>({statusCode:200,url,byteLength:15,content:url.includes('duckduckgo.com')?'<a class="result__a" href="https://safe.example/page">Official fixture source</a>':'VERIFIED_WEB_BODY'})})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./usage/billing-account-service.cjs')return {...value,createBillingAccountService:options=>value.createBillingAccountService({...options,clientFactory:config=>require(${JSON.stringify(path.join(root,'shell/candidates/billing-20261103/index.cjs'))}).createBillingClient({...config,httpTransport:async()=>({status:200,data:{code:200,data:{currency:'credits',key_id:'key****1234',data_as_of:'2026-11-10T01:00:00Z',period_start:'2026-11-01',period_end:'2026-11-10',total_cost:17,items:[{model:'glm-4.7',model_type:'text',total_cost:17}]}}})})})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-billing']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const normalized=normalizePtRecord({id:'fixture-billing',supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models[0]?.verifications||{}});
const m={...normalized,chat:normalized.tasks.textChat.value,kind:'chat',capabilityStatus:'supported',runtimeStatus:normalized.states.textChat.verified?'verified':'adapted_unverified'};
value.writeScopedCache(scopeId,{scopeId,models:[m],lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0});
return {models:[m],scopeId,availability:{status:'available',modelIds:[m.id]},catalogDiagnostics:{state:'fresh',errorCode:null}};}};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(command,args,opts)=>value.spawn(command,[${JSON.stringify(entry)},...args.slice(1)],opts)};return value;};`);
  const profiles=path.join(runtime,'dsh-home/profiles');fs.mkdirSync(profiles,{recursive:true});fs.symlinkSync(path.join(root,'shell/node_modules'),path.join(profiles,'node_modules'),'dir');
  child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const req=(url,{user=0,method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const json=async(url,opts)=>{const r=await req(url,opts);assert.equal(r.status,200,await r.clone().text());return r.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready,logs);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-not-paid-key'}});
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-billing'}});
  assert.equal((await json('/api/billing/login-token')).configured,false);
  const saved=await json('/api/billing/login-token',{method:'POST',body:{token:'owner-login-fixture'}});assert.equal(saved.configured,true);assert.ok(!JSON.stringify(saved).includes('owner-login-fixture'));
  assert.equal((await json('/api/billing/login-token',{user:1})).configured,false);assert.equal((await req('/api/billing/account?kind=usage',{user:1})).status,409);
  const account=await json('/api/billing/account?kind=usage');assert.equal(account.totalQuota,17);assert.equal(account.runCorrelation,'unknown');
  const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Query my official billing summary',allowBilling:true}}),text=await response.text();assert.match(text,/BILLING_CHAIN_OK/,text+logs);
  const runId=response.headers.get('x-agent-run-id');assert.ok(runId);assert.equal((await json('/api/runs/'+runId)).run.state,'completed');
  const events=(await json('/api/runs/'+runId+'/events')).events;assert.equal(events.filter(e=>e.payload?.action==='model_request_intent').length,2);
  assert.equal((await json('/api/billing/login-token',{method:'DELETE'})).configured,false);assert.equal((await json('/api/auth/key')).key.key_last4,'-key');
  const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);

 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
