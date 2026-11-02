// Explicit disposable-localhost PostgreSQL probe. No provider calls or DB
// creation/drop. Do not execute without the fixture marker and isolated DSN.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs');
const {createMediaGrantStoreCandidate}=require('../../shell/tasks/media-grant-store-candidate.cjs');
const {createMediaReservationReleaseCandidate}=require('../../shell/tasks/media-reservation-release-candidate.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function checkFixture(){
 assert.equal(process.env.MEDIA_RELEASE_POSTGRES_FIXTURE,'disposable-media-release-20261028','explicit fixture marker required');
 assert.ok(process.env.PT_PG_DSN,'isolated fixture DSN required');
 let u;try{u=new URL(process.env.PT_PG_DSN);}catch{throw Error('invalid fixture configuration');}
 assert.ok(['postgres:','postgresql:'].includes(u.protocol));
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
 assert.ok(/^\/[a-zA-Z0-9_]*fixture[a-zA-Z0-9_]*$/.test(u.pathname));
 assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&k!=='PT_PG_DSN'&&process.env[k]),false);
}
async function main(){
 checkFixture();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-release-pg-review-'));
 const options=s=>({dataDir:path.join(dir,s),masterKeyFile:path.join(dir,s+'-key')});
 let a,b,pendingA,pendingB,release;
 const gate=new Promise(resolve=>{release=resolve;});
 try{
  a=await createStorage(options('a'));b=await createStorage(options('b'));
  assert.equal(a.db.adapter,'pg');assert.equal(b.db.adapter,'pg');
  let runsA=createTaskStore(a.adapter);const runsB=createTaskStore(b.adapter);
  const u=(await a.repositories.auth.register({username:'release-pg-'+randomUUID(),password:'FixturePass123'})).user;
  const identity={userId:u.id,tenantId:u.tenant_id},owner='fixture-'+randomUUID();
  const conv=await a.repositories.conversations.create(identity.userId);
  const recordIntent=store=>({tx,identity,runId,...args})=>store.externalOperations.createIntentInTransaction(tx,identity,runId,args);
  let grantsA=createMediaGrantStoreCandidate(a.adapter,{recordIntent:recordIntent(runsA)});
  const grantsB=createMediaGrantStoreCandidate(b.adapter,{recordIntent:recordIntent(runsB)});
  const common={credentialScopeId:'fixture-'+randomUUID(),modelId:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',provider:'powertokens-video'};
  async function fixture(store=grantsA,model=common.modelId){
   let run=(await runsA.createRun(identity,{conversationId:conv.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'release fixture'}},{owner,ttlMs:300000})).run;
   run=await runsA.transition(identity,run.runId,'running',run.revision,owner);
   const grant=await store.issue(identity,{...common,modelId:model,grantId:'grant-'+randomUUID(),runId:run.runId,runLeaseOwner:owner,expiresAt:new Date(Date.now()+300000).toISOString()});
   return {run,grant,entry:{...common,modelId:model,...identity,grantId:grant.grantId,runId:run.runId,runLeaseOwner:owner,operationKey:run.runId+':'+randomUUID()}};
  }
  async function succeeded(f){await runsA.externalOperations.recordSubmissionResult(identity,f.run.runId,f.entry.operationKey,{outcome:'succeeded',providerStatus:'succeeded',queried:false,runLeaseOwner:owner,observedAt:new Date().toISOString()});}
  const old=await fixture(),next=await fixture(grantsB);
  old.receipt=await grantsA.reserveAttempt(identity,old.entry);await succeeded(old);
  const timing=(await a.adapter.query('SELECT r.reserved_at,o.updated_at,o.last_query FROM controlled_media_reservations r JOIN run_external_operations o ON o.operation_key=r.operation_key WHERE r.reservation_id=$1',[old.receipt.reservationId])).rows[0];
  console.error(JSON.stringify({fixtureClockDeltasMs:{updatedMinusReserved:new Date(timing.updated_at)-new Date(timing.reserved_at),observedMinusReserved:new Date(timing.last_query.observedAt)-new Date(timing.reserved_at),updatedMinusObserved:new Date(timing.updated_at)-new Date(timing.last_query.observedAt)}}));
  let entered,pidA,pidB;
  const reached=new Promise(resolve=>{entered=resolve;});
  const gatedAdapter={...a.adapter,transaction:cb=>a.adapter.transaction(async tx=>cb({...tx,query:async(sql,args)=>{
   const result=await tx.query(sql,args);
   if(sql.startsWith("UPDATE controlled_media_reservations SET status='released'")){
    pidA=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;entered();await gate;
   }return result;
  }}))};
  const releasing=createMediaReservationReleaseCandidate(gatedAdapter);
  pendingA=releasing.reconcile(identity,{reservationId:old.receipt.reservationId}).then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
  let barrierTimer;
  try{await Promise.race([reached,pendingA.then(result=>{throw Object.assign(new Error("release ended before barrier"),{code:result.code || "RELEASE_BARRIER_NOT_REACHED"});}),new Promise((_,reject)=>{barrierTimer=setTimeout(()=>reject(Error('release barrier timeout')),5000);})]);}finally{clearTimeout(barrierTimer);}
  const observedB={...b.adapter,transaction:cb=>b.adapter.transaction(async tx=>{
   pidB=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return cb(tx);
  })};
  const contender=createMediaGrantStoreCandidate(observedB,{recordIntent:recordIntent(runsB)});
  let bSettled=false;
  pendingB=contender.reserveAttempt(identity,next.entry).then(value=>({ok:true,value}),error=>({ok:false,code:error.code})).finally(()=>{bSettled=true;});
  let blockingVerified=false;
  for(let i=0;i<120;i++){
   if(pidB){const {rows}=await a.adapter.query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',[pidB]);if(rows[0]?.wait_event_type==='Lock'&&rows[0].blockers.includes(pidA)){blockingVerified=true;break;}}
   await delay(25);
  }
  assert.equal(blockingVerified,true,'contender must block on uncommitted release');assert.notEqual(pidA,pidB);assert.equal(bSettled,false);
  release();const [released,reserved]=await Promise.all([pendingA,pendingB]);
  assert.equal(released.ok,true);assert.equal(released.value.decision,'release_allowed');assert.equal(reserved.ok,true);assert.equal(reserved.value.intentRecorded,true);
  const history=(await a.adapter.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1',[old.receipt.reservationId])).rows[0];
  assert.equal(history.status,'released');assert.equal(history.release_reason,'OPERATION_TERMINAL_SUCCEEDED');assert.ok(history.release_operation_id);assert.ok(history.released_at);assert.equal(history.released_by,identity.userId);
  assert.equal((await grantsA.getGrant(identity,old.run.runId,old.grant.grantId)).consumed,true);
  const ordinary=createMediaReservationReleaseCandidate(a.adapter);
  const nextId=reserved.value.reservationId;
  // Keep the actual intent timestamps, including now() preceding reserved_at.
  const before=(await a.adapter.query('SELECT updated_at FROM run_external_operations WHERE operation_key=$1',[next.entry.operationKey])).rows[0].updated_at;
  assert.equal((await ordinary.reconcile(identity,{reservationId:nextId})).decision,'keep_reserved');
  const after=(await a.adapter.query('SELECT updated_at FROM run_external_operations WHERE operation_key=$1',[next.entry.operationKey])).rows[0].updated_at;
  assert.equal(new Date(after).toISOString(),new Date(before).toISOString(),'pending reconciliation never rewrites timestamp evidence');
  await runsB.externalOperations.markUnknownSubmission(identity,next.run.runId,next.entry.operationKey,{reason:'submission_response_unknown',runLeaseOwner:owner,observedAt:new Date().toISOString()});
  assert.equal((await ordinary.reconcile(identity,{reservationId:nextId})).decision,'keep_reserved');assert.ok(before);
  const rollback=await fixture(grantsA,'rollback-video');rollback.receipt=await grantsA.reserveAttempt(identity,rollback.entry);await succeeded(rollback);
  const bad={transaction:cb=>a.adapter.transaction(tx=>cb({...tx,query:async(sql,args)=>{
   const result=await tx.query(sql,args);if(sql.startsWith("UPDATE controlled_media_reservations SET status='released'"))throw Error('fixture rollback');return result;
  }}))};
  await assert.rejects(createMediaReservationReleaseCandidate(bad).reconcile(identity,{reservationId:rollback.receipt.reservationId}),/fixture rollback/);
  const rolled=(await a.adapter.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1',[rollback.receipt.reservationId])).rows[0];
  assert.equal(rolled.status,'reserved');for(const k of ['released_at','release_reason','release_operation_id','released_by'])assert.equal(rolled[k],null);
  await a.close();a=await createStorage(options('reopened'));runsA=createTaskStore(a.adapter);grantsA=createMediaGrantStoreCandidate(a.adapter,{recordIntent:recordIntent(runsA)});
  const reopened=createMediaReservationReleaseCandidate(a.adapter);
  assert.equal((await reopened.reconcile(identity,{reservationId:old.receipt.reservationId})).decision,'already_released');
  assert.equal((await reopened.reconcile(identity,{reservationId:nextId})).decision,'keep_reserved');
  assert.equal((await grantsA.getGrant(identity,old.run.runId,old.grant.grantId)).consumed,true);
  const retained=(await a.adapter.query('SELECT status,release_reason FROM controlled_media_reservations WHERE reservation_id=$1',[rollback.receipt.reservationId])).rows[0];assert.equal(retained.status,'reserved');assert.equal(retained.release_reason,null);
  console.log(JSON.stringify({ok:true,backend:'postgresql',distinctTransactionBackends:true,observedWait:'Lock',blockingVerified,releaseThenNewReservation:'committed',oldGrant:'consumed',historyAudit:'retained',unknown:'reserved',rollback:'status+audit',reopen:'persistent',providerCalls:0}));
 }finally{release();await Promise.allSettled([pendingA,pendingB].filter(Boolean));await Promise.allSettled([a?.close(),b?.close()]);fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:typeof error?.code==='string'?error.code:'MEDIA_RELEASE_PG_REVIEW_FAILED'}));process.exitCode=1;});
