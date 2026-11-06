import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs');
const {createQuestionStore}=require('../../shell/questions/store.cjs');
const {createQuestionManager}=require('../../shell/questions/manager.cjs');
const {createQuestionService}=require('../../shell/questions/service.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('production question authority: scope, transactions, deadline, workers and cleanup', {timeout:30000},async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'questions-authority-'));let storage;
  try{
    storage=await createStorage({dataDir:path.join(tmp,'db'),masterKeyFile:path.join(tmp,'key')});
    const registered=await storage.repositories.auth.register({username:'questions-user',password:'FixturePass123'});
    const identity={userId:registered.user.id,tenantId:registered.user.tenant_id},db=storage.adapter,tasks=createTaskStore(db);
    async function fixture(){
      const conv=await storage.repositories.conversations.create(identity.userId),leaseOwner='q-owner-'+randomUUID();
      const run=(await tasks.createRun(identity,{conversationId:conv.id,idempotencyKey:randomUUID(),request:{question:'fixture'}},{owner:leaseOwner,ttlMs:120000})).run;
      await tasks.transition(identity,run.runId,'running',run.revision,leaseOwner);
      const scope={db,identity,runId:run.runId,callId:'native-call-1',leaseOwner};
      const store=createQuestionStore(scope),manager=createQuestionManager({...identity,runId:run.runId,store});
      return {scope,store,manager,run};
    }
    await t.test('another worker answers; original waiter follows DB terminal',async()=>{
      const {scope,store,manager}=await fixture();
      const waiting=manager.askQuestion('same-id',{question:'Choose',callId:scope.callId,timeoutMs:1000});
      while(!(await store.get('same-id')))await pause(1);
      const other=createQuestionManager({...identity,runId:scope.runId,store:createQuestionStore({...scope,leaseOwner:undefined})});
      assert.equal((await other.submitAnswer('same-id','yes',{respondentTenantId:identity.tenantId,respondentUserId:identity.userId})).ok,true);
      assert.equal((await waiting).answer,'yes');
      assert.equal((await store.get('same-id')).status,'answered');
    });
    await t.test('same question IDs across Runs are independent and foreign owner cannot read',async()=>{
      const a=await fixture(),b=await fixture();
      const ap=a.manager.askQuestion('q',{question:'A',callId:a.scope.callId,timeoutMs:2000});ap.catch(()=>{});
      const bp=b.manager.askQuestion('q',{question:'B',callId:b.scope.callId,timeoutMs:2000});bp.catch(()=>{});
      while(!(await a.store.get('q')) || !(await b.store.get('q')))await pause(1);
      assert.equal((await a.store.get('q')).question,'A');assert.equal((await b.store.get('q')).question,'B');
      const foreign=createQuestionStore({...a.scope,identity:{userId:randomUUID(),tenantId:identity.tenantId}});
      await assert.rejects(foreign.get('q'),{code:'NOT_FOUND'});
      await a.manager.cancelRun('cleanup');await b.manager.cancelRun('cleanup');await Promise.allSettled([ap,bp]);
    });
    await t.test('expiry persists; late answer is rejected and reopening retains timeout',async()=>{
      const {scope,store,manager}=await fixture();
      const p=manager.askQuestion('deadline',{question:'Answer soon',callId:scope.callId,timeoutMs:40});
      await assert.rejects(p,{code:'QUESTION_TIMEOUT'});
      assert.equal((await store.get('deadline')).status,'expired');
      const reopened=createQuestionManager({...identity,runId:scope.runId,store});
      await assert.rejects(reopened.askQuestion('deadline',{question:'Answer soon',callId:scope.callId,timeoutMs:40}),{code:'QUESTION_TIMEOUT'});
    });
    await t.test('cancel tombstone blocks later creation, without changing another Run',async()=>{
      const a=await fixture(),b=await fixture();await a.manager.cancelRun('stop');
      const reopened=createQuestionManager({...identity,runId:a.scope.runId,store:a.store});
      await assert.rejects(reopened.askQuestion('after',{question:'No',callId:a.scope.callId}),{code:'QUESTION_CANCELLED'});
      assert.equal((await b.store.isRunCancelled(b.scope.runId,identity.tenantId)).cancelled,false);
    });
    await t.test('concurrent answer CAS has exactly one winner',async()=>{
      const {scope,store,manager}=await fixture();const p=manager.askQuestion('race',{question:'Race',callId:scope.callId,timeoutMs:1000});
      while(!(await store.get('race')))await pause(1);
      const make=()=>createQuestionManager({...identity,runId:scope.runId,store:createQuestionStore(scope)});
      const results=await Promise.all([make().submitAnswer('race','one',{respondentTenantId:identity.tenantId,respondentUserId:identity.userId}),make().submitAnswer('race','two',{respondentTenantId:identity.tenantId,respondentUserId:identity.userId})]);
      assert.equal(results.filter(r=>r.ok).length,1);assert.equal((await p).answer,(await store.get('race')).answer);
    });
    await t.test('host service uses durable owner API and closes approval early',async()=>{
      const {scope}=await fixture(),service=createQuestionService({db});
      await assert.rejects(service.ask({...scope,args:{callId:'approval',questions:[{id:'q',question:'Approve',intent:{kind:'plan-review'}}]}}),{code:'APPROVAL_SEAM_PENDING_SPEC'});
      const waiting=service.ask({...scope,args:{callId:'host',questions:[{id:'q',question:'Choose',options:['A','B']}]}});
      let list;for(let n=0;n<100;n++){list=await service.list(identity,scope.runId);if(list.questions.length)break;await pause(2);}
      assert.equal(list.questions[0].status,'pending');
      assert.equal((await service.answer(identity,scope.runId,'q',{callId:'host',answer:{selected:['A']}})).ok,true);
      assert.deepEqual((await waiting).answers,[{id:'q',selected:['A']}]);
    });
    await t.test('same ID across native calls is isolated; changed arguments conflict',async()=>{
      const a=await fixture(),otherScope={...a.scope,callId:'native-call-2'},otherStore=createQuestionStore(otherScope);
      const b=createQuestionManager({...identity,runId:a.scope.runId,store:otherStore});
      const ap=a.manager.askQuestion('q',{question:'first',callId:a.scope.callId,timeoutMs:1000});ap.catch(()=>{});
      const bp=b.askQuestion('q',{question:'second',callId:otherScope.callId,timeoutMs:1000});bp.catch(()=>{});
      while(!(await a.store.get('q'))||!(await otherStore.get('q')))await pause(1);
      assert.equal((await a.store.get('q')).question,'first');assert.equal((await otherStore.get('q')).question,'second');
      await assert.rejects(a.manager.askQuestion('q',{question:'changed',callId:a.scope.callId,timeoutMs:1000}),{code:'ID_CONFLICT'});
      await a.manager.cancelRun('cleanup');await Promise.allSettled([ap,bp]);
    });
    await t.test('completed Run and expired worker lease cannot accept answers',async()=>{
      for(const kind of ['terminal','lease']){
        const {scope,store,manager}=await fixture();const p=manager.askQuestion('q',{question:'Stop',callId:scope.callId,timeoutMs:1000});p.catch(()=>{});
        while(!(await store.get('q')))await pause(1);
        if(kind==='terminal')await db.query("UPDATE agent_runs SET state='failed' WHERE run_id=$1",[scope.runId]);
        else await db.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[scope.runId]);
        const answer=await manager.submitAnswer('q','late',{respondentTenantId:identity.tenantId,respondentUserId:identity.userId});
        assert.equal(answer.ok,false);assert.equal((await store.get('q')).status,'cancelled');await assert.rejects(p,{code:'QUESTION_CANCELLED'});
      }
    });
    await t.test('answer committed before cancellation remains the waiter terminal',async()=>{
      const {scope,store,manager}=await fixture();const p=manager.askQuestion('q',{question:'Race cancel',callId:scope.callId,timeoutMs:1000});
      while(!(await store.get('q')))await pause(1);
      const other=createQuestionManager({...identity,runId:scope.runId,store:createQuestionStore(scope)});
      assert.equal((await other.submitAnswer('q','committed',{respondentTenantId:identity.tenantId,respondentUserId:identity.userId})).ok,true);
      await manager.cancelRun('after answer');assert.equal((await p).answer,'committed');assert.equal((await store.get('q')).status,'answered');
    });
    await t.test('storage outage fails closed without inventing a cancelled authority',async()=>{
      const {scope}=await fixture();let broken=false;
      const faulty={transaction:fn=>broken?Promise.reject(Error('private storage diagnostic')):db.transaction(fn)};
      const store=createQuestionStore({...scope,db:faulty}),manager=createQuestionManager({...identity,runId:scope.runId,store});
      const p=manager.askQuestion('q',{question:'Storage',callId:scope.callId,timeoutMs:1000});p.catch(()=>{});
      while(!(await store.get('q')))await pause(1);
      broken=true;await assert.rejects(manager.cancelRun('stop'));await assert.rejects(p,{code:'STORE_UNAVAILABLE'});
      broken=false;assert.equal((await store.get('q')).status,'pending');await store.cancelRun(scope.runId,identity.tenantId,'cleanup');
    });
  }finally{await storage?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
