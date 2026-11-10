import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {createServer} from 'node:net';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createStorage}=require('../../shell/storage/index.cjs');const root=path.resolve('.'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('same-version Office/PDF upload reaches native DSH, exports Word/PDF and reopens owned history',{timeout:40000},async()=>{
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
ctx.provide('loader',{await:async()=>{}});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'fixture',model:'fixture-office'})});ctx.provide('appExit',code=>process.exit(code));
class Adapter extends LlmAdapter{
 async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text','image']};}
 async *stream(options){const text=JSON.stringify(options.messages)+' '+JSON.stringify(options.system||'');const nativeImages=options.messages.flatMap(message=>message.content||[]).filter(block=>block.type==='image');for(const block of nativeImages)await ctx.attachments.readImage(block.attachment);const office=text.includes('XLSX_UNTRUSTED_EXTRACT')||text.includes('PPTX_UNTRUSTED_EXTRACT')||text.includes('PDF_UNTRUSTED_EXTRACT');const media=text.includes('UNTRUSTED_MEDIA_CONTENT');if(media&&!text.includes('ask not what your country')&&nativeImages.length!==3)throw Error('Video frames did not reach native attachments');if(!office&&!media)throw Error('Owned source did not reach native request');fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({office,xlsx:text.includes('编号00123中文'),pptx:text.includes('中文演示第一段'),pdf:text.includes('PDF original page 2'),media,nativeImages:nativeImages.length})+'\\n');yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:media?'MEDIA_CHAIN_OK':'OFFICE_CHAIN_OK'}};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};}
}
ctx.llm.registerAdapter(['fixture'],new Adapter());fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const {apply}=await import(pathToFileURL(path.join(process.env.DSH_HOME,'profiles/run-persistent/persistent-runner.mjs')));apply(ctx);
`);
  const preload=path.join(temp,'preload.cjs');fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(name,parent){const value=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...value,configuredModels:()=>['fixture-office']};
if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...value,getCatalog:async opts=>{
const {normalizePtRecord}=require(${JSON.stringify(path.join(root,'shell/models/capabilities.cjs'))});const scopeId=value.resolveScopeId(opts),at=new Date().toISOString(),prior=value.readScopedCache(scopeId);
const m=normalizePtRecord({id:'fixture-office',supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},{scopeId,observedAt:at,sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'fixture',version:'1',endpoint:'openai-chat-completions',source:'fixture'}},verifications:prior?.models[0]?.verifications||{}});
value.writeScopedCache(scopeId,{scopeId,models:[m],lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0});
return {models:[m],scopeId,availability:{status:'available',modelIds:[m.id]},catalogDiagnostics:{state:'fresh',errorCode:null}};}};
if(parent?.filename.endsWith('/runtime/dsh-adapter.cjs')&&name==='child_process')return {...value,spawn:(command,args,opts)=>value.spawn(command,[${JSON.stringify(entry)},...args.slice(1)],opts)};return value;};`);
  const profiles=path.join(runtime,'dsh-home/profiles');fs.mkdirSync(profiles,{recursive:true});fs.symlinkSync(path.join(root,'shell/node_modules'),path.join(profiles,'node_modules'),'dir');
  child=spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0',NODE_PATH:process.env.NODE_PATH,PT_NATIVE_MEDIA_RUNTIME:process.env.PT_NATIVE_MEDIA_RUNTIME},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const req=(url,{user=0,method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookies[user],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const json=async(url,opts)=>{const r=await req(url,opts);assert.equal(r.status,200,await r.clone().text());return r.json();};
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready,logs);
  await json('/api/auth/key',{method:'POST',body:{key:'fixture-not-paid-key'}});
  const {spreadsheet,presentation}=require('../helpers/office-structured-fixtures.cjs');
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  await json('/api/models/select',{method:'POST',body:{conversationId,model:'fixture-office'}});
  const PDF=shellRequire('pdfkit'),pdf=new PDF(),parts=[];
  const pdfBytes=new Promise((resolve,reject)=>{pdf.on('data',b=>parts.push(b));pdf.on('end',()=>resolve(Buffer.concat(parts)));pdf.on('error',reject);});
  pdf.text('PDF original page 1');pdf.addPage().text('PDF original page 2');pdf.end();
  for(const [format,bytes] of [['xlsx',spreadsheet()],['pptx',presentation()],['pdf',await pdfBytes]]){
   const upload=await json('/api/upload-doc',{method:'POST',body:{name:'source.'+format,data:bytes.toString('base64')}});
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Read the supplied Office source',documents:[upload.url]}});
   const text=await response.text();assert.match(text,/OFFICE_CHAIN_OK/,text+logs);
   const runId=response.headers.get('x-agent-run-id');assert.ok(runId);
   assert.equal((await json('/api/runs/'+runId)).run.state,'completed');
   const events=(await json('/api/runs/'+runId+'/events')).events;
   const source=events.find(e=>e.type==='attachment.status'&&e.payload?.kind===format);
   assert.equal(source?.payload?.sha256,sha(bytes));assert.equal(source?.payload?.truncated,false);
   assert.equal(events.filter(e=>e.payload?.action==='model_request_intent').length,1);
   const budget=events.find(e=>e.type==='usage'&&e.payload?.kind==='run_budget');
   assert.equal(budget?.payload?.snapshot?.modelCalls,1);assert.equal(budget?.payload?.snapshot?.toolCalls,0);
  }
  const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.office));assert.equal(calls[0].xlsx,true);assert.equal(calls[1].pptx,true);assert.equal(calls[2].pdf,true);
  const history=(await json('/api/conversations/'+conversationId)).conversation.messages;
  assert.equal(history.filter(m=>m.role==='assistant'&&m.text==='OFFICE_CHAIN_OK').length,3);
  const exported=await req('/api/conversations/'+conversationId+'/export?fmt=docx');assert.equal(exported.status,200);
  const bytes=Buffer.from(await exported.arrayBuffer());assert.equal(sha(bytes),exported.headers.get('x-content-sha256'));
  const {parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs');
  assert.ok((await parseOfficeDocument({bytes,format:'docx'})).text.includes('OFFICE_CHAIN_OK'));
  assert.equal((await req('/api/conversations/'+conversationId+'/export?fmt=docx',{user:1})).status,404);
  const pdfResponse=await req('/api/conversations/'+conversationId+'/export?fmt=pdf');assert.equal(pdfResponse.status,200,await pdfResponse.clone().text());
  assert.equal(pdfResponse.headers.get('content-type'),'application/pdf');
  const pdfExport=Buffer.from(await pdfResponse.arrayBuffer());assert.equal(sha(pdfExport),pdfResponse.headers.get('x-content-sha256'));
  assert.ok((await parseOfficeDocument({bytes:pdfExport,format:'pdf'})).text.includes('OFFICE_CHAIN_OK'));
  assert.equal((await req('/api/conversations/'+conversationId+'/export?fmt=pdf',{user:1})).status,404);
  const allSources=(await json('/api/sources')).sources;
  const pdfSource=allSources.find(s=>s.format==='pdf');assert.ok(pdfSource);
  const found=await json('/api/sources/search',{method:'POST',body:{sourceIds:[pdfSource.id],query:'original'}});
  assert.ok(found.results.some(hit=>hit.locator.kind==='pdf-page'&&hit.locator.page===2));
  assert.equal((await req('/api/sources/search',{user:1,method:'POST',body:{sourceIds:[pdfSource.id],query:'original'}})).status,404);
  if(process.env.R34_MEDIA_PROOF_ROOT){
   const audio=fs.readFileSync(path.join(process.env.R34_MEDIA_PROOF_ROOT,'whisper.cpp-1.7.6/samples/jfk.wav'));
   const upload=await json('/api/upload-media',{method:'POST',body:{data:audio.toString('base64')}});
   const denied=await req('/api/chat',{user:1,method:'POST',body:{message:'transcribe',media:[{type:'audio',url:upload.url}]}});assert.ok([400,403,409].includes(denied.status));
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Transcribe the uploaded audio with timestamps',media:[{type:'audio',url:upload.url}]}});
   assert.match(await response.text(),/MEDIA_CHAIN_OK/,logs);const runId=response.headers.get('x-agent-run-id');
   assert.equal((await json('/api/runs/'+runId)).run.state,'completed');
   const events=(await json('/api/runs/'+runId+'/events')).events,source=events.find(event=>event.type==='attachment.status'&&event.payload?.kind==='media');
   assert.equal(source.payload.inputSha256,sha(audio));assert.match(source.payload.segments.map(segment=>segment.text).join(' '),/ask not what your country/i);
   assert.equal(source.payload.durationMs,11000);
   const history=(await json('/api/conversations/'+conversationId)).conversation.messages;
   assert.ok(history.some(message=>message.role==='assistant'&&message.text==='MEDIA_CHAIN_OK'));
   const saved=history.find(message=>message.media?.some(item=>item.url===upload.url));assert.equal(saved.mediaEvidence[0].sha256,sha(audio));
   assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).at(-1).media,true);
   const file=path.join(temp,'video-fixture.mp4');
   await require('../../shell/media/local-content-runtime.cjs').run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=10','-t','3','-c:v','mpeg4',file],{cwd:temp});
   const video=fs.readFileSync(file),videoUpload=await json('/api/upload-media',{method:'POST',body:{data:video.toString('base64')}});
   const videoResponse=await req('/api/chat',{method:'POST',body:{conversationId,message:'Describe the uploaded video frames with timestamps',media:[{type:'video',url:videoUpload.url}]}});
   assert.match(await videoResponse.text(),/MEDIA_CHAIN_OK/,logs);
   const videoRun=videoResponse.headers.get('x-agent-run-id');assert.equal((await json('/api/runs/'+videoRun)).run.state,'completed');
   const videoEvents=(await json('/api/runs/'+videoRun+'/events')).events,videoSource=videoEvents.find(event=>event.type==='attachment.status'&&event.payload?.kind==='media');
   assert.equal(videoSource.payload.inputSha256,sha(video));assert.equal(videoSource.payload.frames.length,3);assert.deepEqual(videoSource.payload.frames.map(frame=>frame.timestampMs),[0,1500,2000]);
   assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).at(-1).nativeImages,3);

  }




 }finally{
  if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}
  if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid,'utf8')),'SIGTERM');}catch{}}
  if(storage)await storage.close();fs.rmSync(temp,{recursive:true,force:true});
 }
});
