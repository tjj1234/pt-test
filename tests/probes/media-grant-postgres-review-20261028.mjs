// Opt-in disposable-localhost PG probe. No DSN or provider input is printed.
// Run only with PT_PG_DSN and MEDIA_GRANT_POSTGRES_FIXTURE set as documented
// below. This file never creates/drops a database and never contacts a provider.
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
const MARKER='disposable-media-grants-20261028';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function safeConfiguration(){
  assert.equal(process.env.MEDIA_GRANT_POSTGRES_FIXTURE,MARKER,'explicit disposable fixture marker required');
  assert.ok(process.env.PT_PG_DSN,'isolated fixture DSN required');
  let parsed;try{parsed=new URL(process.env.PT_PG_DSN);}catch{throw Error('invalid fixture configuration');}
  assert.ok(['postgres:','postgresql:'].includes(parsed.protocol));
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'localhost fixture required');
  assert.ok(/^\/[a-zA-Z0-9_]*fixture[a-zA-Z0-9_]*$/.test(parsed.pathname),'database name must contain fixture');
  assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&k!=='PT_PG_DSN'&&process.env[k]),false,'no alternate PostgreSQL configuration allowed');
}
async function main(){
  safeConfiguration(); // All checks happen before opening any connection.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-grant-pg-review-'));
  const options=suffix=>({dataDir:path.join(dir,suffix),masterKeyFile:path.join(dir,'key-'+suffix)});
  let a,b,pendingA,pendingB,release;
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    a=await createStorage(options('a'));b=await createStorage(options('b'));
    assert.equal(a.db.adapter,'pg');assert.equal(b.db.adapter,'pg');
    let runsA=createTaskStore(a.adapter);const runsB=createTaskStore(b.adapter);
    const user=(await a.repositories.auth.register({username:'grant-pg-'+randomUUID(),password:'FixturePass123'})).user;
    const identity={userId:user.id,tenantId:user.tenant_id};
    const conv=await a.repositories.conversations.create(identity.userId);
    const owner='fixture-owner-'+randomUUID();
    async function run(){let r=(await runsA.createRun(identity,{conversationId:conv.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'grant fixture'}},{owner,ttlMs:300000})).run;return runsA.transition(identity,r.runId,'running',r.revision,owner);}
    const scope='fixture-'+randomUUID();
    const common={credentialScopeId:scope,modelId:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',provider:'powertokens-video'};
    const intent=store=>({tx,identity,runId,...args})=>store.externalOperations.createIntentInTransaction(tx,identity,runId,args);
    const normalA=createMediaGrantStoreCandidate(a.adapter,{recordIntent:intent(runsA)});
    const normalB=createMediaGrantStoreCandidate(b.adapter,{recordIntent:intent(runsB)});
    const r1=await run(),r2=await run(),r3=await run();
    const issue=(store,r,model=common.modelId)=>store.issue(identity,{...common,modelId:model,grantId:'fixture-'+randomUUID(),runId:r.runId,runLeaseOwner:owner,expiresAt:new Date(Date.now()+300000).toISOString()});
    const g1=await issue(normalA,r1),g2=await issue(normalB,r2),g3=await issue(normalA,r3,'rollback-video');
    const entry=g=>({...common,modelId:g.modelId,grantId:g.grantId,runId:g.runId,...identity,runLeaseOwner:owner,operationKey:g.runId+':'+randomUUID()});
    const e1=entry(g1),e2=entry(g2),e3=entry(g3);
    let pidA,pidB,entered;
    const reached=new Promise(resolve=>{entered=resolve;});
    const gatedA=createMediaGrantStoreCandidate(a.adapter,{recordIntent:async args=>{
      pidA=(await args.tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const value=await intent(runsA)(args);entered();await gate;return value;
    }});
    // Capture B's actual transaction backend before it attempts the conflicting
    // unique slot insert. A is still uncommitted, so only a real DB lock can
    // serialize these two independent transactions.
    const observedB={...b.adapter,transaction:cb=>b.adapter.transaction(async tx=>{
      pidB=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return cb(tx);
    })};
    const contender=createMediaGrantStoreCandidate(observedB,{recordIntent:intent(runsB)});
    pendingA=gatedA.reserveAttempt(identity,e1).then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
    await Promise.race([reached,delay(5000).then(()=>{throw Error('first transaction did not reach barrier');})]);
    let bSettled=false;
    pendingB=contender.reserveAttempt(identity,e2).then(value=>({ok:true,value}),error=>({ok:false,code:error.code})).finally(()=>{bSettled=true;});
    let blocked=false,observedWait=null;
    for(let i=0;i<100;i++){
      if(pidB){
        const {rows}=await a.adapter.query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',[pidB]);
        if(rows[0]?.wait_event_type==='Lock'&&rows[0].blockers.includes(pidA)){blocked=true;observedWait=rows[0].wait_event_type;break;}
      }
      await delay(25);
    }
    assert.equal(blocked,true,'real PostgreSQL lock blocking must be observed');
    assert.notEqual(pidA,pidB,'transactions must use distinct backend connections');
    assert.equal(bSettled,false,'loser must be waiting before winner commits');
    release();const [winner,loser]=await Promise.all([pendingA,pendingB]);
    assert.equal(winner.ok,true);assert.equal(winner.value.intentRecorded,true);
    assert.deepEqual(loser,{ok:false,code:'MEDIA_RESERVATION_CONFLICT'});
    assert.equal((await normalA.getGrant(identity,r1.runId,g1.grantId)).consumed,true);
    assert.equal((await normalB.getGrant(identity,r2.runId,g2.grantId)).consumed,false);
    assert.equal((await runsA.externalOperations.get(identity,r1.runId,e1.operationKey)).status,'submitting');
    await assert.rejects(runsB.externalOperations.get(identity,r2.runId,e2.operationKey),{code:'NOT_FOUND'});
    const rollback=createMediaGrantStoreCandidate(a.adapter,{recordIntent:async args=>{await intent(runsA)(args);throw Error('fixture rollback');}});
    await assert.rejects(rollback.reserveAttempt(identity,e3),/fixture rollback/);
    assert.equal((await normalA.getGrant(identity,r3.runId,g3.grantId)).consumed,false);
    assert.equal((await a.adapter.query('SELECT * FROM controlled_media_reservations WHERE grant_id=$1',[g3.grantId])).rows.length,0);
    await assert.rejects(runsA.externalOperations.get(identity,r3.runId,e3.operationKey),{code:'NOT_FOUND'});
    assert.equal((await runsA.getRun(identity,r3.runId)).state,'running');
    assert.equal((await runsA.eventsAfter(identity,r3.runId)).events.some(e=>e.payload?.operationKey===e3.operationKey),false);
    await a.close();a=await createStorage(options('reopened'));runsA=createTaskStore(a.adapter);
    const reopened=createMediaGrantStoreCandidate(a.adapter,{recordIntent:intent(runsA)});
    assert.equal((await reopened.getGrant(identity,r1.runId,g1.grantId)).consumed,true);
    await assert.rejects(reopened.reserveAttempt(identity,e2),{code:'MEDIA_RESERVATION_CONFLICT'});
    assert.equal((await reopened.getGrant(identity,r2.runId,g2.grantId)).consumed,false);
    console.log(JSON.stringify({ok:true,backend:'postgresql',distinctTransactionBackends:true,observedWait,blockingVerified:true,successfulReservations:1,conflictingReservations:1,loserUnconsumedWithoutIntent:true,callbackRollback:'grant+slot+intent+event',reopenUnknownSlot:'retained',providerCalls:0}));
  }finally{
    release();await Promise.allSettled([pendingA,pendingB].filter(Boolean));
    await Promise.allSettled([a?.close(),b?.close()]);fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:typeof error?.code==='string'?error.code:'MEDIA_GRANT_PG_REVIEW_FAILED'}));process.exitCode=1;});
