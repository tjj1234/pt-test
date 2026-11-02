// Dedicated localhost disposable database only; no provider traffic or secrets.
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
const {createMediaAuthorization}=require('../../shell/tasks/media-authorization.cjs');
const {controlledMediaParameters}=require('../../shell/tasks/controlled-media-parameters.cjs');
assert.equal(process.env.MEDIA_AUTHORIZATION_POSTGRES_FIXTURE,'disposable-media-authorization-20261029');
const dsn=new URL(process.env.PT_PG_DSN);
assert.ok(['postgres:','postgresql:'].includes(dsn.protocol));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(dsn.hostname));
assert.match(dsn.pathname,/^\/[a-zA-Z0-9_]*fixture[a-zA-Z0-9_]*$/);
assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&k!=='PT_PG_DSN'&&process.env[k]),false);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'media-auth-pg-'));let a,b;
try{
 a=await createStorage({dataDir:path.join(temp,'a'),masterKeyFile:path.join(temp,'a-key')});
 b=await createStorage({dataDir:path.join(temp,'b'),masterKeyFile:path.join(temp,'b-key')});
 assert.equal(a.db.adapter,'pg');assert.equal(b.db.adapter,'pg');
 const pidA=(await a.adapter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const pidB=(await b.adapter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;assert.notEqual(pidA,pidB);
 const user=(await a.repositories.auth.register({username:'auth-pg-'+randomUUID(),password:'FixturePass123'})).user;
 const identity={userId:user.id,tenantId:user.tenant_id},owner='fixture-worker';
 const conversation=await a.repositories.conversations.create(identity.userId),runs=createTaskStore(a.adapter);
 const recordIntent=({tx,identity,runId,...entry})=>runs.externalOperations.createIntentInTransaction(tx,identity,runId,entry);
 const grantsA=createMediaGrantStoreCandidate(a.adapter,{recordIntent}),grantsB=createMediaGrantStoreCandidate(b.adapter,{recordIntent});
 const route={scopeId:'fixture-scope',model:'fixture-video',taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'fixture-adapter',adapterVersion:'1',provider:'fixture'};
 async function fixture(){let run=(await runs.createRun(identity,{conversationId:conversation.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'fixture'}},{owner,ttlMs:300000})).run;run=await runs.transition(identity,run.runId,'running',run.revision,owner);await runs.appendEvent(identity,run.runId,{type:'state',payload:{action:'media_authorization_required',taskType:'text2video',expiresAt:new Date(Date.now()+120000).toISOString(),parameterPolicy:controlledMediaParameters('text2video').policyVersion,generationParameters:controlledMediaParameters('text2video').generationParameters},leaseOwner:owner});return run;}
 const make=(storage,grants,resolveRoute=async()=>route)=>createMediaAuthorization({db:storage.adapter,grants,loadCredential:async()=> 'fixture-key',resolveRoute});
 const first=await fixture(),input={confirmed:true,modelId:'fixture-video'};
 const results=await Promise.all([make(a,grantsA).authorize(identity,first.runId,input),make(b,grantsB).authorize(identity,first.runId,input)]);
 assert.equal(results[0].authorized,true);assert.equal(results[0].expiresAt,results[1].expiresAt);
 assert.equal((await a.adapter.query('SELECT grant_id FROM controlled_media_grants WHERE run_id=$1',[first.runId])).rows.length,1);
 await assert.rejects(make(b,grantsB,async()=>({...route,capabilityRevision:'b'.repeat(64)})).authorize(identity,first.runId,input),{code:'MEDIA_GRANT_ROUTE_MISMATCH'});
 const cancelled=await fixture();let entered,release;
 const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const pending=make(b,grantsB,async()=>{entered();await gate;return route;}).authorize(identity,cancelled.runId,input).then(value=>({value}),error=>({code:error.code}));
 await reached;
 await runs.transition(identity,cancelled.runId,'cancelling',cancelled.revision,owner);release();
 assert.equal((await pending).code,'LEASE_LOST');
 assert.equal((await a.adapter.query('SELECT grant_id FROM controlled_media_grants WHERE run_id=$1',[cancelled.runId])).rows.length,0);
 process.stdout.write(JSON.stringify({result:'PASS',database:'disposable-localhost-postgres',independentBackends:true,concurrentConfirmations:2,grantsIssued:1,revisionChangeRejected:true,cancellationDuringQualificationRejected:true,providerCalls:0})+'\n');
}finally{if(b)await b.close();if(a)await a.close();fs.rmSync(temp,{recursive:true,force:true});}
