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
const {createMediaReservationReleaseCandidate}=require('../../shell/tasks/media-reservation-release-candidate.cjs');
test('actual PGlite release migration, owned facts, retained consumption and atomic audit',async t=>{
 assert.equal(Object.keys(process.env).some(k=>k.startsWith('PT_PG_')&&process.env[k]),false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-release-'));let storage;
 try{
  const migrationDir=path.join(dir,'through-022');fs.mkdirSync(migrationDir);
  const authoritative=path.resolve('shell/db-migrations');
  for(const file of fs.readdirSync(authoritative).filter(f=>f.endsWith('.sql')&&f<'023_'))fs.copyFileSync(path.join(authoritative,file),path.join(migrationDir,file));
  storage=await createStorage({dataDir:path.join(dir,'db'),masterKeyFile:path.join(dir,'key'),migrationsDir:migrationDir});
  const runs=createTaskStore(storage.adapter);
  const u=(await storage.repositories.auth.register({username:'release-owner',password:'FixturePass123'})).user;
  const v=(await storage.repositories.auth.register({username:'release-other',password:'FixturePass123'})).user;
  const a={userId:u.id,tenantId:u.tenant_id},b={userId:v.id,tenantId:v.tenant_id};
  const conv=await storage.repositories.conversations.create(a.userId),owner='fixture-owner';
  const grants=createMediaGrantStoreCandidate(storage.adapter,{recordIntent:({tx,identity,runId,...rest})=>runs.externalOperations.createIntentInTransaction(tx,identity,runId,rest)});
  const releases=createMediaReservationReleaseCandidate(storage.adapter);
  async function fixture(model='model-'+randomUUID()){
   let run=(await runs.createRun(a,{conversationId:conv.id,idempotencyKey:randomUUID(),policyVersion:'fixture',request:{question:'fixture'}},{owner,ttlMs:300000})).run;
   run=await runs.transition(a,run.runId,'running',run.revision,owner);
   const params={credentialScopeId:'fixture-scope',modelId:model,taskType:'text2video',capabilityRevision:'a'.repeat(64),adapterId:'pt-python-video-v1',adapterVersion:'1',provider:'powertokens-video'};
   const grant=await grants.issue(a,{...params,grantId:'grant-'+randomUUID(),runId:run.runId,runLeaseOwner:owner,expiresAt:new Date(Date.now()+600000).toISOString()});
   const entry={...params,...a,grantId:grant.grantId,runId:run.runId,runLeaseOwner:owner,operationKey:run.runId+':'+randomUUID()};
   const receipt=await grants.reserveAttempt(a,entry);
   return {run,grant,entry,receipt,input:{reservationId:receipt.reservationId}};
  }
  async function terminal(f,outcome,reason=null){await runs.externalOperations.recordSubmissionResult(a,f.run.runId,f.entry.operationKey,{outcome,providerStatus:reason?null:outcome,reason,queried:false,runLeaseOwner:owner,observedAt:new Date().toISOString()});}
  const legacy=await fixture();
  await require('../../shell/db.cjs').migrate(storage.db,authoritative);
  await t.test('023 upgrades a populated 022 table and snapshots immutable grant identity',async()=>{
   const row=(await storage.adapter.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1',[legacy.receipt.reservationId])).rows[0];
   assert.equal(row.provider,legacy.entry.provider);assert.equal(row.capability_revision,legacy.entry.capabilityRevision);assert.equal(row.adapter_id,legacy.entry.adapterId);
   await terminal(legacy,'succeeded');assert.equal((await releases.reconcile(a,legacy.input)).decision,'release_allowed');
  });
  await t.test('unknown and caller force cannot release; cross-tenant access denied',async()=>{
   const f=await fixture();
   assert.equal((await releases.reconcile(a,f.input)).decision,'keep_reserved');
   await runs.externalOperations.markUnknownSubmission(a,f.run.runId,f.entry.operationKey,{reason:'submission_response_unknown',runLeaseOwner:owner,observedAt:new Date().toISOString()});
   assert.equal((await releases.reconcile(a,f.input)).decision,'keep_reserved');
   await assert.rejects(releases.reconcile(b,f.input),{code:'NOT_FOUND'});
   await assert.rejects(releases.reconcile(a,{...f.input,force:true}),{code:'MEDIA_RELEASE_INVALID'});
  });
  await t.test('recorded success, failure and host not_submitted release; repeat is idempotent',async()=>{
   for(const [outcome,reason] of [['succeeded',null],['failed',null],['cancelled','not_submitted']]){
    const f=await fixture();await terminal(f,outcome,reason);
    // Recovery need not hold an executor lease or keep the Run running.
    await storage.adapter.query("UPDATE agent_runs SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE run_id=$1",[f.run.runId]);
    assert.equal((await releases.reconcile(a,f.input)).decision,'release_allowed');
    const row=(await storage.adapter.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1',[f.receipt.reservationId])).rows[0];
    assert.equal(row.status,'released');assert.ok(row.released_at);assert.ok(row.release_reason);assert.ok(row.release_operation_id);assert.equal(row.released_by,a.userId);
    assert.equal((await releases.reconcile(a,f.input)).decision,'already_released');
    assert.equal((await grants.getGrant(a,f.run.runId,f.grant.grantId)).consumed,true);
    await storage.adapter.query("UPDATE agent_runs SET state='running',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE run_id=$1",[f.run.runId,owner]);
    await assert.rejects(grants.reserveAttempt(a,{...f.entry,operationKey:f.run.runId+':'+randomUUID()}),{code:'MEDIA_RESERVATION_CONFLICT'});
    const next=await fixture(f.entry.modelId);assert.ok(next.receipt.accepted,'new explicit grant may occupy the released slot');
   }
  });
  await t.test('identity snapshot mismatch prevents release',async()=>{
   const f=await fixture();await terminal(f,'succeeded');
   await storage.adapter.query("UPDATE controlled_media_reservations SET capability_revision=$1 WHERE reservation_id=$2",['b'.repeat(64),f.receipt.reservationId]);
   await assert.rejects(releases.reconcile(a,f.input),{code:'MEDIA_RELEASE_MISMATCH'});
   assert.equal((await storage.adapter.query('SELECT status FROM controlled_media_reservations WHERE reservation_id=$1',[f.receipt.reservationId])).rows[0].status,'reserved');
  });
  await t.test('exception after release update rolls back slot and audit together',async()=>{
   const f=await fixture();await terminal(f,'succeeded');
   const broken={transaction:cb=>storage.adapter.transaction(tx=>cb({...tx,query:async(sql,args)=>{const result=await tx.query(sql,args);if(sql.startsWith('UPDATE controlled_media_reservations SET status='))throw Error('fixture rollback');return result;}}))};
   await assert.rejects(createMediaReservationReleaseCandidate(broken).reconcile(a,f.input),/fixture rollback/);
   const row=(await storage.adapter.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1',[f.receipt.reservationId])).rows[0];
   assert.equal(row.status,'reserved');assert.equal(row.released_at,null);assert.equal(row.release_reason,null);assert.equal(row.release_operation_id,null);
   assert.equal((await releases.reconcile(a,f.input)).decision,'release_allowed');
  });
 }finally{if(storage)await storage.close();fs.rmSync(dir,{recursive:true,force:true});}
});
