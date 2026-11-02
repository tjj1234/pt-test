'use strict';
const {randomUUID}=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
function createMemoryProvenanceStore({db,onInvalidate}){
 const locks=new Map();
 async function owned(identity){const row=(await db.query('SELECT tenant_id FROM users WHERE id=$1',[identity.userId])).rows[0];if(row?.tenant_id!==identity.tenantId)throw fail('MEMORY_NOT_FOUND',404);}
 const args=i=>[i.userId,i.tenantId];
 async function list(identity){await owned(identity);return (await db.query(`SELECT m.*,s.deleted_at,s.source_ref,s.source_sha256 AS live_sha,s.source_version AS live_version FROM memory_records m LEFT JOIN document_sources s ON s.source_id=m.source_id AND s.user_id=m.user_id AND s.tenant_id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2 ORDER BY m.updated_at DESC,m.memory_id LIMIT 100`,args(identity))).rows.map(row=>({...row,id:row.memory_id,scope:row.scope_ref==='user'?'user':'conversation',conversationId:row.scope_ref==='user'?null:row.scope_ref,sourceValid:!row.source_id||Boolean(row.source_ref&&!row.deleted_at&&row.live_sha===row.source_sha256&&row.live_version===row.source_version)}));}
 async function mutate(identity,operation){
  await owned(identity);const key=identity.userId;if(locks.has(key))throw fail('MEMORY_UPDATE_BUSY');
  locks.set(key,true);
  try{
   const result=await db.transaction(async tx=>{
    const result=await operation(tx);
    await tx.query('UPDATE conversations SET memory_revocation_pending=TRUE WHERE user_id=$1',[identity.userId]);return result;
   });
   let invalidation;try{invalidation=await onInvalidate(identity);}catch{throw fail('MEMORY_CONTEXT_INVALIDATION_FAILED',503);}
   await db.query('UPDATE conversations SET source_context_start=jsonb_array_length(messages),native_session_id=NULL,native_session_key_sha256=NULL,memory_revocation_pending=FALSE WHERE user_id=$1',[identity.userId]);
   return {...result,...invalidation};
  }finally{locks.delete(key);}
 }
 async function set(identity,input){
  if(!input||Object.keys(input).some(k=>!['key','value','scope','conversationId','sourceId','mode'].includes(k)))throw fail('MEMORY_INPUT_INVALID',400);
  const key=typeof input.key==='string'?input.key.trim():'',value=input.value;
  if(!key||key.startsWith('$')||key.length>80||typeof value!=='string'||!value.trim()||value.length>2000||!['user','conversation',undefined].includes(input.scope)||!['manual','proposal',undefined].includes(input.mode))throw fail('MEMORY_INPUT_INVALID',400);
  const scope=input.scope==='conversation'?input.conversationId:'user';if(input.scope==='conversation'&&!UUID.test(scope||''))throw fail('MEMORY_SCOPE_INVALID',400);
  return mutate(identity,async tx=>{
   if(scope!=='user'&&!(await tx.query('SELECT id FROM conversations WHERE id=$1 AND user_id=$2',[scope,identity.userId])).rows.length)throw fail('MEMORY_NOT_FOUND',404);
   let source=null;if(input.sourceId){if(!UUID.test(input.sourceId))throw fail('MEMORY_SOURCE_INVALID',400);source=(await tx.query('SELECT * FROM document_sources WHERE source_id=$1 AND user_id=$2 AND tenant_id=$3 AND deleted_at IS NULL',[input.sourceId,...args(identity)])).rows[0];if(!source)throw fail('MEMORY_SOURCE_UNAVAILABLE');}
   const existing=(await tx.query('SELECT memory_id FROM memory_records WHERE user_id=$1 AND scope_ref=$2 AND key=$3',[identity.userId,scope,key])).rows[0];
   const count=Number((await tx.query('SELECT count(*) AS n FROM memory_records WHERE user_id=$1',[identity.userId])).rows[0].n);if(!existing&&count>=100)throw fail('MEMORY_LIMIT',400);
   const record=(await tx.query(`INSERT INTO memory_records(memory_id,user_id,tenant_id,scope_ref,key,value,provenance,confirmed,source_id,source_sha256,source_version,confirmed_by,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $8 THEN $2::uuid ELSE NULL END,CASE WHEN $8 THEN now() ELSE NULL END) ON CONFLICT(user_id,scope_ref,key) DO UPDATE SET value=EXCLUDED.value,provenance=EXCLUDED.provenance,confirmed=EXCLUDED.confirmed,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at,source_id=EXCLUDED.source_id,source_sha256=EXCLUDED.source_sha256,source_version=EXCLUDED.source_version,revision=memory_records.revision+1,updated_at=now() RETURNING memory_id`,[existing?.memory_id||randomUUID(),...args(identity),scope,key,value,input.mode==='proposal'?'model-inference':'user-explicit-confirmation',input.mode!=='proposal',source?.source_id||null,source?.source_sha256||null,source?.source_version||null])).rows[0];
   return {ok:true,id:record.memory_id,key,value};
  });
 }
 async function confirm(identity,id){if(!UUID.test(id||''))throw fail('MEMORY_NOT_FOUND',404);return mutate(identity,async tx=>{
  const record=(await tx.query('SELECT m.*,s.deleted_at,s.source_sha256 AS live_sha,s.source_version AS live_version FROM memory_records m LEFT JOIN document_sources s ON m.source_id=s.source_id WHERE m.memory_id=$1 AND m.user_id=$2 AND m.tenant_id=$3',[id,...args(identity)])).rows[0];if(!record)throw fail('MEMORY_NOT_FOUND',404);
  if(record.source_id&&(record.deleted_at||record.live_sha!==record.source_sha256||record.live_version!==record.source_version))throw fail('MEMORY_SOURCE_UNAVAILABLE');
  await tx.query('UPDATE memory_records SET confirmed=TRUE,confirmed_by=user_id,confirmed_at=now(),revision=revision+1,updated_at=now() WHERE memory_id=$1',[id]);return {ok:true,id};
 });}
 async function del(identity,{id,key}){if(!id&&!key)throw fail('MEMORY_INPUT_INVALID',400);if(id&&!UUID.test(id))throw fail('MEMORY_NOT_FOUND',404);return mutate(identity,async tx=>{
  const result=await tx.query(id?'DELETE FROM memory_records WHERE memory_id=$1 AND user_id=$2 AND tenant_id=$3 RETURNING memory_id,key,scope_ref':"DELETE FROM memory_records WHERE key=$1 AND user_id=$2 AND tenant_id=$3 AND scope_ref='user' RETURNING memory_id,key,scope_ref",[id||key,...args(identity)]);if(!result.rows.length&&id)throw fail('MEMORY_NOT_FOUND',404);for(const row of result.rows)if(row.scope_ref==='user')await tx.query('DELETE FROM user_memory WHERE user_id=$1 AND key=$2',[identity.userId,row.key]);return {ok:true};
 });}
 async function recall(identity,{conversationId}={}){
  const rows=await list(identity),selected=[];let chars=0;
  for(const row of rows){if(!row.confirmed||!row.sourceValid||(row.scope_ref!=='user'&&row.scope_ref!==conversationId))continue;const line=row.key+'='+row.value,added=4+line.length+(selected.length?1:0);if(chars+added>4000||selected.length>=20)continue;selected.push(row);chars+=added;}
  return {lines:selected.map(row=>row.key+'='+row.value),records:selected.map(row=>({id:row.memory_id,revision:row.revision,provenance:row.provenance,scope:row.scope,sourceRef:row.source_ref||null})),includedChars:chars,limit:20,maxChars:4000};
 }
 const recover=identity=>mutate(identity,async()=>({ok:true,recovered:true}));
 return {list,set,confirm,del,recall,recover};
}
module.exports={createMemoryProvenanceStore};
