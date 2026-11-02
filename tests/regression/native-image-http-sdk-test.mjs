import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('HTTP verified upload reaches native DSH images, survives cold replay, and rejects changed/cross-tenant bytes',{timeout:40000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'native-image-http-')),runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'key'),trace=path.join(temp,'trace'),pid=path.join(temp,'pid');
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
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'fixture',model:'fixture-vision'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text','image']};}
 async *stream(options){const images=options.messages.flatMap(m=>m.content||[]).filter(b=>b.type==='image');for(const b of images)await ctx.attachments.readImage(b.attachment);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({images:images.length})+'\\n');yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'NATIVE_IMAGE_HTTP_OK'}};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};}
}
ctx.llm.registerAdapter(['fixture'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-vision']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const m=normalizePtRecord({id:'fixture-vision',supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models[0]?.verifications||{}});
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
  const bytes=await shellRequire('sharp')({create:{width:12,height:8,channels:3,background:'#abcdef'}}).png().toBuffer();
  const uploaded=await json('/api/upload',{method:'POST',body:{image:bytes.toString('base64')}});
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-vision'}});
  let round=0;
  for(const body of [{message:'Describe',image:uploaded.url},{message:'Recall image'},{regenerate:true}]){
   const r=await req('/api/chat',{method:'POST',body:{conversationId,...body}});const text=await r.text();assert.match(text,/NATIVE_IMAGE_HTTP_OK/,text+logs);
   const run=await json('/api/runs/'+r.headers.get('x-agent-run-id'));assert.equal(run.run.state,'completed');
   if(round++===0){
    const events=await json('/api/runs/'+r.headers.get('x-agent-run-id')+'/events');
    assert.ok(events.events.some(e=>e.payload?.action==='image_understanding_runtime_verified'),JSON.stringify(events));
    await json('/api/models/select',{method:'POST',body:{conversationId,model:'AUTO'}});
   }
  }
  const calls=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls().length,3);assert.ok(calls().every(c=>c.images===1));
  const foreign=(await json('/api/conversations',{user:1,method:'POST'})).id;
  const denied=await req('/api/chat',{user:1,method:'POST',body:{conversationId:foreign,message:'read',image:uploaded.url}});assert.ok(denied.status>=400);
  fs.writeFileSync(path.join(runtime,'_uploads',uploaded.url.split('/').slice(-2).join('/')),Buffer.from('changed'));
  const failed=await req('/api/chat',{method:'POST',body:{conversationId,message:'Recall altered image'}});await failed.text();
  const failedRun=await json('/api/runs/'+failed.headers.get('x-agent-run-id'));assert.equal(failedRun.run.state,'failed');assert.equal(calls().length,3);
 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
