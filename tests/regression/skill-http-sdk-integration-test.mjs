import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('published Skill passes owned HTTP publication, durable Run pins and native skill loading',{timeout:90000},async()=>{
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
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter},{default:Prompt},{default:Tools},{default:Loop},{default:Attachments},{default:Skills},ToolSkill,{CallId}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-attachment-local','@deepseek-ai/dsh-skill','@deepseek-ai/dsh-tool-skill','@deepseek-ai/dsh-llm'].map(load));
const ctx=new Context();for(const [plugin,config]of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}],[Attachments,{dshHome:process.env.DSH_HOME}],[Skills]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ToolSkill.apply(ctx,{});
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'powertokens',model:'fixture-office'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],...(model==='fixture-office'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
 async *stream(options){
 const content=JSON.stringify(options.messages);const loaded=content.includes('Pinned publication version');
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({loaded,v1:content.includes('Pinned publication version 1'),v2:content.includes('Pinned publication version 2')})+'\\n');
 const resource=content.includes('Supporting fixture');const match=/releaseId=([a-f0-9-]{36})/.exec(content);const block=loaded&&resource?{type:'text',text:'SKILL_CHAIN_OK'}:loaded?{type:'tool-call',id:CallId('resource-'+Date.now()),name:'skill_resource',arguments:{releaseId:match?.[1]||'',paths:[content.includes('version 3')?'rules.md':'references/rules.md']}}:{type:'tool-call',id:CallId('skill-load-'+Date.now()),name:'skill',arguments:{name:'review-fixture'}};
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
  const release=version=>({skillId:'review-fixture',version,files:[{path:'SKILL.md',content:'---\nname: review-fixture\ndescription: Review owned fixture\n---\nPinned publication version '+version+'.'},{path:'references/rules.md',content:'Supporting fixture '+version}]});
  const first=await json('/api/published-skills',{method:'POST',body:release('1')});
  assert.equal((await json('/api/published-skills',{user:1})).skills.length,0);
  assert.equal((await req('/api/chat',{user:1,method:'POST',body:{conversationId,message:'foreign',skillReleaseIds:[first.releaseId]}})).status,404);
  const run=async(releaseId)=>{const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Use selected review instructions',skillReleaseIds:[releaseId]}});const text=await response.text();assert.match(text,/SKILL_CHAIN_OK/,text+logs+(fs.existsSync(trace+'.stderr')?fs.readFileSync(trace+'.stderr','utf8'):''));const runId=response.headers.get('x-agent-run-id');const detail=await json('/api/runs/'+runId);assert.equal(detail.run.state,'completed');return runId;};
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const firstRun=await run(first.releaseId);assert.equal(calls().filter(c=>c.loaded).length,2);assert.ok(calls().at(-1).v1);
  const history=(await json('/api/conversations/'+conversationId)).conversation.messages;assert.equal(history.find(m=>m.role==='user').skillPins[0].releaseId,first.releaseId);
  const second=await json('/api/published-skills',{method:'POST',body:release('2')});await run(second.releaseId);assert.ok(calls().at(-1).v2);assert.equal(calls().at(-1).v1,false,'new release must reset old model checkpoint');
  const changed=release('2');changed.files[0].content+=' changed';assert.equal((await req('/api/published-skills',{method:'POST',body:changed})).status,409);
  assert.equal((await req('/api/chat',{method:'POST',body:{conversationId,message:'forged',pinnedSkills:{}}})).status,400);
  await json('/api/published-skills/review-fixture/disable',{method:'POST'});const count=calls().length;
  const disabled=await req('/api/chat',{method:'POST',body:{conversationId,message:'disabled',skillReleaseIds:[second.releaseId]}});assert.equal(disabled.status,409);assert.equal(calls().length,count);
  assert.equal((await json('/api/runs/'+firstRun)).run.state,'completed');
  if(process.env.NORTHSTAR_SKILL_BROWSER==='1'){
   const session='s'+crypto.randomBytes(4).toString('hex');const cli=(...args)=>execFileSync('playwright-cli',['-s='+session,...args],{cwd:root,env:{...process.env,TMPDIR:'/private/tmp'},encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
   const driver=fs.readFileSync(path.join(root,'tests/probes/skill-browser-driver-20261102.js'),'utf8').trim();const screenshot=path.join(root,'docs/refactor/evidence/skill-browser-20261102.png');
   fs.mkdirSync(path.join(root,'.playwright-cli'),{recursive:true});const resourceFile=path.join(temp,'rules.md');fs.writeFileSync(resourceFile,'Supporting fixture 3');const script=path.join(root,'.playwright-cli',session+'-driver.js');fs.writeFileSync(script,'async page => ('+driver+')(page,'+JSON.stringify({baseURL:'http://127.0.0.1:'+port,cookie:cookies[0].slice('pt_session='.length),screenshot,resourceFile})+')');
   try{cli('open');const raw=cli('--raw','run-code','--filename='+script);assert.ok(raw.trim().startsWith('{'),raw);const result=JSON.parse(raw);assert.equal(result.status,'SKILL_BROWSER_CHAIN_PASS');assert.ok(fs.statSync(screenshot).size>1000);console.log(JSON.stringify(result));}finally{try{cli('close');}catch{}fs.rmSync(script,{force:true});}
  }


 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
