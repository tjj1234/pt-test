'use strict';
// Trusted host API only; never pass tool arguments here. The server reads
// grants and reserves attempts; issuance is not exposed through HTTP/UI.
// issue() means the host already obtained explicit authorization. No HTTP,
// provider retry, costs, or automatic release. Every reservation remains occupied
// even after local failure or expiry, until explicit durable reconciliation.
// reserveAttempt(identity, entry) accepts controlled-media-admission's reservation
// plus host-owned runLeaseOwner/provider/adapterId/adapterVersion. Required
// recordIntent({tx,...}) must use that transaction, never start its own.
// grant adapter/version are immutable issue data;
// admission must use getGrant() rather than a child-supplied grant object.
// Lock order: owned Run -> grant -> unique scope/model/task slot insertion.
const { randomUUID } = require('node:crypto');
const err = code => Object.assign(new Error(code), { code });
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const tasks = new Set(['text2image','image2image','text2video','image2video']);
function createMediaGrantStoreCandidate(db, {recordIntent} = {}) {
  if (!db || typeof db.transaction !== 'function' || typeof recordIntent !== 'function') throw err('MEDIA_STORE_INVALID');
  async function owned(tx, identity, runId, owner, lease = true) {
    if (!uuid(identity?.userId) || !uuid(identity?.tenantId) || !uuid(runId)) throw err('MEDIA_IDENTITY_INVALID');
    const { rows } = await tx.query('SELECT *,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE', [runId,identity.userId,identity.tenantId]);
    const run = rows[0];
    if (!run) throw err('NOT_FOUND');
    if (lease && (!label(owner) || run.lease_owner !== owner || run.active !== true || run.state !== 'running')) throw err('LEASE_LOST');
    return run;
  }
  function decode(r) {
    return { authorized:true,purpose:'controlled_media_test',grantId:r.grant_id,runId:r.run_id,userId:r.user_id,tenantId:r.tenant_id,
      credentialScopeId:r.credential_scope_id,modelId:r.model_id,taskType:r.task_type,capabilityRevision:r.capability_revision,
      adapterId:r.adapter_id,adapterVersion:r.adapter_version,provider:r.provider,maxMediaCalls:1,maxExternalSubmissions:1,maxRetries:0,
      issuedAt:new Date(r.issued_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString(),consumed:r.consumed_at !== null };
  }
  async function issue(identity, input) {
    if (!input || !['grantId','credentialScopeId','modelId','adapterId','adapterVersion','runLeaseOwner','provider'].every(k=>label(input[k])) ||
        !tasks.has(input.taskType) || !/^[a-f0-9]{64}$/.test(input.capabilityRevision || '') ||
        typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) throw err('MEDIA_GRANT_INVALID');
    return db.transaction(async tx => {
      await owned(tx,identity,input.runId,input.runLeaseOwner);
      const time = await tx.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[input.expiresAt]);
      if (!time.rows[0]?.valid) throw err('MEDIA_GRANT_EXPIRED');
      const {rows} = await tx.query('INSERT INTO controlled_media_grants (grant_id,run_id,user_id,tenant_id,credential_scope_id,model_id,task_type,capability_revision,adapter_id,adapter_version,provider,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [input.grantId,input.runId,identity.userId,identity.tenantId,input.credentialScopeId,input.modelId,input.taskType,input.capabilityRevision,input.adapterId,input.adapterVersion,input.provider,input.expiresAt]);
      return decode(rows[0]);
    });
  }
  async function getGrant(identity, runId, grantId) {
    return db.transaction(async tx=>{
      await owned(tx,identity,runId,null,false);
      const {rows}=await tx.query('SELECT * FROM controlled_media_grants WHERE grant_id=$1 AND run_id=$2 AND user_id=$3 AND tenant_id=$4',[grantId,runId,identity.userId,identity.tenantId]);
      if (!rows[0]) throw err('NOT_FOUND');
      return decode(rows[0]);
    });
  }
  // Select only by the owned Run, never by a client/tool supplied grant ID.
  // Multiple live authorizations are an operator error, not a routing choice.
  async function getActiveGrantForRun(identity, runId) {
    return db.transaction(async tx => {
      await owned(tx,identity,runId,null,false);
      const {rows}=await tx.query('SELECT * FROM controlled_media_grants WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() ORDER BY issued_at,grant_id LIMIT 2',[runId,identity.userId,identity.tenantId]);
      if(rows.length>1) throw err('MEDIA_GRANT_AMBIGUOUS');
      return rows.length===1 ? decode(rows[0]) : null;
    });
  }
  async function reserveAttempt(identity, entry) {
    if (!entry || !label(entry.grantId) || !label(entry.runLeaseOwner) || !label(entry.provider) || !label(entry.adapterId) || !label(entry.adapterVersion) ||
        !['credentialScopeId','modelId'].every(k=>label(entry[k])) || !tasks.has(entry.taskType) ||
        !/^[a-f0-9]{64}$/.test(entry.capabilityRevision || '') || entry.userId !== identity?.userId || entry.tenantId !== identity?.tenantId ||
        typeof entry.operationKey !== 'string' || !entry.operationKey.startsWith(entry.runId+':') || !uuid(entry.operationKey.slice(entry.runId.length+1))) throw err('MEDIA_RESERVATION_INVALID');
    try {
      return await db.transaction(async tx=>{
        await owned(tx,identity,entry.runId,entry.runLeaseOwner);
        const {rows}=await tx.query('SELECT *,expires_at>clock_timestamp() AS valid FROM controlled_media_grants WHERE grant_id=$1 FOR UPDATE',[entry.grantId]);
        const g=rows[0];
        if (!g || g.run_id !== entry.runId || g.user_id !== identity.userId || g.tenant_id !== identity.tenantId) throw err('NOT_FOUND');
        if (g.consumed_at) throw err('MEDIA_RESERVATION_CONFLICT');
        if (!g.valid) throw err('MEDIA_GRANT_EXPIRED');
        if (g.credential_scope_id !== entry.credentialScopeId || g.model_id !== entry.modelId || g.task_type !== entry.taskType || g.capability_revision !== entry.capabilityRevision || g.provider !== entry.provider || g.adapter_id !== entry.adapterId || g.adapter_version !== entry.adapterVersion) throw err('MEDIA_GRANT_ROUTE_MISMATCH');
        const reservationId=randomUUID();
        await tx.query('INSERT INTO controlled_media_reservations (reservation_id,grant_id,run_id,operation_key,credential_scope_id,model_id,task_type) VALUES ($1,$2,$3,$4,$5,$6,$7)',[reservationId,g.grant_id,g.run_id,entry.operationKey,g.credential_scope_id,g.model_id,g.task_type]);
        await tx.query('UPDATE controlled_media_grants SET consumed_at=clock_timestamp() WHERE grant_id=$1',[g.grant_id]);
        const intent=await recordIntent({tx,identity,runId:g.run_id,operationKey:entry.operationKey,provider:g.provider,runLeaseOwner:entry.runLeaseOwner});
        if (!intent || intent.operationKey !== entry.operationKey || !uuid(intent.operationId)) throw err('MEDIA_INTENT_INVALID');
        return {accepted:true,reservationId,grantId:g.grant_id,operationKey:entry.operationKey,scopeConflictChecked:true,grantConsumed:true,intentRecorded:true};
      });
    } catch (error) {
      if (error.code === '23505') throw err('MEDIA_RESERVATION_CONFLICT');
      throw error;
    }
  }
  return Object.freeze({issue,getGrant,getActiveGrantForRun,reserveAttempt});
}
module.exports={createMediaGrantStoreCandidate};
