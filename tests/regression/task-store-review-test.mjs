import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs');
async function fixture(t){
 assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&process.env[k]),false,'No configured external PG allowed');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-independent-'));const opts={dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')};let storage=await createStorage(opts);
 t.after(async()=>{try{await storage.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 const register=async name=>{const x=await storage.repositories.auth.register({username:name,password:'Fixture123456'});assert.equal(x.ok,true);return {userId:x.user.id,tenantId:x.user.tenant_id};};
 const a=await register('independent-a'),b=await register('independent-b');const conv=await storage.repositories.conversations.create(a.userId);
 const input=(key='key',request={question:'fixture'})=>({conversationId:conv.id,idempotencyKey:key,request});
 return {a,b,conv,input,get storage(){return storage;},store:()=>createTaskStore(storage.adapter),async reopen(){await storage.close();storage=await createStorage(opts);}};
}
test('independent: forged identity/scope and concurrent differing claims remain isolated',async t=>{
 const f=await fixture(t);const s1=f.store(),s2=f.store();
 const attempts=await Promise.allSettled([s1.createRun(f.a,f.input('race',{question:'A'})),s2.createRun(f.a,f.input('race',{question:'B'}))]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.find(x=>x.status==='rejected').reason.code,'IDEMPOTENCY_CONFLICT');
 const id=attempts.find(x=>x.status==='fulfilled').value.run.runId;
 const forged={userId:f.a.userId,tenantId:f.b.tenantId};
 for(const who of [f.b,forged]){
  await assert.rejects(s1.getRun(who,id),{code:'NOT_FOUND'});await assert.rejects(s1.transition(who,id,'running',0),{code:'NOT_FOUND'});
  await assert.rejects(s1.recordExternalIntent(who,id,{provider:'x',operationKey:'x',expectedRevision:0,leaseOwner:'review-worker'}),{code:'NOT_FOUND'});
  assert.equal((await s1.listRuns(who)).runs.length,0);assert.deepEqual(await s1.recoverInterrupted(who),[]);
 }
 await assert.rejects(s1.appendEvent(f.a,id,{conversationId:randomUUID(),type:'delta',payload:{}}),{code:'EVENT_SCOPE_MISMATCH'});
 assert.deepEqual((await s1.eventsAfter(f.a,id)).events.map(x=>x.seq),[1]);
});
test('independent: external intent survives restart and does not create a replacement submission',async t=>{
 const f=await fixture(t);let s=f.store();let r=(await s.createRun(f.a,f.input(),{owner:'review-worker',ttlMs:30000})).run;r=await s.transition(f.a,r.runId,'running',0,'review-worker');
 r=await s.recordExternalIntent(f.a,r.runId,{provider:'fixture',operationKey:'persist-before-send',expectedRevision:r.revision,leaseOwner:'review-worker'});
 await f.reopen();s=f.store();const before=await s.getRun(f.a,r.runId);assert.equal(before.externalOperationKey,'persist-before-send');
 await s.recoverInterrupted(f.a);const recovered=await s.getRun(f.a,r.runId);assert.equal(recovered.externalState,'unknown');
 await s.acquireLease(f.a,r.runId,'review-worker',30000);
 const beforeRejectedReplay=await s.getRun(f.a,r.runId);
 await assert.rejects(s.recordExternalIntent(f.a,r.runId,{provider:'fixture',operationKey:'new-key',expectedRevision:recovered.revision,leaseOwner:'review-worker'}),{code:'EXTERNAL_INTENT_EXISTS'});
 assert.deepEqual(await s.getRun(f.a,r.runId),beforeRejectedReplay);assert.equal((await s.createRun(f.a,f.input())).run.runId,r.runId);
 assert.equal((await f.storage.adapter.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,1);
});
test('independent: startup recovery interrupts abandoned work and preserves user confirmation state',async t=>{
 const f=await fixture(t),s=f.store();
 const queued=(await s.createRun(f.a,f.input('queued-recovery'))).run;
 let running=(await s.createRun(f.a,f.input('running-recovery'))).run;running=await s.transition(f.a,running.runId,'running',running.revision);
 let awaiting=(await s.createRun(f.a,f.input('awaiting-recovery'))).run;awaiting=await s.transition(f.a,awaiting.runId,'running',awaiting.revision);awaiting=await s.transition(f.a,awaiting.runId,'awaiting_confirmation',awaiting.revision);
 const recovered=await s.recoverAllInterrupted();assert.equal(recovered.length,2);
 assert.equal((await s.getRun(f.a,queued.runId)).state,'interrupted');assert.equal((await s.getRun(f.a,running.runId)).state,'interrupted');
 assert.equal((await s.getRun(f.a,awaiting.runId)).state,'awaiting_confirmation','restart must retain the user decision boundary');
});
test('independent: lease recovery preserves live workers and interrupts expired owners',async t=>{
 const f=await fixture(t),s=f.store();const live=(await s.createRun(f.a,f.input('lease-live'))).run;const abandoned=(await s.createRun(f.a,f.input('lease-expired'))).run;
 assert.equal((await s.acquireLease(f.a,live.runId,'worker-a',10000)).acquired,true);
 assert.equal((await s.acquireLease(f.a,abandoned.runId,'worker-b',10000)).acquired,true);
 await f.storage.adapter.query("UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1",[abandoned.runId]);
 const recovered=await s.recoverExpiredLeases();assert.deepEqual(recovered.map(x=>x.runId),[abandoned.runId]);
 assert.equal((await s.getRun(f.a,live.runId)).state,'queued','startup must not interrupt a live lease');
 assert.equal((await s.getRun(f.a,abandoned.runId)).state,'interrupted');
 assert.deepEqual(await s.acquireLease(f.a,abandoned.runId,'worker-c',10000),{acquired:false,run:await s.getRun(f.a,abandoned.runId)});
});
test('independent: event IDs are globally unique and failures preserve next sequence',async t=>{
 const f=await fixture(t),s=f.store();const r=(await s.createRun(f.a,f.input())).run;const r2=(await s.createRun(f.a,f.input('second'))).run;const id=randomUUID();
 await s.appendEvent(f.a,r.runId,{eventId:id,type:'usage',payload:{tokens:null}});
 await assert.rejects(s.appendEvent(f.a,r2.runId,{eventId:id,type:'usage',payload:{tokens:null}}),{code:'EVENT_ID_CONFLICT'});
 const e=await s.appendEvent(f.a,r2.runId,{type:'usage',payload:{tokens:null}});assert.equal(e.seq,2);
});
test('independent: duplicate logical done must not append a second terminal event',async t=>{
 const f=await fixture(t),s=f.store();let r=(await s.createRun(f.a,f.input())).run;r=await s.transition(f.a,r.runId,'running',0);r=await s.transition(f.a,r.runId,'completed',r.revision);
 assert.equal((await s.eventsAfter(f.a,r.runId)).events.filter(x=>x.type==='done').length,1);
 try{await s.appendEvent(f.a,r.runId,{type:'done',payload:{state:'completed'}});}catch(e){assert.ok(['RUN_TERMINAL','EVENT_ALREADY_DONE','EVENT_STATE_MISMATCH','RUN_ALREADY_DONE','TERMINAL_EVENT_EXISTS'].includes(e.code),'duplicate done must be intentionally rejected');}
 assert.equal((await s.eventsAfter(f.a,r.runId)).events.filter(x=>x.type==='done').length,1,'duplicate append must not create second terminal event');
});
test('independent: deleting conversation cannot erase unresolved external intent',async t=>{
 const f=await fixture(t),s=f.store();let r=(await s.createRun(f.a,f.input(),{owner:'review-worker',ttlMs:30000})).run;r=await s.transition(f.a,r.runId,'running',0,'review-worker');r=await s.recordExternalIntent(f.a,r.runId,{provider:'fixture',operationKey:'paid-submit-intent',expectedRevision:r.revision,leaseOwner:'review-worker'});
 try{await f.storage.repositories.conversations.remove(f.a.userId,f.conv.id);}catch(e){assert.ok(['23503','CONVERSATION_HAS_ACTIVE_RUNS','RUN_ACTIVE'].includes(e.code),'delete must be intentionally blocked');return;}
 const rows=(await f.storage.adapter.query('SELECT run_id,external_operation_key FROM agent_runs WHERE run_id=$1',[r.runId])).rows;
 assert.equal(rows.length,1,'conversation cascade deleted durable paid-operation intent');assert.equal(rows[0].external_operation_key,'paid-submit-intent');
});
test('independent: unknown submission retains executor lease until terminal settlement',async t=>{
 const f=await fixture(t),s=f.store(),owner='submission-owner';
 let r=(await s.createRun(f.a,f.input(),{owner,ttlMs:30000})).run;
 r=await s.transition(f.a,r.runId,'running',r.revision,owner);
 r=await s.recordExternalIntent(f.a,r.runId,{provider:'fixture',operationKey:'unknown-preserve',expectedRevision:r.revision,leaseOwner:owner});
 await assert.rejects(s.recordExternalReconciliation(f.a,r.runId,{expectedRevision:r.revision,leaseOwner:owner,outcome:'provider_state_unknown',observedAt:new Date().toISOString(),preserveLease:true}),{code:'CONTRACT_INVALID'});
 r=await s.recordExternalReconciliation(f.a,r.runId,{expectedRevision:r.revision,leaseOwner:owner,outcome:'unknown_submission',observedAt:new Date().toISOString(),preserveLease:true});
 assert.equal(r.externalState,'manual_check');
 await s.renewLease(f.a,r.runId,owner,30000);
 r=await s.transition(f.a,r.runId,'failed',r.revision,owner);
 assert.equal(r.reconciliation,'needs_reconciliation');
 assert.equal((await f.storage.adapter.query('SELECT lease_owner FROM agent_runs WHERE run_id=$1',[r.runId])).rows[0].lease_owner,null);
 assert.equal((await s.claimExternalReconciliation(f.a,r.runId,'other-worker')).acquired,false);
});
