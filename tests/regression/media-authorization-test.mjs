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
const {createMediaGrantStoreCandidate}=require('../../shell/tasks/media-grant-store-candidate.cjs');
const {createMediaAuthorization,waitForMediaAuthorization}=require('../../shell/tasks/media-authorization.cjs');
const {controlledMediaParameters}=require('../../shell/tasks/controlled-media-parameters.cjs');

test('host authorization waits before invocation and issues an owned current-Key route under the existing lease',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-authorization-'));let storage;
 try{
  storage=await createStorage({dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key')});
  const users=[];for(const suffix of ['owner','other']){const u=(await storage.repositories.auth.register({username:'authorization-'+suffix,password:'FixturePass123'})).user;users.push({userId:u.id,tenantId:u.tenant_id});}
  const [identity,foreign]=users,owner='fixture-worker';
  const runs=createTaskStore(storage.adapter),conv=await storage.repositories.conversations.create(identity.userId);
  const grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent:({tx,identity,runId,...entry})=>runs.externalOperations.createIntentInTransaction(tx,identity,runId,entry)});
  const route={scopeId:'current-fixture-key-scope',model:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'fixture-adapter',adapterVersion:'1',provider:'fixture-provider'};
  let credentials=0,resolutions=0;
  const authorization=createMediaAuthorization({db:storage.adapter,grants,loadCredential:async userId=>{assert.equal(userId,identity.userId);credentials++;return 'fixture-key';},resolveRoute:async input=>{resolutions++;assert.equal(input.apiKey,'fixture-key');assert.deepEqual(input.selection,{mode:'manual',modelId:'fixture-video'});assert.deepEqual(input.args,{taskType:'text2video'});return route;}});
  async function fixture(){let r=(await runs.createRun(identity,{conversationId:conv.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'fixture'}},{owner,ttlMs:300000})).run;return runs.transition(identity,r.runId,'running',r.revision,owner);}
  const run=await fixture(),signal=new AbortController();
  const taskRun={runId:run.runId,leaseOwner:owner,signal:signal.signal,emit:(type,payload)=>runs.appendEvent(identity,run.runId,{type,payload,leaseOwner:owner})};
  await t.test('no host waiting event means no authorization; fields cannot replace trusted route',async()=>{
   await assert.rejects(authorization.authorize(identity,run.runId,{confirmed:true,modelId:'fixture-video'}),{code:'MEDIA_AUTHORIZATION_NOT_PENDING'});
   await assert.rejects(authorization.authorize(identity,run.runId,{confirmed:true,modelId:'fixture-video',provider:'forged'}),{code:'MEDIA_AUTHORIZATION_INVALID'});
   assert.equal(credentials,0);assert.equal(resolutions,0);
  });
  await t.test('durable wait notification, foreign rejection and explicit authorization complete the handshake',async()=>{
   let emitted;const ready=new Promise(resolve=>emitted=resolve);
   const waiting=waitForMediaAuthorization({identity,taskRun:{...taskRun,emit:async(...args)=>{await taskRun.emit(...args);emitted();}},taskType:'text2video',grants});
   await ready;
   try{
    const status=await authorization.status(identity,run.runId);assert.equal(status.taskType,'text2video');assert.equal(status.monetaryCapEnforced,false);
    await assert.rejects(authorization.authorize(foreign,run.runId,{confirmed:true,modelId:'fixture-video'}),{code:'NOT_FOUND'});
    await assert.rejects(authorization.authorize(identity,run.runId,{confirmed:false,modelId:'fixture-video'}),{code:'MEDIA_AUTHORIZATION_INVALID'});
    const result=await authorization.authorize(identity,run.runId,{confirmed:true,modelId:'fixture-video'});
    assert.equal(result.maxExternalSubmissions,1);assert.equal(result.maxRetries,0);assert.equal(result.monetaryCapEnforced,false);
    assert.equal((await waiting).credentialScopeId,route.scopeId);
    const repeated=await authorization.authorize(identity,run.runId,{confirmed:true,modelId:'fixture-video'});assert.equal(repeated.expiresAt,result.expiresAt);
    assert.equal((await storage.adapter.query('SELECT * FROM controlled_media_grants WHERE run_id=$1',[run.runId])).rows.length,1);
   }finally{signal.abort();await waiting.catch(()=>{});}
  });
  await t.test('expiry and abort do not issue grants or reach route qualification',async()=>{
   const r=await fixture(),before=resolutions;
   const tr={...taskRun,signal:new AbortController().signal,runId:r.runId,emit:(type,payload)=>runs.appendEvent(identity,r.runId,{type,payload,leaseOwner:owner})};
   await assert.rejects(waitForMediaAuthorization({identity,taskRun:tr,taskType:'text2video',grants,timeoutMs:1}),{code:'MEDIA_AUTHORIZATION_EXPIRED'});
   await assert.rejects(authorization.status(identity,r.runId),{code:'MEDIA_AUTHORIZATION_NOT_PENDING'});
   const aborted=new AbortController();aborted.abort();
   await assert.rejects(waitForMediaAuthorization({identity,taskRun:{...tr,signal:aborted.signal},taskType:'text2video',grants}),{code:'SESSION_ABORTED'});
   assert.equal(resolutions,before);assert.equal(await grants.getActiveGrantForRun(identity,r.runId),null);
  });
  await t.test('old or altered generation consent is rejected before credential lookup',async()=>{
   const r=await fixture(),before=credentials;
   const p=controlledMediaParameters('text2video');
   await runs.appendEvent(identity,r.runId,{type:'state',payload:{action:'media_authorization_required',taskType:'text2video',expiresAt:new Date(Date.now()+120000).toISOString(),parameterPolicy:p.policyVersion,generationParameters:{...p.generationParameters,durationSeconds:30}},leaseOwner:owner});
   await assert.rejects(authorization.authorize(identity,r.runId,{confirmed:true,modelId:'fixture-video'}),{code:'MEDIA_AUTHORIZATION_NOT_PENDING'});assert.equal(credentials,before);
  });
 }finally{if(storage)await storage.close();fs.rmSync(dir,{recursive:true,force:true});}
});
