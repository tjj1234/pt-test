'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {canonicalizeJson}=require('../questions/manager.cjs');
const contracts=require('../contracts/phase1.cjs');
const fail=code=>Object.assign(new Error('Operation approval could not be verified'),{code});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\x00-\x1f\x7f]/.test(value);
function operationSnapshot(payload){
 if(!payload||Object.getPrototypeOf(payload)!==Object.prototype||Object.keys(payload).sort().join(',')!=='command,maxOutputBytes,policyRevision,timeoutMs,workdir')throw fail('APPROVAL_INPUT_INVALID');
 const {command,workdir,timeoutMs,maxOutputBytes,policyRevision}=payload;
 if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>8192||command.includes('\0')||typeof workdir!=='string'||!workdir||workdir.length>1024||workdir.includes('\0')||!id(policyRevision)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>1024*1024)throw fail('APPROVAL_INPUT_INVALID');
 // This is display redaction validation, never an execution isolation mechanism.
 if(/(?:api[_-]?key|password|secret|bearer\s|authorization\s*:|cookie\s*:|token\s*=)/i.test(command))throw fail('APPROVAL_SENSITIVE_CONTENT');
 const snapshot={command,workdir,timeoutMs,maxOutputBytes,policyRevision};
 return {payload:snapshot,sha256:createHash('sha256').update(canonicalizeJson(snapshot)).digest('hex')};
}
function createApprovalStore({db,identity,runId,leaseOwner}={}){
 contracts.assertContract('identity',identity);
 if(!db?.transaction||!id(runId)||(leaseOwner!==undefined&&!id(leaseOwner)))throw fail('APPROVAL_SCOPE_INVALID');
 identity=Object.freeze({...identity});
 const txRun=callback=>db.transaction(async tx=>{
  const {rows:[run]}=await tx.query('SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',[runId,identity.userId,identity.tenantId]);
  if(!run)throw fail('NOT_FOUND');
  const clock=async()=>Number((await tx.query('SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS ms')).rows[0].ms);
  return callback(tx,run,clock);
 });
 const live=(run,row,now)=>run.state==='running'&&id(run.lease_owner)&&(run.lease_expires_at instanceof Date?run.lease_expires_at.getTime():Date.parse(run.lease_expires_at))>now&&(!leaseOwner||leaseOwner===run.lease_owner)&&(!row||row.lease_owner===run.lease_owner);
 const visible=row=>({id:row.approval_id,callId:row.call_id,type:'approval',question:'是否批准这一次脚本执行？',header:'精确操作审批',detail:JSON.stringify(row.payload,null,2),options:['批准本次','拒绝'],multiSelect:false,deadline:Number(row.deadline),status:['approved','rejected','consumed'].includes(row.state)?'answered':row.state,approvalState:row.state,payloadSha256:row.payload_sha256});
 async function emit(tx,run,row,now){
  if(['completed','failed','cancelled','interrupted'].includes(run.state))return;
  const event={version:contracts.VERSION,eventId:randomUUID(),runId,conversationId:run.conversation_id,seq:run.next_seq,type:'state',occurredAt:new Date(now).toISOString(),payload:{action:'user_approval',question:visible(row)}};
  contracts.assertContract('event',event);
  await tx.query('INSERT INTO agent_run_events(event_id,run_id,seq,event) VALUES($1,$2,$3,$4::jsonb)',[event.eventId,runId,run.next_seq,JSON.stringify(event)]);
  await tx.query('UPDATE agent_runs SET next_seq=next_seq+1 WHERE run_id=$1',[runId]);run.next_seq++;
 }
 async function state(tx,run,row,next,now){
  const {rows:[updated]}=await tx.query('UPDATE agent_run_approvals SET state=$1,updated_at=$2 WHERE approval_id=$3 RETURNING *',[next,now,row.approval_id]);
  await emit(tx,run,updated,now);return updated;
 }
 async function fresh(tx,run,row,now){
  if(!row||!['pending','approved'].includes(row.state))return row;
  if(!live(run,row,now))return state(tx,run,row,'cancelled',now);
  if(now>=Number(row.deadline))return state(tx,run,row,'expired',now);
  return row;
 }
 async function request({callId,payload,timeoutMs=60000}={}){
  const snapshot=operationSnapshot(payload);
  if(!id(callId)||!leaseOwner||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw fail('APPROVAL_INPUT_INVALID');
  return txRun(async(tx,run,clock)=>{
   const {rows:[existing]}=await tx.query('SELECT * FROM agent_run_approvals WHERE run_id=$1 AND call_id=$2 FOR UPDATE',[runId,callId]);
   const now=await clock();
   if(existing){if(existing.payload_sha256!==snapshot.sha256||existing.lease_owner!==leaseOwner)throw fail('APPROVAL_PAYLOAD_MISMATCH');return visible(await fresh(tx,run,existing,now));}
   if(!live(run,null,now))throw fail('APPROVAL_RUN_INACTIVE');
   if(Number((await tx.query('SELECT count(*)::int AS count FROM agent_run_approvals WHERE run_id=$1',[runId])).rows[0].count)>=32)throw fail('APPROVAL_RUN_LIMIT');
   const {rows:[row]}=await tx.query(`INSERT INTO agent_run_approvals(approval_id,run_id,call_id,lease_owner,operation_type,payload_sha256,payload,state,deadline,created_at,updated_at)
    VALUES($1,$2,$3,$4,'run-script',$5,$6::jsonb,'pending',$7,$8,$8) RETURNING *`,[randomUUID(),runId,callId,leaseOwner,snapshot.sha256,JSON.stringify(snapshot.payload),now+timeoutMs,now]);
   await emit(tx,run,row,now);return visible(row);
  });
 }
 async function list(){return txRun(async(tx,run,clock)=>{
  const {rows}=await tx.query('SELECT * FROM agent_run_approvals WHERE run_id=$1 ORDER BY created_at,approval_id LIMIT 32 FOR UPDATE',[runId]);
  const now=await clock();
  const out=[];for(const row of rows)out.push(visible(await fresh(tx,run,row,now)));return {approvals:out};
 });}
 async function decide({approvalId,callId,payloadSha256,decision}={}){
  if(!id(approvalId)||!id(callId)||!['approve','reject'].includes(decision)||!/^[a-f0-9]{64}$/.test(payloadSha256||''))throw fail('APPROVAL_INPUT_INVALID');
  return txRun(async(tx,run,clock)=>{
   let {rows:[row]}=await tx.query('SELECT * FROM agent_run_approvals WHERE approval_id=$1 AND run_id=$2 AND call_id=$3 FOR UPDATE',[approvalId,runId,callId]);
   const now=await clock();
   if(!row)throw fail('NOT_FOUND');if(row.payload_sha256!==payloadSha256)throw fail('APPROVAL_PAYLOAD_MISMATCH');
   row=await fresh(tx,run,row,now);if(row.state!=='pending')return {ok:false,code:'APPROVAL_NOT_PENDING',approval:visible(row)};
   row=await state(tx,run,row,decision==='approve'?'approved':'rejected',now);return {ok:true,approval:visible(row)};
  });
 }
 async function consume({approvalId,callId,payload}={}){
  const snapshot=operationSnapshot(payload);if(!id(approvalId)||!id(callId)||!leaseOwner)throw fail('APPROVAL_INPUT_INVALID');
  return txRun(async(tx,run,clock)=>{
   let {rows:[row]}=await tx.query('SELECT * FROM agent_run_approvals WHERE approval_id=$1 AND run_id=$2 AND call_id=$3 FOR UPDATE',[approvalId,runId,callId]);
   const now=await clock();
   if(!row)throw fail('NOT_FOUND');if(row.payload_sha256!==snapshot.sha256||row.lease_owner!==leaseOwner)throw fail('APPROVAL_PAYLOAD_MISMATCH');
   row=await fresh(tx,run,row,now);if(row.state!=='approved')return {ok:false,code:'APPROVAL_NOT_CONSUMABLE',approval:visible(row)};
   row=await state(tx,run,row,'consumed',now);return {ok:true,approval:visible(row)};
  });
 }
 async function get(callId){return txRun(async(tx,run,clock)=>{
  const {rows:[row]}=await tx.query('SELECT * FROM agent_run_approvals WHERE run_id=$1 AND call_id=$2 FOR UPDATE',[runId,callId]);
  const now=await clock();return row?visible(await fresh(tx,run,row,now)):null;
 });}
 async function cancel(callId){return txRun(async(tx,run,clock)=>{
  const {rows:[row]}=await tx.query('SELECT * FROM agent_run_approvals WHERE run_id=$1 AND call_id=$2 FOR UPDATE',[runId,callId]);
  const now=await clock();
  return row&&['pending','approved'].includes(row.state)?visible(await state(tx,run,row,'cancelled',now)):row?visible(row):null;
 });}
 return Object.freeze({request,list,get,decide,consume,cancel});
}
module.exports={createApprovalStore,operationSnapshot};
