import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createMediaRunHandler}=require('../../shell/tasks/media-run-handler.cjs');
const identity={userId:'u',tenantId:'t'};
const response=(data)=>({ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)});
function fixture(fetchImpl,{intentError=false,taskFailures=0,resultFailures=0,cancelAfterIntent=false}={}) {
 const calls=[];let resultAudit=null;let row={revision:0,state:'running',externalTaskId:null,reconciliation:'none'};
 const controller=new AbortController();
 const taskRun={runId:'r',leaseOwner:'owner',signal:controller.signal};
 const store={
  async getRun(who,id){assert.deepEqual(who,identity);assert.equal(id,'r');return {...row};},
  async recordExternalIntent(who,id,args){calls.push('intent');if(intentError)throw Error('DB failed');assert.equal(args.expectedRevision,row.revision);row={...row,revision:row.revision+1,state:'waiting_external',externalOperationKey:args.operationKey,reconciliation:'needs_reconciliation'};if(cancelAfterIntent)controller.abort();},
  async recordExternalTaskId(who,id,args){calls.push('task');if(taskFailures-->0)throw Error('DB failed');row={...row,revision:row.revision+1,externalTaskId:args.taskId,externalState:'accepted'};},
  async recordExternalSubmissionResult(who,id,args){calls.push('result');if(resultFailures-->0)throw Error('result write failed');resultAudit={...args};row={...row,revision:row.revision+1,reconciliation:'resolved',externalState:args.outcome,reason:args.reason};},
  async recordExternalReconciliation(who,id,args){calls.push('manual');assert.equal(args.preserveLease,true);assert.equal(args.outcome,'unknown_submission');row={...row,revision:row.revision+1,externalState:'manual_check'};},
 };
 store.externalOperations={
  createIntent:async(who,id,args)=>{await store.recordExternalIntent(who,id,{...args,expectedRevision:row.revision});row.externalState='submitting';},
  recordTaskId:(who,id,key,args)=>store.recordExternalTaskId(who,id,args),
  recordSubmissionResult:(who,id,key,args)=>store.recordExternalSubmissionResult(who,id,args),
  markUnknownSubmission:(who,id,key,args)=>store.recordExternalReconciliation(who,id,{...args,preserveLease:true,outcome:'unknown_submission'}),
  get:async()=>({taskId:row.externalTaskId,status:row.externalState}),
 };
 const handler=createMediaRunHandler({store,identity,taskRun,loadCredential:async()=> 'fake-key',fetchImpl:async(url,init)=>{calls.push(init.method||'GET');return fetchImpl(url,init);}});
 const request={requestId:randomUUID(),name:'media.route',args:{taskType:'text2image',prompt:'controlled fixture'}};
 return {handler,request,calls,controller,row:()=>row,resultAudit:()=>resultAudit};
}
test('real media executor persists intent before POST and sync result before completion',async()=>{
 const f=fixture(async()=>response({data:[{url:'https://result.invalid/image.png'}]}));
 const result=await f.handler.handle(f.request);await f.handler.drain();
 assert.equal(result.url,'https://result.invalid/image.png');
 assert.deepEqual(f.calls,['intent','POST','result']);assert.equal(f.row().reconciliation,'resolved');
 assert.equal(f.resultAudit().queried,false,'direct synchronous result has no provider task polling');
});
test('taskId-backed host success records that provider status was polled',async()=>{
 let requests=0;
 const f=fixture(async()=>{
  requests++;
  return requests===1
   ? response({task_id:'task-polled-1'})
   : response({status:'completed',data:[{url:'https://result.invalid/polled.png'}]});
 });
 const result=await f.handler.handle(f.request);await f.handler.drain();
 assert.equal(result.url,'https://result.invalid/polled.png');
 assert.deepEqual(f.calls,['intent','POST','task','GET','result']);
 assert.equal(f.resultAudit().queried,true,'successful taskId path polls provider before host result persistence');
 assert.equal(f.resultAudit().outcome,'succeeded');
});
test('taskId-polled result write retry preserves queried=true',async()=>{
 let requests=0;
 const f=fixture(async()=>{
  requests++;
  return requests===1
   ? response({task_id:'task-result-retry-1'})
   : response({status:'completed',data:[{url:'https://result.invalid/retried.png'}]});
 },{resultFailures:1});
 const result=await f.handler.handle(f.request);await f.handler.drain();
 assert.equal(result.url,'https://result.invalid/retried.png','a recovered durable result returns the already-computed media result');
 assert.deepEqual(f.calls,['intent','POST','task','GET','result','result']);
 assert.equal(f.resultAudit().queried,true,'the successful retry retains the original polled-result evidence');
 assert.equal(f.resultAudit().outcome,'succeeded');
 assert.equal(f.row().externalTaskId,'task-result-retry-1');
 assert.equal(f.row().externalState,'succeeded','successful retry leaves the persisted operation terminal');
 assert.equal(f.row().reconciliation,'resolved');
});
test('taskId-polled result remains an error when both durable writes fail',async()=>{
 let requests=0;
 const f=fixture(async()=>{
  requests++;
  return requests===1
   ? response({task_id:'task-result-fail-1'})
   : response({status:'completed',data:[{url:'https://result.invalid/not-acknowledged.png'}]});
 },{resultFailures:2});
 await assert.rejects(f.handler.handle(f.request),/result write failed/);await f.handler.drain();
 assert.deepEqual(f.calls,['intent','POST','task','GET','result','result']);
 assert.equal(f.resultAudit(),null,'no durable result acknowledgement was recorded');
 assert.equal(f.row().externalTaskId,'task-result-fail-1','known task ID remains available for background reconciliation');
 assert.equal(f.row().externalState,'accepted','failed result writes do not falsely mark the operation terminal or manual');
 assert.equal(f.row().reconciliation,'needs_reconciliation');
 assert.equal(f.row().state,'waiting_external');
});
test('direct sync callback failure remains an error without a returned media result',async()=>{
 const f=fixture(async()=>response({data:[{url:'https://result.invalid/direct-callback.png'}]}),{resultFailures:2});
 await assert.rejects(f.handler.handle(f.request),error=>error.code==='EXTERNAL_RESULT_CALLBACK_FAILED');
 await f.handler.drain();
 assert.deepEqual(f.calls,['intent','POST','result','result','manual']);
 assert.equal(f.resultAudit(),null,'the failed callback has no successful durable result acknowledgement');
 assert.equal(f.row().externalState,'manual_check');
});
test('failed durable intent prevents any provider POST',async()=>{
 const f=fixture(async()=>{throw Error('must not call');},{intentError:true});
 await assert.rejects(f.handler.handle(f.request));assert.deepEqual(f.calls,['intent']);
});
test('ambiguous POST becomes manual review while preserving executor lease',async()=>{
 const f=fixture(async()=>{throw Error('connection lost');});
 await assert.rejects(f.handler.handle(f.request));await f.handler.drain();
 assert.deepEqual(f.calls,['intent','POST','manual']);assert.equal(f.row().externalState,'manual_check');
});
test('taskId acknowledgement retries persistence only, never POST or polling',async()=>{
 const f=fixture(async()=>response({task_id:'task-1'}),{taskFailures:1});
 await assert.rejects(f.handler.handle(f.request));
 assert.deepEqual(f.calls,['intent','POST','task','task']);assert.equal(f.row().externalTaskId,'task-1');
});
test('drain waits for late taskId after local cancellation',async()=>{
 let release,started;const sent=new Promise(resolve=>{started=resolve;});
 const post=new Promise(resolve=>{release=resolve;});
 const f=fixture(async()=>{started();return post;});
 const operation=f.handler.handle(f.request);const rejected=assert.rejects(operation);
 await sent;f.controller.abort();
 let drained=false;const draining=f.handler.drain().then(()=>{drained=true;});
 await Promise.resolve();assert.equal(drained,false);
 release(response({task_id:'late-task'}));
 await Promise.all([rejected,draining]);
 assert.equal(f.row().externalTaskId,'late-task');assert.equal(drained,true);
 assert.deepEqual(f.calls,['intent','POST','task']);
});
test('unapproved RPC names and pre-cancelled requests never submit',async()=>{
 const f=fixture(async()=>{throw Error('must not call');});
 await assert.rejects(f.handler.handle({...f.request,name:'arbitrary.tool'}),{code:'TOOL_NOT_ALLOWED'});
 f.controller.abort();await assert.rejects(f.handler.handle(f.request),{code:'SESSION_ABORTED'});
 assert.deepEqual(f.calls,[]);
});
test('cancel between intent commit and POST records definite non-submission',async()=>{
 const f=fixture(async()=>{throw Error('must not submit');},{cancelAfterIntent:true});
 await assert.rejects(f.handler.handle(f.request));await f.handler.drain();
 assert.deepEqual(f.calls,['intent','result']);
 assert.equal(f.row().externalState,'cancelled');assert.equal(f.row().reconciliation,'resolved');
 assert.equal(f.row().reason,'not_submitted');
});
test('durable host handler supports two paid operations in one Run with ordered events',async(t)=>{
 const {createStorage}=require('../../shell/storage/index.cjs');
 const {createTaskStore}=require('../../shell/tasks/store.cjs');
 assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&process.env[k]),false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-host-operations-'));
 const storage=await createStorage({dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')});
 t.after(async()=>{try{await storage.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 const registered=await storage.repositories.auth.register({username:'media-host-fixture',password:'Fixture123456'});
 const who={userId:registered.user.id,tenantId:registered.user.tenant_id};
 const conversation=await storage.repositories.conversations.create(who.userId);
 const store=createTaskStore(storage.adapter),owner='host-fixture';
 let run=(await store.createRun(who,{conversationId:conversation.id,idempotencyKey:'multi',request:{}},{owner,ttlMs:30000})).run;
 run=await store.transition(who,run.runId,'running',run.revision,owner);
 let posts=0;
 const host=createMediaRunHandler({store,identity:who,taskRun:{runId:run.runId,leaseOwner:owner,signal:new AbortController().signal},loadCredential:async()=> 'fake-key',fetchImpl:async(url,init)=>{
  assert.equal(init.method,'POST');posts++;return response({data:[{url:'https://result.invalid/'+posts+'.png'}]});
 }});
 const request=()=>({requestId:randomUUID(),name:'media.route',args:{taskType:'text2image',prompt:'controlled fixture'}});
 const a=request(),b=request();
 await Promise.all([host.handle(a),host.handle(b)]);await host.drain();
 assert.equal(posts,2);
 for(const req of [a,b])assert.equal((await store.externalOperations.get(who,run.runId,run.runId+':'+req.requestId)).status,'succeeded');
 await assert.rejects(host.handle(a),error=>error.code==='EXTERNAL_INTENT_CALLBACK_FAILED'&&error.cause?.code==='EXTERNAL_OPERATION_EXISTS');
 assert.equal(posts,2,'replayed intent must never authorize another POST');
 const events=(await store.eventsAfter(who,run.runId)).events;
 assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));
 assert.equal((await storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1',[run.runId])).rows[0].lease_owner,owner);
});
