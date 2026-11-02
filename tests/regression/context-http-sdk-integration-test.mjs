import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('native Context automatic and manual compaction persist and resume across Shell restart',{timeout:90000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reasoning-http-sdk-')),runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'key'),trace=path.join(temp,'trace'),pid=path.join(temp,'pid');
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
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter,LlmError},{default:Prompt},{default:Tools},{default:Loop},{default:Attachments}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-attachment-local'].map(load));
const [{default:Persistence},{default:TokenMeter},{default:Compaction}]=await Promise.all(['@deepseek-ai/dsh-session-persistence-jsonl','@deepseek-ai/dsh-token-meter','@deepseek-ai/dsh-compaction-basic'].map(load));
const ctx=new Context();for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Persistence,{root:path.join(process.env.DSH_HOME,'sessions')}],[TokenMeter,{}],[Compaction,{maxTokens:128,compactionRetries:0}],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}],[Attachments,{dshHome:process.env.DSH_HOME}]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'powertokens',model:'fixture-office'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:4096},inputModalities:['text'],...(model==='fixture-office'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
 async *stream(options){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({model:options.model,reasoningEffort:options.reasoningEffort??null,purpose:options.purpose||'chat',maxTokens:options.maxTokens,checkpoint:JSON.stringify(options.messages).includes('CONTEXT_CHECKPOINT_MARKER'),longInput:JSON.stringify(options.messages).includes('ORIGINAL_LONG_MARKER')})+'\\n');if(options.purpose==='compaction'&&fs.existsSync(${JSON.stringify(trace+'.pause')}))await new Promise((resolve,reject)=>{if(options.signal?.aborted)reject(new LlmError('cancelled','RUN_CANCELLED'));else options.signal.addEventListener('abort',()=>reject(new LlmError('cancelled','RUN_CANCELLED')),{once:true});});yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:options.purpose==='compaction'?'CONTEXT_CHECKPOINT_MARKER: retained verified fixture facts.':'CONTEXT_CHAIN_OK'}};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};}
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
  const start=()=>{
   child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0'},stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  };start();
  const req=(url,{user=0,method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const json=async(url,opts)=>{const r=await req(url,opts);assert.equal(r.status,200,await r.clone().text());return r.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready,logs);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-not-paid-key'}});
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  const calls=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const run=async message=>{const response=await req('/api/chat',{method:'POST',body:{conversationId,message}});const body=await response.text();assert.match(body,/CONTEXT_CHAIN_OK|上下文已压缩|当前没有可压缩/,body+logs);const runId=response.headers.get('x-agent-run-id');const run=(await json('/api/runs/'+runId)).run;assert.equal(run.state,'completed');return {runId,run,events:(await json('/api/runs/'+runId+'/events')).events};};
  await run('ORIGINAL_LONG_MARKER '+ 'long context fixture '.repeat(1200));
  await run('Establish a recent retained turn '+ 'retained fixture '.repeat(200));
  const automatic=await run('Continue with prior facts');
  assert.ok(calls().some(call=>call.purpose==='compaction'),'native pressure hook must really dispatch summarization '+JSON.stringify(calls())+' '+fs.readdirSync(path.join(runtime,'_tmp')).filter(n=>n.endsWith('.err')||n.endsWith('.txt')).map(n=>fs.readFileSync(path.join(runtime,'_tmp',n),'utf8')).join(' ').slice(-6000)+' '+(fs.existsSync(trace+'.debug')?fs.readFileSync(trace+'.debug','utf8'):'no pre-step hook'));
  assert.ok(calls().every(call=>call.maxTokens<=128));
  const autoIntents=automatic.events.filter(event=>event.payload?.action==='model_request_intent');
  const budget=automatic.events.find(event=>event.type==='usage'&&event.payload?.kind==='run_budget');assert.equal(budget.payload.snapshot.modelCalls,2);
  assert.equal(autoIntents.filter(event=>event.payload.purpose==='compaction').length,1);assert.equal(autoIntents.length,2,'summary and main answer each have one durable intent');
  const estimates=automatic.events.find(event=>event.payload?.kind==='text_response_estimates');assert.equal(estimates.payload.responses.length,2,'native summary usage and main response are both retained');
  const history=(await json('/api/conversations/'+conversationId)).conversation;assert.equal(history.messages.at(-1).context.compactions,1);
  assert.ok(calls().at(-1).checkpoint);assert.equal(calls().at(-1).longInput,false,'the replaced prefix must not be replayed beside its summary');
  const beforeRestart=calls().length;
  const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  start();let restarted=false;for(let n=0;n<150;n++){try{if((await req('/api/auth/me')).status===200){restarted=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}assert.equal(restarted,true,logs);
  await run('Continue after full Shell and native process restart');assert.equal(calls().length,beforeRestart+1);assert.equal(calls().at(-1).checkpoint,true);assert.equal(calls().at(-1).longInput,false);
  const resumed=(await json('/api/conversations/'+conversationId)).conversation.messages.at(-1).context;assert.equal(resumed.resumed,true);
  await run('Another useful history span '+ 'manual fixture '.repeat(400));
  const manual=await run('/compact');assert.ok(manual.events.some(event=>event.payload?.action==='model_request_intent'&&event.payload.purpose==='compaction'));
  const last=(await json('/api/conversations/'+conversationId)).conversation.messages.at(-1);assert.equal(last.context.manual,true);assert.equal(last.context.compactions,1);
  await run('After manual checkpoint');assert.equal(calls().at(-1).checkpoint,true);
  const countBeforeForgery=calls().length;assert.equal((await req('/api/chat',{method:'POST',body:{conversationId,message:'forged restore',nativeSession:{sessionId:'foreign'}}})).status,400);assert.equal(calls().length,countBeforeForgery);
  await json('/api/memory',{method:'POST',body:{key:'clear-saved-context',value:'new preference'}});
  await run('After explicit memory invalidation');assert.equal(calls().at(-1).checkpoint,false,'revoked model context must not return from a persisted native session');
  assert.equal((await json('/api/conversations/'+conversationId)).conversation.messages.at(-1).context.resumed,false);

  await run('History span for cancellation '+ 'cancel fixture '.repeat(400));await run('Retain a recent short turn');
  fs.writeFileSync(trace+'.pause','pause');const beforePause=calls().length;
  const pending=await req('/api/chat',{method:'POST',body:{conversationId,message:'/compact'}});const pendingId=pending.headers.get('x-agent-run-id');assert.ok(pendingId);
  let paused=false;for(let n=0;n<100;n++){if(calls().length>beforePause&&calls().at(-1).purpose==='compaction'){paused=true;break;}await new Promise(r=>setTimeout(r,20));}assert.equal(paused,true);
  await json('/api/chat/stop',{method:'POST',body:{conversationId,runId:pendingId}});await pending.text();assert.equal((await json('/api/runs/'+pendingId)).run.state,'cancelled');const cancellationEvents=(await json('/api/runs/'+pendingId+'/events')).events;assert.ok(cancellationEvents.some(event=>event.payload?.action==='context_usage_incomplete'),'an interrupted auxiliary response must remain explicitly unknown');
  fs.unlinkSync(trace+'.pause');await json('/api/memory',{method:'POST',body:{key:'clear-cancelled-context',value:'fresh after cancellation'}});await run('After cancelled maintenance');assert.equal(calls().at(-1).checkpoint,false);
  if(process.env.NORTHSTAR_CONTEXT_BROWSER==='1'){
   await run('Useful span before browser manual compaction '+ 'browser fixture '.repeat(400));await run('Recent retained turn');
   const session='c'+crypto.randomBytes(4).toString('hex'),cli=(...args)=>execFileSync('playwright-cli',['-s='+session,...args],{cwd:root,env:{...process.env,TMPDIR:'/private/tmp'},encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
   const driver=fs.readFileSync(path.join(root,'tests/probes/context-browser-driver-20261102.js'),'utf8').trim();const script=path.join(root,'.playwright-cli',session+'-driver.js');fs.mkdirSync(path.dirname(script),{recursive:true});
   fs.writeFileSync(script,'async page => ('+driver+')(page,'+JSON.stringify({baseURL:'http://127.0.0.1:'+port,cookie:cookies[0].slice(11),screenshot:path.join(root,'docs/refactor/evidence/context-browser-20261102.png')})+')');
   const before=calls().filter(call=>call.purpose==='compaction').length;
   try{cli('open');assert.equal(JSON.parse(cli('--raw','run-code','--filename='+script)).status,'CONTEXT_BROWSER_CHAIN_PASS');}finally{try{cli('close');}catch{}fs.rmSync(script,{force:true});}
   assert.equal(calls().filter(call=>call.purpose==='compaction').length,before+1);
  }

 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
