"use strict";
const {setTimeout:delay}=require('node:timers/promises');
const {controlledMediaParameters,matchesControlledMediaParameters}=require('./controlled-media-parameters.cjs');
const fail=code=>Object.assign(new Error('Media authorization is unavailable'),{code});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const tasks=new Set(['text2image','image2image','text2video','image2video']);

// Wait before any model/provider call. Lease renewal and cancellation remain
// owned by the existing execution service; disconnect does not mean consent.
async function waitForMediaAuthorization({identity,taskRun,taskType,grants,timeoutMs=120000}){
 if(!tasks.has(taskType)||!taskRun?.runId||typeof taskRun.emit!=='function'||typeof grants?.getActiveGrantForRun!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw fail('MEDIA_AUTHORIZATION_INVALID');
 if(taskRun.signal?.aborted)throw fail('SESSION_ABORTED');
 const deadline=Date.now()+timeoutMs;
 const monotonicDeadline=performance.now()+timeoutMs;
 const parameters=controlledMediaParameters(taskType);
 await taskRun.emit('state',{action:'media_authorization_required',taskType,expiresAt:new Date(deadline).toISOString(),parameterPolicy:parameters.policyVersion,generationParameters:parameters.generationParameters,parameterSummary:parameters.parameterSummary});
 while(true){
  if(taskRun.signal?.aborted)throw fail('SESSION_ABORTED');
  const grant=await grants.getActiveGrantForRun(identity,taskRun.runId);
  if(grant){if(grant.taskType!==taskType)throw fail('MEDIA_GRANT_ROUTE_MISMATCH');return grant;}
  const remaining=monotonicDeadline-performance.now();
  if(remaining<=0)throw fail('MEDIA_AUTHORIZATION_EXPIRED');
  try{await delay(Math.min(200,remaining),undefined,{signal:taskRun.signal});}
  catch(error){if(error.name==='AbortError')throw fail('SESSION_ABORTED');throw error;}
 }
}

function createMediaAuthorization({db,grants,loadCredential,resolveRoute}){
 if(typeof db?.query!=='function'||typeof grants?.issue!=='function'||typeof loadCredential!=='function'||typeof resolveRoute!=='function')throw new TypeError('Media authorization dependencies required');
 async function pending(identity,runId){
  if(!uuid(identity?.userId)||!uuid(identity?.tenantId)||!uuid(runId))throw fail('MEDIA_AUTHORIZATION_INVALID');
  const {rows}=await db.query("SELECT r.lease_owner,r.state,r.lease_expires_at>clock_timestamp() AS active,e.event->'payload' AS authorization FROM agent_runs r LEFT JOIN LATERAL (SELECT event FROM agent_run_events WHERE run_id=r.run_id AND event->>'type'='state' AND event->'payload'->>'action'='media_authorization_required' ORDER BY seq DESC LIMIT 1) e ON true WHERE r.run_id=$1 AND r.user_id=$2 AND r.tenant_id=$3",[runId,identity.userId,identity.tenantId]);
  const row=rows[0];if(!row)throw fail('NOT_FOUND');
  const auth=row.authorization;
  if(row.state!=='running'||row.active!==true||!tasks.has(auth?.taskType)||!matchesControlledMediaParameters(auth.taskType,auth)||!Number.isFinite(Date.parse(auth.expiresAt))||Date.parse(auth.expiresAt)<=Date.now())throw fail('MEDIA_AUTHORIZATION_NOT_PENDING');
  return {row,auth};
 }
 async function status(identity,runId){
  const {auth}=await pending(identity,runId);
  return {taskType:auth.taskType,expiresAt:auth.expiresAt,parameterPolicy:auth.parameterPolicy,generationParameters:auth.generationParameters,parameterSummary:controlledMediaParameters(auth.taskType).parameterSummary,maxExternalSubmissions:1,maxRetries:0,monetaryCapEnforced:false};
 }
 async function authorize(identity,runId,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmed,modelId'||input.confirmed!==true||typeof input.modelId!=='string'||!input.modelId.trim()||input.modelId.length>256||/[\x00-\x1f\x7f]/.test(input.modelId))throw fail('MEDIA_AUTHORIZATION_INVALID');
  const {row,auth}=await pending(identity,runId);
  const apiKey=await loadCredential(identity.userId);if(!apiKey)throw fail('NO_API_KEY');
  // All scope, revision, adapter and provider fields come from current-Key
  // qualification. Consent supplies only the user's explicit model choice.
  const route=await resolveRoute({identity,apiKey,args:{taskType:auth.taskType},selection:{mode:'manual',modelId:input.modelId}});
  const grantId='controlled:'+runId;
  const issue={grantId,runId,runLeaseOwner:row.lease_owner,credentialScopeId:route.scopeId,modelId:route.model,taskType:route.taskType,capabilityRevision:route.capabilityRevision,adapterId:route.adapterId,adapterVersion:route.adapterVersion,provider:route.provider,expiresAt:new Date(Date.now()+180000).toISOString()};
  let grant;
  try{grant=await grants.issue(identity,issue);}
  catch(error){
   if(error.code!=='23505')throw error;
   grant=await grants.getGrant(identity,runId,grantId);
   for(const field of ['credentialScopeId','modelId','taskType','capabilityRevision','adapterId','adapterVersion','provider'])if(grant[field]!==issue[field])throw fail('MEDIA_GRANT_ROUTE_MISMATCH');
   if(grant.consumed||Date.parse(grant.expiresAt)<=Date.now())throw fail('MEDIA_AUTHORIZATION_NOT_PENDING');
  }
  return {authorized:true,runId,modelId:grant.modelId,taskType:grant.taskType,expiresAt:grant.expiresAt,parameterPolicy:auth.parameterPolicy,generationParameters:auth.generationParameters,maxExternalSubmissions:1,maxRetries:0,monetaryCapEnforced:false};
 }
 return Object.freeze({status,authorize});
}
module.exports={createMediaAuthorization,waitForMediaAuthorization};
