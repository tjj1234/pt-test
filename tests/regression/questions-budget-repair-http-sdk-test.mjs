import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
for(const mode of ['valid-one','empty-question-then-valid','two-tool-calls','always-invalid'])test('question preflight budget repair '+mode,{timeout:45000},async()=>{
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
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter,CallId},{default:Prompt},{default:Tools},{default:Loop},{default:Attachments}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-attachment-local'].map(load));
const ctx=new Context();for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}],[Attachments,{dshHome:process.env.DSH_HOME}]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
const {UserQuestionService}=await load('@deepseek-ai/dsh-user-questions');new UserQuestionService(ctx);
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'powertokens',model:'fixture-office'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],...(model==='fixture-office'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
 counts=new Map();
 async *stream(options){
  const sid=String(options.sessionId),n=(this.counts.get(sid)||0)+1;this.counts.set(sid,n);
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({sessionId:sid,n,model:options.model,askVisible:(options.tools||[]).some(t=>t.name==='ask_user_question')})+'\\n');
  const askVisible=(options.tools||[]).some(t=>t.name==='ask_user_question');
  const mode=${JSON.stringify(mode)};
  const block=!askVisible?{type:'text',text:'QUESTION_DISABLED_OK'}:(mode==='always-invalid'?true:mode==='empty-question-then-valid'?n<=2:mode==='two-tool-calls'?n<=2:n===1)?{type:'tool-call',id:CallId('question-'+n),name:'ask_user_question',arguments:{questions:[{id:'report-format',question:(mode==='always-invalid'||mode==='empty-question-then-valid'&&n===1)?'':'Which report format?',options:[{label:'A'},{label:'B'}]}]}}:{type:'text',text:'QUESTION_CHAIN_OK'};
  yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
 }
}
ctx.llm.registerAdapter(['powertokens'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-office','fixture-plain']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const models=['fixture-office','fixture-plain'].map(id=>normalizePtRecord({id,supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models.find(m=>m.id===id)?.verifications||{}})).map(model=>({...model,chat:model.tasks.textChat.value,kind:'chat',capabilityStatus:'supported',runtimeStatus:model.states.textChat.verified?'verified':'adapted_unverified',...(process.env.AUTO08_POLICY_TEST==='1'?{states:{...model.states,textChat:{...model.states.textChat,verified:true,autoEligible:true}}}:{})}));
value.writeScopedCache(scopeId,{scopeId,models,lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0});
return {models,scopeId,availability:{status:'available',modelIds:models.map(m=>m.id)},catalogDiagnostics:{state:'fresh',errorCode:null}};}};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(command,args,opts)=>value.spawn(command,[${JSON.stringify(entry)},...args.slice(1)],opts)};return value;};`);
  const profiles=path.join(runtime,'dsh-home/profiles');fs.mkdirSync(profiles,{recursive:true});fs.symlinkSync(path.join(root,'shell/node_modules'),path.join(profiles,'node_modules'),'dir');
  const auto08PolicyFile=path.join(temp,'auto08-policy.json');fs.writeFileSync(auto08PolicyFile,JSON.stringify({version:'fixture-auto08-v1',routes:{textChat:['fixture-office']}}));
  child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0',AUTO08_POLICY_TEST:process.env.AUTO08_POLICY_TEST||'',...(process.env.AUTO08_POLICY_TEST==='1'?{PT_AUTO08_ROUTE_CONFIG_FILE:auto08PolicyFile}:{})},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const req=(url,{user=0,method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const json=async(url,opts)=>{const r=await req(url,opts);assert.equal(r.status,200,await r.clone().text());return r.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready,logs);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-not-paid-key'}});
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  const calls=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'QA clarification budget characterization',allowQuestions:true}});
  assert.equal(response.status,200);const runId=response.headers.get('x-agent-run-id');assert.ok(runId);
  const read=response.text();let questions=[],terminal;
  for(let i=0;i<400;i++){
    const info=await json('/api/runs/'+runId);terminal=info.run||info;
    questions=(await json('/api/runs/'+runId+'/questions')).questions;
    for(const q of questions.filter(q=>q.status==='pending'))await json('/api/runs/'+runId+'/questions/'+encodeURIComponent(q.id)+'/answer',{method:'POST',body:{callId:q.callId,answer:{selected:['A']}}});
    if(['completed','failed','cancelled','interrupted'].includes(terminal.state))break;
    await new Promise(r=>setTimeout(r,15));
  }
  const text=await read;const events=(await json('/api/runs/'+runId+'/events?after=0&limit=200')).events;
  console.log(JSON.stringify({mode,runState:terminal.state,questions:questions.map(q=>({status:q.status,id:q.id})),modelRequests:calls().length,codes:events.filter(e=>e.type==='error'||e.type==='done').map(e=>e.payload),toolSteps:events.filter(e=>e.type==='tool.finished').map(e=>e.payload),budgetError:/tool-call budget was exhausted/.test(text),modelBudgetError:/model-call budget/.test(text)}));
  if(['valid-one','empty-question-then-valid'].includes(mode)){assert.equal(questions.length,1);assert.equal(questions[0].status,'answered');assert.equal(terminal.state,'completed');assert.equal(calls().length,mode==='valid-one'?2:3);assert.equal(/tool-call budget was exhausted/.test(text),false);}
  else if(mode==='two-tool-calls'){assert.notEqual(terminal.state,'completed');assert.equal(questions.length,1);assert.equal(/tool-call budget was exhausted/.test(text),true);assert.equal(calls().length,2);}
  else{assert.notEqual(terminal.state,'completed');assert.equal(questions.length,0);assert.equal(calls().length,3);assert.equal(/model-call budget/.test(text),true);}
 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
