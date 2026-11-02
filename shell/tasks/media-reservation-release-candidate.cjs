'use strict';
// Explicit owned reconciliation only. Caller supplies only
// reservationId, never outcome/force. No lease required for a recovered terminal
// Run; owned Run -> grant -> reservation -> operation locks serialize decisions.
// No provider requests, grant signing, retry, automatic release or cost claims.
const {decideMediaReservationReconciliation}=require('./media-reservation-reconciliation-candidate.cjs');
const fail=code=>Object.assign(new Error(code),{code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const iso=v=>new Date(v).toISOString();
function createMediaReservationReleaseCandidate(db){
 if(typeof db?.transaction!=='function')throw fail('MEDIA_RELEASE_INVALID');
 async function listForRun(identity,runId){
  if(!uuid(identity?.userId)||!uuid(identity?.tenantId)||!uuid(runId))throw fail('MEDIA_RELEASE_INVALID');
  return db.transaction(async tx=>{
   const owned=await tx.query('SELECT run_id FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3',[runId,identity.userId,identity.tenantId]);
   if(!owned.rows[0])throw fail('NOT_FOUND');
   // Bounded discovery; never expose credential scope or authorization internals.
   const {rows}=await tx.query('SELECT reservation_id,run_id,operation_key,model_id,task_type,status,reserved_at,released_at,release_reason FROM controlled_media_reservations WHERE run_id=$1 ORDER BY reserved_at,reservation_id LIMIT 101',[runId]);
   return {reservations:rows.slice(0,100).map(r=>({reservationId:r.reservation_id,runId:r.run_id,operationKey:r.operation_key,modelId:r.model_id,taskType:r.task_type,status:r.status,reservedAt:iso(r.reserved_at),releasedAt:r.released_at?iso(r.released_at):null,releaseReason:r.release_reason})),hasMore:rows.length>100};
  });
 }
 async function reconcile(identity,input){
  if(!uuid(identity?.userId)||!uuid(identity?.tenantId)||!input||Object.keys(input).length!==1||!uuid(input.reservationId))throw fail('MEDIA_RELEASE_INVALID');
  return db.transaction(async tx=>{
   // Discovery is non-locking. Re-read every entity after acquiring owned Run.
   const found=await tx.query('SELECT r.run_id,r.grant_id FROM controlled_media_reservations r JOIN agent_runs a ON a.run_id=r.run_id WHERE r.reservation_id=$1 AND a.user_id=$2 AND a.tenant_id=$3',[input.reservationId,identity.userId,identity.tenantId]);
   if(!found.rows[0])throw fail('NOT_FOUND');
   const ref=found.rows[0];
   const run=await tx.query('SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',[ref.run_id,identity.userId,identity.tenantId]);
   if(!run.rows[0])throw fail('NOT_FOUND');
   const grant=(await tx.query('SELECT * FROM controlled_media_grants WHERE grant_id=$1 FOR UPDATE',[ref.grant_id])).rows[0];
   const r=(await tx.query('SELECT * FROM controlled_media_reservations WHERE reservation_id=$1 FOR UPDATE',[input.reservationId])).rows[0];
   if(!grant||!r||r.grant_id!==grant.grant_id||r.run_id!==ref.run_id||grant.run_id!==r.run_id||grant.user_id!==identity.userId||grant.tenant_id!==identity.tenantId||!grant.consumed_at)throw fail('MEDIA_RELEASE_MISMATCH');
   for(const key of ['credential_scope_id','model_id','task_type'])if(r[key]!==grant[key])throw fail('MEDIA_RELEASE_MISMATCH');
   for(const key of ['provider','capability_revision','adapter_id','adapter_version'])if(r[key]!==grant[key])throw fail('MEDIA_RELEASE_MISMATCH');
   if(!r.operation_key.startsWith(r.run_id+':'))throw fail('MEDIA_RELEASE_MISMATCH');
   const op=(await tx.query('SELECT * FROM run_external_operations WHERE run_id=$1 AND operation_key=$2 FOR UPDATE',[r.run_id,r.operation_key])).rows[0];
   if(!op||op.provider!==grant.provider)throw fail('MEDIA_RELEASE_MISMATCH');
   if(r.status==='released'){
    if(r.release_operation_id!==op.operation_id||!r.release_reason||!r.released_at)throw fail('MEDIA_RELEASE_MISMATCH');
    return Object.freeze({decision:'already_released',reservationId:r.reservation_id,reasonCode:r.release_reason,grantRemainsConsumed:true,mayResubmit:false});
   }
   // An intent's now() timestamp can precede reserved_at=clock_timestamp()
   // within the same transaction. Pending work never permits release, so
   // retain the slot without rewriting those real timestamps as evidence.
   if(['submitting','accepted','querying','pending_query','manual_check'].includes(op.status))return Object.freeze({decision:'keep_reserved',reservationId:r.reservation_id,grantId:r.grant_id,runId:r.run_id,operationKey:r.operation_key,reasonCode:'OPERATION_UNRESOLVED',grantRemainsConsumed:true,mayResubmit:false});
   const q=op.last_query;
   const lastQuery=q===null?null:Object.fromEntries(['outcome','observedAt','providerStatus','reason','queried','attempt','source'].filter(k=>Object.hasOwn(q,k)).map(k=>[k,q[k]]));
   const decision=decideMediaReservationReconciliation({reservation:{reservationId:r.reservation_id,grantId:r.grant_id,runId:r.run_id,operationKey:r.operation_key,credentialScopeId:r.credential_scope_id,modelId:r.model_id,taskType:r.task_type,provider:grant.provider,status:r.status,reservedAt:iso(r.reserved_at)},operation:{operationId:op.operation_id,runId:op.run_id,operationKey:op.operation_key,provider:op.provider,status:op.status,taskId:op.task_id,lastQuery,updatedAt:iso(op.updated_at)}});
   if(decision.decision==='release_allowed'){
    const updated=await tx.query("UPDATE controlled_media_reservations SET status='released',released_at=clock_timestamp(),release_reason=$1,release_operation_id=$2,released_by=$3 WHERE reservation_id=$4 AND status='reserved' RETURNING reservation_id",[decision.reasonCode,op.operation_id,identity.userId,r.reservation_id]);
    if(updated.rows.length!==1||updated.rows[0].reservation_id!==r.reservation_id)throw fail('MEDIA_RELEASE_CONFLICT');
   }
   return decision;
  });
 }
 return Object.freeze({reconcile,listForRun});
}
module.exports={createMediaReservationReleaseCandidate};
