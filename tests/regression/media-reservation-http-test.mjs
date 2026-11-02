import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs');
const {createMediaGrantStoreCandidate}=require('../../shell/tasks/media-grant-store-candidate.cjs');

test('authenticated reservation HTTP discovery and explicit reconciliation use owned durable facts only',{timeout:45000},async()=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'media-reservation-http-'));
 const options={dataDir:path.join(temp,'db'),masterKeyFile:path.join(temp,'key')};
 let storage,child,output='';
 try{
  storage=await createStorage(options);
  const sessions=[];
  for(const suffix of ['owner','other']){
   const user=(await storage.repositories.auth.register({username:'reservation-'+suffix,email:suffix+'@example.test',password:'FixturePass123'})).user;
   await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',['https://accounts.google.com','reservation-'+suffix,user.id,user.email]);
   const token=randomBytes(32).toString('hex');
   await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,createHash('sha256').update(token).digest('hex'),new Date(Date.now()+120000).toISOString()]);
   sessions.push({identity:{userId:user.id,tenantId:user.tenant_id},cookie:'pt_session='+token});
  }
  const [owner,other]=sessions;
  const runs=createTaskStore(storage.adapter),lease='fixture-worker';
  const grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent:({tx,identity,runId,...entry})=>runs.externalOperations.createIntentInTransaction(tx,identity,runId,entry)});
  const conv=await storage.repositories.conversations.create(owner.identity.userId);
  const fixtures=[];
  for(const outcome of ['succeeded','unknown']){
   let run=(await runs.createRun(owner.identity,{conversationId:conv.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'fixture'}},{owner:lease,ttlMs:300000})).run;
   run=await runs.transition(owner.identity,run.runId,'running',run.revision,lease);
   const route={credentialScopeId:'private-scope-not-in-http',modelId:'fixture-'+outcome,taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'fixture-adapter',adapterVersion:'1',provider:'fixture'};
   const grant=await grants.issue(owner.identity,{...route,grantId:randomUUID(),runId:run.runId,runLeaseOwner:lease,expiresAt:new Date(Date.now()+600000).toISOString()});
   const operationKey=run.runId+':'+randomUUID();
   const receipt=await grants.reserveAttempt(owner.identity,{...route,...owner.identity,grantId:grant.grantId,runId:run.runId,runLeaseOwner:lease,operationKey});
   if(outcome==='succeeded')await runs.externalOperations.recordSubmissionResult(owner.identity,run.runId,operationKey,{runLeaseOwner:lease,outcome:'succeeded',providerStatus:'succeeded',reason:null,queried:false,observedAt:new Date().toISOString()});
   else await runs.externalOperations.markUnknownSubmission(owner.identity,run.runId,operationKey,{runLeaseOwner:lease,reason:'submission_response_unknown',observedAt:new Date().toISOString()});
   const current=await runs.getRun(owner.identity,run.runId);
   await runs.transition(owner.identity,run.runId,'failed',current.revision,lease);
   fixtures.push({runId:run.runId,reservationId:receipt.reservationId});
  }
  await storage.close();storage=null;
  const probe=createServer();await new Promise((resolve,reject)=>probe.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const traceFile=path.join(temp,'invocations.jsonl'),preload=path.join(temp,'fixtures.cjs'),submissionTrace=path.join(temp,'submissions.log'),failAssetFile=path.join(temp,'fail-local-save');
  fs.mkdirSync(path.join(temp,'runtime','workspaces'),{recursive:true});
  fs.writeFileSync(preload,`const Module=require('node:module'),fs=require('node:fs'),load=Module._load;
Module._load=function(name,parent){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>["fixture-chat"]};

if(parent?.filename.endsWith('/server.cjs')&&name==='./model-catalog.cjs')return {...loaded,getCatalog:async()=>({models:[{id:'fixture-chat',scopeId:'fixture-scope',availability:'present',permission:true,localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:['text']},outputModalities:{value:['text']},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],scopeId:'fixture-scope',availability:{status:'available',modelIds:['fixture-chat']},catalogDiagnostics:{state:'fresh',errorCode:null}})};
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/media-route-admission.cjs')return {...loaded,resolveMediaRouteForRun:async input=>{if(input.selection.modelId!=='fixture-video')throw Object.assign(Error('fixture invalid model'),{code:'MANUAL_MODEL_INELIGIBLE'});return {scopeId:'fixture-scope',model:'fixture-video',taskType:input.args.taskType,capabilityRevision:'a'.repeat(64),adapterId:'fixture-video-adapter',adapterVersion:'1',provider:'fixture'};}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./media/pinned-asset-fetch.cjs')return {...loaded,createPinnedAssetFetch:()=>async()=>{if(fs.existsSync(${JSON.stringify(failAssetFile)}))return new Response('fixture invalid media',{headers:{'Content-Type':'text/html'}});const bytes=Buffer.alloc(20);bytes.writeUInt32BE(16);bytes.write('ftypisom',4);return new Response(bytes,{headers:{'Content-Type':'video/mp4'}});}};
if(parent?.filename.endsWith('/server.cjs')&&name==='./tenant.cjs')return {...loaded,runDshForUser:async(uid,question,opts)=>{fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({budgetProfile:opts.budgetProfile})+'\\n');let produced;if(opts.budgetProfile?.startsWith('media:'))produced=await opts.onToolRequest({name:'media.route',requestId:require('node:crypto').randomUUID(),args:{taskType:'text2video',prompt:'fixture'}});return {ok:true,text:'fixture reply',steps:produced?[{name:'media_route',isError:false}]:[],media:produced?[{type:produced.kind,url:produced.url}]:[]};}};
if((parent?.filename.endsWith('/media-run-handler.cjs')&&name==='../../business/media/powertokens.cjs')||(parent?.filename.endsWith('/server.cjs')&&name==='../business/media/powertokens.cjs'))return {...loaded,callMediaRoute:async(ctx,args,opts)=>{await opts.onExternalIntent({provider:'fixture'});await opts.onExternalSubmissionStarted();fs.appendFileSync(${JSON.stringify(submissionTrace)},'submitted\\n');await opts.onExternalResult({outcome:'succeeded',providerStatus:'succeeded'});return {kind:'video',url:'https://cdn.example.test/result.mp4?token=PRIVATE_SENTINEL',taskType:'text2video',model:'fixture-video'};}};
return loaded;};`);
  const launch=()=>spawn(process.execPath,['--require',preload,'shell/server.cjs','--port',String(port)],{cwd:path.resolve('.'),env:{PATH:process.env.PATH,HOME:temp,PT_DB_DIR:options.dataDir,PT_MASTER_KEY_FILE:options.masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_SHELL_PORT:String(port),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0',PT_CHAT_DRYRUN:'1',PT_CONTROLLED_MEDIA_AUTHORIZATION:'1',PT_MEDIA_ASSET_HOSTS:'cdn.example.test',PT_RUNTIME_DIR:path.join(temp,'runtime')},stdio:['ignore','pipe','pipe']});
  child=launch();
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const req=(route,{session=owner,method='GET',body,origin,headers={}}={})=>fetch('http://127.0.0.1:'+port+route,{method,headers:{...headers,...(session?{Cookie:session.cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let ready=false;
  for(let i=0;i<150;i++){
   if(child.exitCode!==null)throw Error(output);
   try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(ready,true,output.slice(-2500));
  const list=f=>'/api/runs/'+f.runId+'/media-reservations';
  const reconcile=(f,extra={})=>req('/api/media-reservations/reconcile',{method:'POST',body:{reservationId:f.reservationId},...extra});
  const [success,unknown]=fixtures;
  assert.equal((await req(list(success),{session:null})).status,401);
  assert.equal((await req(list(success),{session:other})).status,404);
  const discovery=await (await req(list(success))).json();
  assert.equal(discovery.reservations[0].reservationId,success.reservationId);
  assert.equal(discovery.reservations[0].status,'reserved');
  assert.equal(discovery.view.items[0].taskLabel,'文生视频');
  assert.equal(discovery.view.items[0].canRequestReconciliation,true);
  assert.equal(discovery.hasMore,false);
  assert.equal(JSON.stringify(discovery).includes('private-scope'),false);
  assert.equal((await reconcile(success,{session:other})).status,404);
  assert.equal((await reconcile(success,{body:{reservationId:success.reservationId,force:true}})).status,400);
  assert.equal((await reconcile(success,{origin:'https://foreign.example'})).status,403);
  const released=await (await reconcile(success)).json();
  assert.equal(released.decision,'release_allowed');assert.equal(released.grantRemainsConsumed,true);assert.equal(released.mayResubmit,false);
  assert.equal((await (await reconcile(success)).json()).decision,'already_released');
  assert.equal((await (await req(list(success))).json()).reservations[0].status,'released');
  assert.equal((await (await req(list(success))).json()).view.items[0].canRequestReconciliation,false);
  const kept=await (await reconcile(unknown)).json();
  assert.equal(kept.decision,'keep_reserved');assert.equal(kept.reasonCode,'OPERATION_UNRESOLVED');
  assert.equal((await (await req(list(unknown))).json()).reservations[0].status,'reserved');
  // Actual HTTP chat waits while its lease remains alive; explicit consent
  // enters the durable grant store before the tenant/model entry is called.
  assert.equal((await req('/api/auth/key',{method:'POST',body:{key:'fixture-no-paid-key'}})).status,200);
  const conversation=(await (await req('/api/conversations',{method:'POST'})).json()).id;
  const chat=await req('/api/chat',{method:'POST',body:{conversationId:conversation,message:'Generate fixture video',taskType:'text2video'}});
  assert.equal(chat.status,200);const chatRunId=chat.headers.get('x-agent-run-id');assert.ok(chatRunId);
  const stream=chat.text();
  const authorizationUrl='/api/runs/'+chatRunId+'/media-authorization';
  let pending=false;
  for(let i=0;i<100;i++){if((await req(authorizationUrl)).status===200){pending=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(pending,true);assert.equal(fs.existsSync(traceFile),false,'no model call before consent');
  assert.equal((await req(authorizationUrl,{session:other,method:'POST',body:{confirmed:true,modelId:'fixture-video'}})).status,404);
  assert.equal((await req(authorizationUrl,{method:'POST',body:{confirmed:true,modelId:'fixture-video',provider:'forged'}})).status,400);
  assert.equal((await req(authorizationUrl,{method:'POST',body:{confirmed:true,modelId:'not-qualified'}})).status,409);
  assert.equal(fs.existsSync(traceFile),false);
  const approval=await req(authorizationUrl,{method:'POST',body:{confirmed:true,modelId:'fixture-video'}});
  assert.equal(approval.status,200,await approval.clone().text());
  const frames=await stream;assert.match(frames,/media_authorization_required|mediaAuthorization/);assert.match(frames,/"ok":true/);
  assert.equal(JSON.parse(fs.readFileSync(traceFile,'utf8').trim()).budgetProfile,'media:text2video');
  const produced=await (await req('/api/runs/'+chatRunId+'/media-reservations')).json();
  assert.equal(produced.reservations.length,1,'host media handler consumed grant and created durable reservation');
  const finalRun=await (await req('/api/runs/'+chatRunId)).json();
  assert.equal(finalRun.run.state,'completed');assert.equal(finalRun.externalOperations.operations[0].status,'succeeded');
  const reconciled=await reconcile(produced.reservations[0]);assert.equal(reconciled.status,200);
  assert.equal((await reconciled.json()).decision,'release_allowed');
  assert.equal((await req(authorizationUrl,{method:'POST',body:{confirmed:true,modelId:'fixture-video'}})).status,409,'terminal Run cannot be reauthorized');
  const managed=finalRun.managedMedia.media[0];assert.ok(managed.url.startsWith('/api/run-media/'+chatRunId+'/'));assert.equal(managed.type,'video');assert.equal(managed.size,20);
  assert.equal(JSON.stringify(finalRun).includes('PRIVATE_SENTINEL'),false);
  let asset=await req(managed.url);assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),'video/mp4');const assetBytes=Buffer.from(await asset.arrayBuffer());assert.equal(assetBytes.length,20);
  asset=await req(managed.url,{method:'HEAD'});assert.equal(asset.status,200);assert.equal(asset.headers.get('content-length'),'20');
  asset=await req(managed.url,{headers:{Range:'bytes=4-7'}});assert.equal(asset.status,206);assert.equal(await asset.text(),'ftyp');
  assert.equal((await req(managed.url,{session:other})).status,404);assert.equal((await req(managed.url,{session:null})).status,401);
  let history=(await (await req('/api/conversations/'+conversation)).json()).conversation.messages;
  assert.equal(history.find(m=>m.role==='assistant').media[0].url,managed.url);
  // Reopen the actual server with the same isolated DB/runtime, not an in-memory
  // substitute: local bytes and owned history must survive process exit.
  let exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;
  child=launch();child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  ready=false;
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(ready,true);asset=await req(managed.url);assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),assetBytes);
  history=(await (await req('/api/conversations/'+conversation)).json()).conversation.messages;assert.equal(history.find(m=>m.role==='assistant').media[0].url,managed.url);
  assert.equal((await (await req('/api/runs/'+chatRunId)).json()).managedMedia.media[0].sha256,managed.sha256);
  // Upstream success remains succeeded when MIME validation/local publication
  // fails. Replaying the failed Run must not cause a second submission.
  fs.writeFileSync(failAssetFile,'fixture local MIME failure');
  const failedConversation=(await (await req('/api/conversations',{method:'POST'})).json()).id;
  const failedBody={conversationId:failedConversation,message:'Fixture local media failure',taskType:'text2video',idempotencyKey:randomUUID()};
  const failedChat=await req('/api/chat',{method:'POST',body:failedBody}),failedRunId=failedChat.headers.get('x-agent-run-id'),failedStream=failedChat.text();
  const failedAuth='/api/runs/'+failedRunId+'/media-authorization';pending=false;
  for(let i=0;i<100;i++){if((await req(failedAuth)).status===200){pending=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(pending,true);assert.equal((await req(failedAuth,{method:'POST',body:{confirmed:true,modelId:'fixture-video'}})).status,200);
  const failedFrames=await failedStream;assert.match(failedFrames,/"ok":false/);assert.equal(failedFrames.includes('fixture reply'),false);assert.equal(failedFrames.includes('PRIVATE_SENTINEL'),false);
  const failedRun=await (await req('/api/runs/'+failedRunId)).json();assert.equal(failedRun.run.state,'failed');assert.equal(failedRun.externalOperations.operations[0].status,'succeeded');assert.equal(failedRun.managedMedia.media.length,0);
  assert.equal(fs.readFileSync(submissionTrace,'utf8').trim().split('\n').length,2);
  const replay=await req('/api/chat',{method:'POST',body:failedBody});assert.equal(replay.headers.get('x-agent-run-id'),failedRunId);await replay.text();
  assert.equal(fs.readFileSync(submissionTrace,'utf8').trim().split('\n').length,2,'local failure/replay never resubmits');
 }finally{
  if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
  if(storage)await storage.close();
  fs.rmSync(temp,{recursive:true,force:true});
 }
});
