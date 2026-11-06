import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('native questions cross owned HTTP, durable authority, reload and real SDK',{timeout:90000},async()=>{
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
  const block=!askVisible?{type:'text',text:'QUESTION_DISABLED_OK'}:n%2===1?{type:'tool-call',id:CallId('question-'+n),name:'ask_user_question',arguments:{questions:[{id:'report-format',question:'Which report format?',options:[{label:'A'},{label:'B'}]}]}}:{type:'text',text:'QUESTION_CHAIN_OK'};
  yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
 }
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
  const calls=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Clarify reporting format',allowQuestions:true}});
  assert.equal(response.status,200);const runId=response.headers.get('x-agent-run-id');assert.ok(runId);
  const read=response.text();
  let questions;
  for(let i=0;i<200;i++){questions=await json('/api/runs/'+runId+'/questions');if(questions.questions.length)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(questions.questions.length,1,logs);const q=questions.questions[0];assert.equal(q.status,'pending');
  assert.equal(calls().length,1,'no second model request before human answer');
  assert.equal((await req('/api/runs/'+runId+'/questions',{user:1})).status,404);
  assert.equal((await req('/api/runs/'+runId+'/questions/'+q.id+'/answer',{user:1,method:'POST',body:{callId:q.callId,answer:{selected:['A']}}})).status,404);
  assert.equal((await req('/api/runs/'+runId+'/questions/'+q.id+'/answer',{method:'POST',body:{callId:q.callId,answer:{selected:['A','B']}}})).status,400);
  await json('/api/runs/'+runId+'/questions/'+q.id+'/answer',{method:'POST',body:{callId:q.callId,answer:{selected:['A']}}});
  assert.equal((await req('/api/runs/'+runId+'/questions/'+q.id+'/answer',{method:'POST',body:{callId:q.callId,answer:{selected:['B']}}})).status,409);
  const text=await read;assert.match(text,/QUESTION_CHAIN_OK/,text+logs);
  assert.equal(calls().length,2);assert.equal((await json('/api/runs/'+runId)).run.state,'completed');
  assert.equal((await json('/api/runs/'+runId+'/questions')).questions[0].status,'answered');
  const events=(await json('/api/runs/'+runId+'/events')).events;
  assert.ok(events.some(e=>e.payload?.action==='user_question'&&e.payload.question.status==='pending'));
  assert.ok(events.some(e=>e.payload?.action==='user_question'&&e.payload.question.status==='answered'));
  const ordinary=await req('/api/chat',{method:'POST',body:{conversationId,message:'Ordinary follow-up without question mode'}});
  assert.match(await ordinary.text(),/QUESTION_DISABLED_OK/);assert.equal(calls().at(-1).askVisible,false,'warm ordinary Run must hide the question tool');
  const stoppedConversation=(await json('/api/conversations',{method:'POST'})).id;
  await json('/api/models/select',{method:'POST',body:{conversationId:stoppedConversation,model:'fixture-office'}});
  const stopped=await req('/api/chat',{method:'POST',body:{conversationId:stoppedConversation,message:'Clarify then stop',allowQuestions:true}});
  const stoppedId=stopped.headers.get('x-agent-run-id'),stoppedText=stopped.text();
  let stoppedQuestions;
  for(let i=0;i<200;i++){stoppedQuestions=await json('/api/runs/'+stoppedId+'/questions');if(stoppedQuestions.questions.length)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(stoppedQuestions.questions[0].status,'pending');const beforeStop=calls().length;
  await json('/api/runs/'+stoppedId+'/cancel',{method:'POST',body:{}});await stoppedText;
  assert.equal((await json('/api/runs/'+stoppedId+'/questions')).questions[0].status,'cancelled');
  assert.equal(calls().length,beforeStop,'cancelled clarification must not start another model request');

  if(process.env.NORTHSTAR_QUESTIONS_BROWSER==='1'){
    const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core');const browser=await chromium.launch({headless:true,channel:'chrome'});
    try{
      const base='http://127.0.0.1:'+port;
      const uiConversation=(await json('/api/conversations',{method:'POST'})).id;
      await json('/api/models/select',{method:'POST',body:{conversationId:uiConversation,model:'fixture-office'}});
      const page=await browser.newPage();await page.context().addCookies([{name:'pt_session',value:cookies[0].slice('pt_session='.length),url:base}]);
      await page.addInitScript(id=>{if(!sessionStorage.getItem('ptShellRoute'))sessionStorage.setItem('ptShellRoute',JSON.stringify({v:'chat',id}));},uiConversation);
      await page.goto(base);
      await page.locator('#ta').fill('Clarify my reporting format');await page.locator('#allowQuestions').check();await page.locator('#send').click();
      await page.locator('.user-question').waitFor({state:'visible',timeout:15000});
      await page.reload();await page.locator('.user-question').waitFor({state:'visible',timeout:15000});
      await page.screenshot({path:path.join(root,'docs/refactor/evidence/QUESTIONS-M1-LOCAL-BROWSER-PENDING-20261106.png')});
      await page.locator('.user-question input[value="A"]').check();await page.getByRole('button',{name:'提交答复',exact:true}).click();
      await page.getByText('QUESTION_CHAIN_OK',{exact:true}).waitFor({timeout:15000});
      await page.screenshot({path:path.join(root,'docs/refactor/evidence/QUESTIONS-M1-LOCAL-BROWSER-20261106.png')});
      console.log('QUESTIONS_LOCAL_BROWSER_PASS: actual UI submit, reload pending question, answer, native SDK continuation; zero paid provider calls');
    }finally{await browser.close();}
  }
 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
