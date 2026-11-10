import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),{createStorage}=require('../../shell/storage/index.cjs'),{createTaskStore}=require('../../shell/tasks/store.cjs'),{createApprovalStore}=require('../../shell/approvals/store.cjs');
const payload=()=>({command:'printf hello',workdir:'.',timeoutMs:10000,maxOutputBytes:64000,policyRevision:'r34-v1'});
test('exact operation approvals use durable identity, lease, expiry and one-time consumption',{timeout:30000},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'operation-approval-'));let storage;
 try{
  storage=await createStorage({dataDir:path.join(tmp,'db'),masterKeyFile:path.join(tmp,'key')});
  const user=(await storage.repositories.auth.register({username:'approval-test',password:'FixturePass123'})).user,identity={userId:user.id,tenantId:user.tenant_id},tasks=createTaskStore(storage.adapter);
  async function fixture(){const conversation=await storage.repositories.conversations.create(user.id),owner='owner-'+randomUUID();let {run}=await tasks.createRun(identity,{conversationId:conversation.id,idempotencyKey:randomUUID(),request:{question:'fixture'}},{owner,ttlMs:120000});run=await tasks.transition(identity,run.runId,'running',run.revision,owner);const scope={db:storage.adapter,identity,runId:run.runId,leaseOwner:owner};return {scope,store:createApprovalStore(scope),run};}
  await t.test('same call same operation is idempotent; changed payload cannot reuse card',async()=>{
   const {store}=await fixture(),a=await store.request({callId:'native-call',payload:payload()}),b=await store.request({callId:'native-call',payload:payload()});assert.equal(a.id,b.id);assert.equal(a.type,'approval');assert.equal(a.approvalState,'pending');assert.match(a.detail,/printf hello/);
   await assert.rejects(store.request({callId:'native-call',payload:{...payload(),command:'printf changed'}}),{code:'APPROVAL_PAYLOAD_MISMATCH'});
   await assert.rejects(store.consume({approvalId:a.id,callId:a.callId,payload:{...payload(),timeoutMs:9999}}),{code:'APPROVAL_PAYLOAD_MISMATCH'});
   assert.equal((await store.consume({approvalId:a.id,callId:a.callId,payload:payload()})).ok,false);
  });
  await t.test('foreign user and tenant cannot read or approve; wrong hash denied',async()=>{
   const {store,scope}=await fixture(),a=await store.request({callId:'native-call',payload:payload()});
   for(const identity of [{...scope.identity,userId:randomUUID()},{...scope.identity,tenantId:randomUUID()}])await assert.rejects(createApprovalStore({...scope,identity}).list(),{code:'NOT_FOUND'});
   await assert.rejects(store.decide({approvalId:a.id,callId:a.callId,payloadSha256:'0'.repeat(64),decision:'approve'}),{code:'APPROVAL_PAYLOAD_MISMATCH'});
  });
  await t.test('two answers and two consumers have one winner; reconnect preserves consumed state',async()=>{
   const {store,scope}=await fixture(),a=await store.request({callId:'native-call',payload:payload()}),other=createApprovalStore(scope),input={approvalId:a.id,callId:a.callId,payloadSha256:a.payloadSha256,decision:'approve'};
   const decisions=await Promise.all([store.decide(input),other.decide(input)]);assert.equal(decisions.filter(r=>r.ok).length,1);
   const consumed=await Promise.all([store.consume({approvalId:a.id,callId:a.callId,payload:payload()}),other.consume({approvalId:a.id,callId:a.callId,payload:payload()})]);assert.equal(consumed.filter(r=>r.ok).length,1);
   assert.equal((await createApprovalStore(scope).request({callId:a.callId,payload:payload()})).approvalState,'consumed');
  });
  await t.test('rejected, expired, cancelled and transferred lease cannot execute',async()=>{
   for(const condition of ['rejected','expired','cancelled','lease']){
    const {store,run}=await fixture(),a=await store.request({callId:'native-call',payload:payload()});
    if(condition==='rejected')await store.decide({approvalId:a.id,callId:a.callId,payloadSha256:a.payloadSha256,decision:'reject'});
    else{await store.decide({approvalId:a.id,callId:a.callId,payloadSha256:a.payloadSha256,decision:'approve'});
     if(condition==='expired')await storage.db.query('UPDATE agent_run_approvals SET deadline=1 WHERE approval_id=$1',[a.id]);
     if(condition==='cancelled')await store.cancel(a.callId);
     if(condition==='lease')await storage.db.query('UPDATE agent_runs SET lease_owner=$1 WHERE run_id=$2',['new-owner',run.runId]);
    }
    const result=await store.consume({approvalId:a.id,callId:a.callId,payload:payload()});assert.equal(result.ok,false,condition);assert.equal(result.approval.approvalState,condition==='lease'?'cancelled':condition);
   }
  });
  await t.test('host approval waiter follows durable decision and in-flight cancellation',async()=>{
   const {createApprovalService}=require('../../shell/approvals/service.cjs'),service=createApprovalService({db:storage.adapter});
   const {store,scope}=await fixture(),controller=new AbortController();
   const pending=service.ask({...scope,args:{callId:'native-wait',payload:payload()},signal:controller.signal});
   let cards;do{cards=(await store.list()).approvals;if(!cards.length)await new Promise(r=>setTimeout(r,2));}while(!cards.length);
   const card=cards[0];await service.decide(identity,scope.runId,card.id,{callId:card.callId,payloadSha256:card.payloadSha256,decision:'approve'});
   const decision=await pending;assert.equal(decision.outcome,'allowed-once');assert.equal(decision.approvalId,card.id);
   const waiting=service.ask({...scope,args:{callId:'native-cancel',payload:payload()},signal:controller.signal});
   while(!(await store.get('native-cancel')))await new Promise(r=>setTimeout(r,2));controller.abort();assert.equal((await waiting).outcome,'cancelled');assert.equal((await store.get('native-cancel')).approvalState,'cancelled');
  });
  await t.test('credential-shaped payload, unbounded resources and unknown fields cannot create approval',async()=>{
   const {store}=await fixture();for(const p of [{...payload(),command:'echo password=secret'},{...payload(),timeoutMs:Infinity},{...payload(),extra:true},{...payload(),maxOutputBytes:0}])await assert.rejects(store.request({callId:'x',payload:p}));assert.equal((await store.list()).approvals.length,0);
  });
 }finally{await storage?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
