import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
for(const decision of ['approve','reject'])test('native read-only analysis exact approval: '+decision,{timeout:180000},async()=>{
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
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter},{default:Prompt},{default:Tools},{default:Loop},{default:Attachments},{default:FsLocal},{default:Subprocess},{default:Approval}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-attachment-local','@deepseek-ai/dsh-fs-local','@deepseek-ai/dsh-subprocess-local','@deepseek-ai/dsh-user-approval'].map(load));
const ctx=new Context();for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}],[Attachments,{dshHome:process.env.DSH_HOME}],[FsLocal,{}],[Subprocess],[Approval,{policy:'ask'}]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'fixture',model:'fixture-analysis'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 counts=new Map();async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text']};}
 async *stream(options){const key=/ANALYSIS_TEST_ID_([a-z]+)/.exec(JSON.stringify(options.messages))?.[1]||'api',n=(this.counts.get(key)||0)+1;this.counts.set(key,n);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({n})+'\\n');
 const name=n===1?'analysis_list':n===2?'analysis_read':'run_script',args=n===1?{}:n===2?{name:'input-1.csv'}:{language:'python',code:'print(3+4)'};if(n===4&&!JSON.stringify(options.messages).includes('ANALYSIS_FIXTURE_OK'))throw Error('Actual tool output missing');const block=n<=3?{type:'tool-call',id:'analysis-call-'+n,name,arguments:args}:{type:'text',text:'ANALYSIS_CHAIN_OK'};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
 }
}
ctx.llm.registerAdapter(['fixture'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {default:Web}=await load('@deepseek-ai/dsh-web');await ctx.plugin(Web,{searchProvider:'northstar-host',fetchProvider:'northstar-host'});const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx,{analysisArgumentsFactory:()=>({argv:[process.execPath,'-e',${JSON.stringify("require('fs').appendFileSync("+JSON.stringify(trace+'-execution')+",'1');process.stdout.write('ANALYSIS_FIXTURE_OK')")}],timeoutMs:5000,maxOutputBytes:16384})});
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./tasks/analysis-workspace.cjs')return {...value,prepareAnalysisWorkspace:options=>value.prepareAnalysisWorkspace({...options,verifyBackend:async()=>{}}).catch(error=>{console.error("ANALYSIS_PREPARE_DIAGNOSTIC",error);throw error;})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-analysis']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const normalized=normalizePtRecord({id:'fixture-analysis',supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models[0]?.verifications||{}});
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
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-analysis'}});
  const bytes=Buffer.from('name,value\none,3\ntwo,4\n'),upload=await json('/api/upload-doc',{method:'POST',body:{name:'inputs.csv',data:bytes.toString('base64')}});
  const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'ANALYSIS_TEST_ID_api Calculate the sum using Python',allowAnalysis:true,documents:[upload.url]}}),runId=response.headers.get('x-agent-run-id');assert.ok(runId);
  let card;for(let n=0;n<200;n++){card=(await json('/api/runs/'+runId+'/approvals')).approvals[0];if(card)break;await new Promise(r=>setTimeout(r,20));}if(!card){const wire=await response.text();throw Error('NO_APPROVAL_CARD '+logs+wire+' TRACE '+(fs.existsSync(trace)?fs.readFileSync(trace,'utf8'):'none')+' EVENTS '+JSON.stringify((await json('/api/runs/'+runId+'/events')).events));}assert.equal(card.approvalState,'pending');assert.match(card.detail,/print\(3\+4\)/);assert.equal(fs.existsSync(trace+'-execution'),false);
  assert.equal((await req('/api/runs/'+runId+'/approvals',{user:1})).status,404);
  assert.equal((await req('/api/runs/'+runId+'/approvals/'+card.id+'/answer',{method:'POST',body:{callId:card.callId,payloadSha256:'0'.repeat(64),decision:'approve'}})).status,409);
  await json('/api/runs/'+runId+'/approvals/'+card.id+'/answer',{method:'POST',body:{callId:card.callId,payloadSha256:card.payloadSha256,decision}});
  if(decision==='reject'){const rejected=await response.text();assert.equal(fs.existsSync(trace+'-execution'),false,rejected);assert.equal((await json('/api/runs/'+runId+'/approvals')).approvals[0].approvalState,'rejected');return;}
  const wire=await response.text();assert.match(wire,/ANALYSIS_CHAIN_OK/,wire+logs);assert.equal((await json('/api/runs/'+runId)).run.state,'completed');assert.equal((await json('/api/runs/'+runId+'/approvals')).approvals[0].approvalState,'consumed');
  assert.equal(fs.readFileSync(trace+'-execution','utf8'),'1');assert.equal((await req('/api/runs/'+runId+'/approvals/'+card.id+'/answer',{method:'POST',body:{callId:card.callId,payloadSha256:card.payloadSha256,decision:'approve'}})).status,409);
  const events=(await json('/api/runs/'+runId+'/events')).events;assert.equal(events.filter(e=>e.payload?.action==='model_request_intent').length,4);assert.equal(events.filter(e=>e.payload?.action==='user_approval').length,3);
  const history=(await json('/api/conversations/'+conversationId)).conversation.messages;assert.ok(history.some(m=>m.role==='assistant'&&m.text==='ANALYSIS_CHAIN_OK'));

 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
