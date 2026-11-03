// One server/locked-SDK candidate across all four tasks. Only catalog/model
// transport, provider HTTP and asset HTTP are fixtures; no live credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const root=path.resolve('.'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const sdk=String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const require=createRequire(path.join(ROOT,'shell/package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const [{Context},{default:Agents},{default:Sessions},{default:Llm,LlmAdapter,CallId},{default:Prompt},{default:Tools},{default:Loop}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent-loop'].map(load));
const ctx=new Context();for(const [plugin,config] of [[Agents],[Sessions],[Llm],[Prompt,{}],[Tools,{}],[Loop,{agents:[]}]])await ctx.plugin(plugin,...(config===undefined?[]:[config]));
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'managed-fixture',model:'fixture-chat'})});ctx.provide('appExit',code=>process.exit(code));
class FixtureAdapter extends LlmAdapter{
 counts=new Map();
 async *stream(options){
  const sid=String(options.sessionId),count=(this.counts.get(sid)||0)+1;this.counts.set(sid,count);
  const selection=JSON.parse(fs.readFileSync(SELECTOR,'utf8'));
  const block=selection.mode==='chat'||count%2===0?{type:'text',text:'Managed fixture completed'}:{type:'tool-call',id:CallId('managed-'+sid),name:'media_route',arguments:{taskType:selection.taskType,prompt:selection.badHost?'fixture blocked host':'fixture 9 images 30 seconds 1080P',...(selection.taskType.startsWith('image2')?{inputImageUrl:'https://attacker.example.test/not-current-upload.png'}:{})}};
  yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:block.type==='tool-call'?'tool-calls':'stop'}};
 }
}
ctx.llm.registerAdapter(['managed-fixture'],new FixtureAdapter());
const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`;
test(process.env.NORTHSTAR_STANDARD3_TEST==='1'?'standard-three release authorizes, generates, hosts and reopens only selected media':'same HTTP server and actual locked SDK authorize, generate, host and reopen four media types',{timeout:60000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'f1-managed-http-sdk-'));
 const runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'key'),selector=path.join(temp,'selector.json'),trace=path.join(temp,'posts.jsonl'),pidFile=path.join(temp,'sdk.pid');
 let storage,child,output='';
 try{
  storage=await createStorage({dataDir,masterKeyFile});const cookies=[];
  for(const suffix of ['owner','other']){
   const u=(await storage.repositories.auth.register({username:'managed-sdk-'+suffix,email:suffix+'@example.test',password:'FixturePass123'})).user;
   await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',['https://accounts.google.com','managed-sdk-'+suffix,u.id,u.email]);
   const token=crypto.randomBytes(32).toString('hex');await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[u.id,sha(token),new Date(Date.now()+120000).toISOString()]);cookies.push('pt_session='+token);
  }
  await storage.close();storage=null;
  const listener=createServer();await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const entry=path.join(temp,'sdk.mjs');fs.writeFileSync(entry,`import fs from 'node:fs';\nconst ROOT=${JSON.stringify(root)},SELECTOR=${JSON.stringify(selector)};fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\n`+sdk);
  const preload=path.join(temp,'fixture.cjs');
  fs.writeFileSync(preload,`const Module=require('node:module'),fs=require('node:fs'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>["fixture-chat"]};

if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async()=>({models:[{id:'fixture-chat',scopeId:'fixture-scope',availability:'present',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],scopeId:'fixture-scope',availability:{status:'available',modelIds:['fixture-chat']},catalogDiagnostics:{state:'fresh',errorCode:null}})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/media-route-admission.cjs')return {...value,resolveMediaRouteForRun:async input=>{const image=input.args.taskType.endsWith('image');return {schemaVersion:1,taskType:input.args.taskType,model:image?'seedream-5-0-260128':'fixture-video',scopeId:'fixture-scope',capabilityRevision:'a'.repeat(64),adapterId:image?'pt-image-generations-v1':'pt-video-generations-v1',adapterVersion:'1',endpoint:image?'openai-images-generations':'openai-videos',provider:image?'powertokens-image':'powertokens-video',kind:image?'image':'video'};}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./media/pinned-asset-fetch.cjs')return {...value,createPinnedAssetFetch:()=>async url=>{const image=url.includes('.png');const bytes=image?Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]):Buffer.alloc(20);if(!image){bytes.writeUInt32BE(16);bytes.write('ftypisom',4);}return new Response(bytes,{headers:{'Content-Type':image?'image/png':'video/mp4'}});}};
if(parent?.filename.endsWith('/server.cjs')&&name==='../business/media/powertokens.cjs')return {...value,callMediaRoute:(context,args,opts)=>value.callMediaRoute(context,args,{...opts,fetchImpl:async(url,init)=>{if(init.method!=='POST')throw Error('unexpected fixture polling');const body=JSON.parse(init.body);const image=url.includes('/images/');const blocked=JSON.parse(fs.readFileSync(${JSON.stringify(selector)},'utf8')).badHost===true;const host=blocked?'blocked.example.test':'cdn.example.test';fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({taskType:args.taskType,model:body.model,n:body.n??null,size:body.size,seconds:body.seconds??null,ratio:body.ratio??null,reference:body.image??body.media?.[0]?.url??null})+'\\n');return new Response(JSON.stringify(image?{data:[{url:'https://'+host+'/result.png?token=PRIVATE_SENTINEL'}]}:{status:'completed',url:'https://'+host+'/result.mp4?token=PRIVATE_SENTINEL'}),{headers:{'Content-Type':'application/json'}});}})};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(command,args,opts)=>{if(command!==process.execPath||args[1]!=='--profile')throw Error('unexpected fixture launcher');return value.spawn(command,[${JSON.stringify(entry)},...args.slice(1)],opts);}};
return value;};`);
  const profiles=path.join(runtime,'dsh-home/profiles');fs.mkdirSync(profiles,{recursive:true});fs.symlinkSync(path.join(root,'shell/node_modules'),path.join(profiles,'node_modules'),'dir');
  child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_SHELL_PORT:String(port),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0',...(process.env.NORTHSTAR_STANDARD3_TEST==='1'?{PT_MEDIA_GENERATION:'standard3'}:{}),PT_CONTROLLED_MEDIA_AUTHORIZATION:'1',PT_MEDIA_ASSET_HOSTS:'cdn.example.test'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const req=(url,{user=0,method='GET',body,headers={}}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{...headers,...(user===null?{}:{Cookie:cookies[user]}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const json=async(url,opts)=>{const response=await req(url,opts);assert.equal(response.status,200,await response.clone().text());return response.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(ready,true,output);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-no-paid-key'}});
  const input=Buffer.from([137,80,78,71,13,10,26,10,8,7,6,5]);const uploaded=await json('/api/upload',{method:'POST',body:{image:input.toString('base64')}});
  const results=[];
  for(const taskType of (process.env.NORTHSTAR_STANDARD3_TEST==='1'?['text2image','image2image','text2video']:['text2image','image2image','text2video','image2video'])){
   fs.writeFileSync(selector,JSON.stringify({taskType}));const conversationId=(await json('/api/conversations',{method:'POST'})).id;
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Create fixture '+taskType,taskType,...(taskType.startsWith('image2')?{image:uploaded.url}:{})}});
   const runId=response.headers.get('x-agent-run-id');assert.ok(runId);const stream=response.text();
   let pending=false;for(let i=0;i<100;i++){const status=await req('/api/runs/'+runId+'/media-authorization');if(status.status===200){pending=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(pending,true,output);
   await json('/api/runs/'+runId+'/media-authorization',{method:'POST',body:{confirmed:true,modelId:taskType.endsWith('image')?'seedream-5-0-260128':'fixture-video'}});
   const frames=await stream;assert.match(frames,/Managed fixture completed/,frames+output);assert.equal(frames.includes('PRIVATE_SENTINEL'),false);
   const run=await json('/api/runs/'+runId);assert.equal(run.run.state,'completed');assert.equal(run.externalOperations.operations[0].status,'succeeded');assert.equal(run.managedMedia.media.length,1);
   const events=await json('/api/runs/'+runId+'/events');const budget=events.events.find(e=>e.type==='usage'&&e.payload.kind==='run_budget');assert.ok(budget,JSON.stringify(events.events));
   assert.equal(budget.payload.limits.maxToolCalls,1);assert.equal(budget.payload.limits.maxOutputTokens,512);assert.equal(budget.payload.snapshot.modelCalls,2);assert.equal(budget.payload.snapshot.toolCalls,1);assert.equal(budget.payload.snapshot.retries,0);
   const media=run.managedMedia.media[0],file=await req(media.url);assert.equal(file.status,200);assert.ok((await file.arrayBuffer()).byteLength>0);assert.equal((await req(media.url,{user:1})).status,404);
   const history=(await json('/api/conversations/'+conversationId)).conversation.messages;assert.equal(history.find(m=>m.role==='assistant').media[0].url,media.url);
   results.push({conversationId,runId});
  }
  const posts=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(posts.length,process.env.NORTHSTAR_STANDARD3_TEST==='1'?3:4);
  for(const post of posts){if(post.taskType.endsWith('image')){assert.equal(post.n,1);assert.equal(post.size,'2048x2048');}else{assert.equal(post.seconds,'5');assert.equal(post.size,'720P');assert.equal(post.ratio,'16:9');}assert.equal(post.reference,post.taskType.startsWith('image2')?'data:image/png;base64,'+input.toString('base64'):null);}
  // A media tool failure must not turn the model success claim into a completed Run.
  // The pure acceptance gate separately checks remote-success-shaped results
  // with missing local media.
  fs.writeFileSync(selector,JSON.stringify({taskType:'text2image',badHost:true}));
  const failedConversation=(await json('/api/conversations',{method:'POST'})).id;
  const failedResponse=await req('/api/chat',{method:'POST',body:{conversationId:failedConversation,message:'Create fixture media with blocked host',taskType:'text2image'}});
  const failedRunId=failedResponse.headers.get('x-agent-run-id');assert.ok(failedRunId);
  const failedStream=failedResponse.text();
  let failedPending=false;for(let i=0;i<100;i++){if((await req('/api/runs/'+failedRunId+'/media-authorization')).status===200){failedPending=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(failedPending,true);
  await json('/api/runs/'+failedRunId+'/media-authorization',{method:'POST',body:{confirmed:true,modelId:'seedream-5-0-260128'}});
  const failedFrames=await failedStream;assert.match(failedFrames,/MEDIA_RESULT_NOT_AVAILABLE/);assert.equal(failedFrames.includes('Managed fixture completed'),false);
  const failedRun=await json('/api/runs/'+failedRunId);assert.equal(failedRun.run.state,'failed');assert.equal(failedRun.managedMedia.media.length,0);
  const failedHistory=(await json('/api/conversations/'+failedConversation)).conversation.messages;assert.equal(failedHistory.some(m=>m.role==='assistant'&&m.media?.length),false);
  // Same warm process returns to the default zero-tool profile afterwards.
  fs.writeFileSync(selector,JSON.stringify({mode:'chat'}));const ordinary=await req('/api/chat',{method:'POST',body:{conversationId:results.at(-1).conversationId,message:'Ordinary text fixture'}});const ordinaryId=ordinary.headers.get('x-agent-run-id');assert.match(await ordinary.text(),/Managed fixture completed/);assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,process.env.NORTHSTAR_STANDARD3_TEST==='1'?3:4);
  const ordinaryEvents=await json('/api/runs/'+ordinaryId+'/events');const ordinaryBudget=ordinaryEvents.events.find(e=>e.type==='usage'&&e.payload.kind==='run_budget');assert.equal(ordinaryBudget.payload.limits.maxToolCalls,0);assert.equal(ordinaryBudget.payload.limits.maxOutputTokens,128);assert.equal(ordinaryBudget.payload.snapshot.modelCalls,1);assert.equal(ordinaryBudget.payload.snapshot.toolCalls,0);
 }finally{
  if(child&&child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}
  if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
