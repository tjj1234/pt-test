import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const {createTaskStore}=require('../../shell/tasks/store.cjs');
const {createMediaGrantStoreCandidate}=require('../../shell/tasks/media-grant-store-candidate.cjs');
const {admitControlledMediaAttempt}=require('../../shell/tasks/controlled-media-admission.cjs');

test('candidate durable grants: actual migrations, isolation, atomic slot/intent, rollback and reopen',async t=>{
  assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&process.env[k]),false);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-grants-'));
  const options={dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')};
  let storage;
  try {
    storage=await createStorage(options);
    let runs=createTaskStore(storage.adapter);
    const aUser=(await storage.repositories.auth.register({username:'grant-owner',password:'FixturePass123'})).user;
    const bUser=(await storage.repositories.auth.register({username:'grant-other',password:'FixturePass123'})).user;
    const a={userId:aUser.id,tenantId:aUser.tenant_id},b={userId:bUser.id,tenantId:bUser.tenant_id};
    const conversation=await storage.repositories.conversations.create(a.userId);
    const owner='grant-worker';
    async function newRun(key){let r=(await runs.createRun(a,{conversationId:conversation.id,idempotencyKey:key,policyVersion:'fixture',request:{question:'fixture',attachments:[]}},{owner,ttlMs:300000})).run;return runs.transition(a,r.runId,'running',r.revision,owner);}
    const route={scopeId:createHash('sha256').update('fixture-scope').digest('hex'),model:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',provider:'powertokens-video'};
    let intents=0;
    const recordIntent=async ({tx,identity,runId,...rest})=>{intents++;return runs.externalOperations.createIntentInTransaction(tx,identity,runId,rest);};
    let grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent});
    const input=(id,r,extra={})=>({grantId:id,runId:r.runId,runLeaseOwner:owner,credentialScopeId:route.scopeId,modelId:route.model,taskType:route.taskType,capabilityRevision:route.capabilityRevision,adapterId:route.adapterId,adapterVersion:route.adapterVersion,provider:route.provider,expiresAt:new Date(Date.now()+600000).toISOString(),...extra});
    const entry=(g,extra={})=>({grantId:g.grantId,runId:g.runId,userId:a.userId,tenantId:a.tenantId,credentialScopeId:route.scopeId,modelId:route.model,taskType:route.taskType,capabilityRevision:route.capabilityRevision,provider:route.provider,adapterId:route.adapterId,adapterVersion:route.adapterVersion,operationKey:g.runId+':'+randomUUID(),runLeaseOwner:owner,...extra});
    const r1=await newRun('grant-one'),r2=await newRun('grant-two'),r3=await newRun('grant-three');
    const g1=await grants.issue(a,input('grant-one',r1)),g2=await grants.issue(a,input('grant-two',r2));
    await t.test('Run-only lookup rejects foreign owners and ambiguous authorizations, omits expired grants',async()=>{
      assert.equal((await grants.getActiveGrantForRun(a,r1.runId)).grantId,g1.grantId);
      await assert.rejects(grants.getActiveGrantForRun(b,r1.runId),{code:'NOT_FOUND'});
      assert.equal(await grants.getActiveGrantForRun(a,r3.runId),null);
      await grants.issue(a,input('second-live',r1));
      await assert.rejects(grants.getActiveGrantForRun(a,r1.runId),{code:'MEDIA_GRANT_AMBIGUOUS'});
      await storage.adapter.query("UPDATE controlled_media_grants SET issued_at='1999-01-01',expires_at='2000-01-01' WHERE grant_id=$1",['second-live']);
      assert.equal((await grants.getActiveGrantForRun(a,r1.runId)).grantId,g1.grantId);
    });
    await t.test('identity, lease, expiration and route checks happen before consumption',async()=>{
      await assert.rejects(grants.getGrant(b,r1.runId,g1.grantId),{code:'NOT_FOUND'});
      await assert.rejects(grants.issue(b,input('foreign',r1)),{code:'NOT_FOUND'});
      await assert.rejects(grants.issue(a,input('bad-lease',r1,{runLeaseOwner:'wrong'})),{code:'LEASE_LOST'});
      await assert.rejects(grants.issue(a,input('expired',r1,{expiresAt:'2000-01-01T00:00:00Z'})),{code:'MEDIA_GRANT_EXPIRED'});
      await assert.rejects(grants.reserveAttempt(a,entry(g1,{runLeaseOwner:'wrong'})),{code:'LEASE_LOST'});
      await assert.rejects(grants.reserveAttempt(a,entry(g1,{modelId:'other'})),{code:'MEDIA_GRANT_ROUTE_MISMATCH'});
      await assert.rejects(grants.reserveAttempt(a,entry(g1,{provider:'other'})),{code:'MEDIA_GRANT_ROUTE_MISMATCH'});
      await assert.rejects(grants.reserveAttempt(a,entry(g1,{adapterId:'wrong-adapter'})),{code:'MEDIA_GRANT_ROUTE_MISMATCH'});
      assert.equal((await grants.getGrant(a,r1.runId,g1.grantId)).consumed,false);
      const expired=await grants.issue(a,input('will-expire',r3));
      await storage.adapter.query("UPDATE controlled_media_grants SET issued_at='1999-01-01',expires_at='2000-01-01' WHERE grant_id=$1",[expired.grantId]);
      await assert.rejects(grants.reserveAttempt(a,entry(expired)),{code:'MEDIA_GRANT_EXPIRED'});
      await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[r3.runId]);
      await assert.rejects(grants.issue(a,input('clock-expired',r3)),{code:'LEASE_LOST'});
      await storage.adapter.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE run_id=$1",[r3.runId]);
    });
    await t.test('controlled admission consumes one grant and persists intent in the same transaction',async()=>{
      const receipt=await admitControlledMediaAttempt({grant:await grants.getGrant(a,r1.runId,g1.grantId),run:{...a,runId:r1.runId,state:'running',activeLease:true,leaseOwner:owner},credentialScopeId:route.scopeId,route,requestId:randomUUID(),reserveAttempt:e=>grants.reserveAttempt(a,{...e,runLeaseOwner:owner,provider:route.provider,adapterId:route.adapterId,adapterVersion:route.adapterVersion})});
      assert.equal(receipt.unknownOutcomeKeepsReservation,true);
      assert.equal((await runs.externalOperations.get(a,r1.runId,receipt.operationKey)).status,'submitting');
      // Existing event append really ran under the reservation transaction.
      assert.equal((await runs.getRun(a,r1.runId)).state,'waiting_external');
      await assert.rejects(grants.reserveAttempt(a,entry(g1)),{code:'LEASE_LOST'});
      // Simulate a resumed executor: a fresh active Run state must not reset
      // the durable one-shot grant, independently of the Run-state guard.
      await storage.adapter.query("UPDATE agent_runs SET state='running' WHERE run_id=$1",[r1.runId]);
      await assert.rejects(grants.reserveAttempt(a,entry(g1)),{code:'MEDIA_RESERVATION_CONFLICT'});
      await assert.rejects(grants.reserveAttempt(a,entry(g2)),{code:'MEDIA_RESERVATION_CONFLICT'});
      assert.equal((await grants.getGrant(a,r2.runId,g2.grantId)).consumed,false);
    });
    await t.test('intent callback refusal rolls back consumption and slot; a later explicit attempt works',async()=>{
      const g3=await grants.issue(a,input('rollback-grant',r3,{modelId:'rollback-model'}));
      const e=entry(g3,{modelId:'rollback-model'});
      const broken=createMediaGrantStoreCandidate(storage.adapter,{recordIntent:async x=>{await recordIntent(x);throw Error('fixture-intent-write-failed');}});
      await assert.rejects(broken.reserveAttempt(a,e),/fixture-intent-write-failed/);
      assert.equal((await grants.getGrant(a,r3.runId,g3.grantId)).consumed,false);
      assert.equal((await storage.adapter.query('SELECT * FROM controlled_media_reservations WHERE grant_id=$1',[g3.grantId])).rows.length,0);
      await assert.rejects(runs.externalOperations.get(a,r3.runId,e.operationKey),{code:'NOT_FOUND'});
      assert.equal((await runs.getRun(a,r3.runId)).state,'running');
      assert.equal((await grants.reserveAttempt(a,e)).accepted,true);
    });
    await t.test('Run handler consumes trusted grant before non-fetch submission and preserves unknown slot',async()=>{
      const {createMediaRunHandler}=require('../../shell/tasks/media-run-handler.cjs');
      const r4=await newRun('handler-grant-run');
      const trustedRoute={...route,model:'handler-fixture'};
      const g4=await grants.issue(a,input('handler-grant',r4,{modelId:trustedRoute.model}));
      let submissions=0;
      const handler=createMediaRunHandler({store:runs,identity:a,taskRun:{runId:r4.runId,leaseOwner:owner},loadCredential:async()=> 'fixture-key',
        loadControlledGrant:(identity,runId)=>grants.getGrant(identity,runId,g4.grantId),reserveControlledAttempt:(identity,e)=>grants.reserveAttempt(identity,e),
        resolveRoute:async value=>{assert.deepEqual(value.selection,{mode:'manual',modelId:trustedRoute.model});return trustedRoute;},
        executeMedia:async(_ctx,_args,opts)=>{await opts.onExternalIntent({provider:trustedRoute.provider});await opts.onExternalSubmissionStarted();submissions++;throw Object.assign(new Error('unknown fixture'),{code:'SUBMISSION_OUTCOME_UNKNOWN'});}});
      const requestId=randomUUID();
      await assert.rejects(handler.handle({name:'media.route',requestId,args:{taskType:'text2video',prompt:'fixture'}}),{code:'SUBMISSION_OUTCOME_UNKNOWN'});
      await handler.drain();assert.equal(submissions,1);
      assert.equal((await runs.externalOperations.get(a,r4.runId,r4.runId+':'+requestId)).status,'manual_check');
      assert.equal((await grants.getGrant(a,r4.runId,g4.grantId)).consumed,true);
      assert.equal((await storage.adapter.query('SELECT * FROM controlled_media_reservations WHERE grant_id=$1',[g4.grantId])).rows.length,1);
      await assert.rejects(handler.handle({name:'media.route',requestId:randomUUID(),args:{taskType:'text2video',prompt:'fixture'}}));assert.equal(submissions,1);
    });
    await t.test('reopening retains unknown occupied slot and grant consumption',async()=>{
      await storage.close();storage=await createStorage(options);runs=createTaskStore(storage.adapter);
      grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent});
      assert.equal((await grants.getGrant(a,r1.runId,g1.grantId)).consumed,true);
      assert.equal(await grants.getActiveGrantForRun(a,r1.runId),null);
      await assert.rejects(grants.reserveAttempt(a,entry(g2)),{code:'MEDIA_RESERVATION_CONFLICT'});
      assert.equal((await grants.getGrant(a,r2.runId,g2.grantId)).consumed,false);
      assert.equal((await storage.adapter.query('SELECT * FROM controlled_media_reservations')).rows.length,3);
      assert.ok(intents>=3);
    });
  } finally {if(storage)await storage.close();fs.rmSync(dir,{recursive:true,force:true});}
});
