'use strict';
const {randomUUID,createHash}=require('node:crypto');
const path=require('node:path'),fs=require('node:fs');
const {Worker}=require('node:worker_threads');
const {readVerifiedChatAttachmentBytes}=require('../tasks/chat-request.cjs');
const {pinDirectory}=require('../runtime/backup-fs.cjs');
const fail=(code,statusCode=409)=>Object.assign(new Error('Source operation could not be verified'),{code,statusCode});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let activeSearches=0;
function createSourceStore({db,uploadsRoot,onRevoke}){
 const decode=row=>({id:row.source_id,sourceRef:row.source_ref,sourceSha256:row.source_sha256,size:row.source_bytes,format:row.source_format,name:row.display_name,version:row.source_version,deleted:!!row.deleted_at,pendingCleanup:!!row.deleted_at&&!row.cleanup_complete});
 async function byRef(identity,ref){return (await db.query('SELECT * FROM document_sources WHERE user_id=$1 AND tenant_id=$2 AND source_ref=$3',[identity.userId,identity.tenantId,ref])).rows[0]||null;}
 async function register(identity,{ref,sha256,size,format,name}){
  const match=/^\/uploads\/([a-f0-9-]{36})\/([a-zA-Z0-9_-]+\.(txt|md|csv|docx|xlsx|pptx|pdf))$/.exec(ref||'');
  if(!match||match[1]!==identity.tenantId||format!==match[3]||!Number.isSafeInteger(size)||size<1||size>20*1024*1024||!/^[a-f0-9]{64}$/.test(sha256))throw fail('SOURCE_INVALID',400);
  await db.query('INSERT INTO document_sources(source_id,user_id,tenant_id,source_ref,source_sha256,source_bytes,source_format,display_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,source_ref) DO NOTHING',[randomUUID(),identity.userId,identity.tenantId,ref,sha256,size,format,Array.from(Buffer.from(String(name||match[2]).replace(/[\x00-\x1f\x7f]/g,'')).toString('utf8')).slice(0,200).join('')||match[2]]);
  const record=await byRef(identity,ref);if(!record||record.deleted_at||record.source_sha256!==sha256||record.source_bytes!==size)throw fail('SOURCE_CHANGED');return decode(record);
 }
 async function list(identity){return (await db.query('SELECT * FROM document_sources WHERE user_id=$1 AND tenant_id=$2 AND (deleted_at IS NULL OR cleanup_complete=FALSE) ORDER BY created_at DESC,source_id LIMIT 100',[identity.userId,identity.tenantId])).rows.map(decode);}
 async function assertLive(identity,refs){
  for(const ref of refs){const record=await byRef(identity,ref);if(record?.deleted_at)throw fail('SOURCE_DELETED');}
 }
 async function collect(identity,{sourceIds,citations}={}){
  const records=[];
  if(citations){
   for(const item of citations){const record=await byRef(identity,item.sourceRef);if(!record||record.deleted_at)throw fail('SOURCE_DELETED');if(!records.some(row=>row.source_ref===record.source_ref))records.push(record);}
  }else{
   if(!Array.isArray(sourceIds)||sourceIds.length<1||sourceIds.length>8||sourceIds.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(sourceIds).size!==sourceIds.length)throw fail('SOURCE_SELECTION_INVALID',400);
   for(const id of sourceIds){const row=(await db.query('SELECT * FROM document_sources WHERE source_id=$1 AND user_id=$2 AND tenant_id=$3 AND deleted_at IS NULL',[id,identity.userId,identity.tenantId])).rows[0];if(!row)throw fail('SOURCE_NOT_FOUND',404);records.push(row);}
  }
  let total=0;const sources=[];
  for(const row of records){total+=row.source_bytes;if(total>20*1024*1024)throw fail('SOURCE_TOTAL_LIMIT');
   const bytes=await readVerifiedChatAttachmentBytes(row.source_ref,{ref:row.source_ref,sha256:row.source_sha256,size:row.source_bytes},{uploadsRoot,identity,includeBytes:true,maxBytes:20*1024*1024});
   sources.push({id:row.source_id,ref:row.source_ref,sha256:row.source_sha256,version:row.source_version,format:row.source_format,data:Uint8Array.from(bytes)});
  }
  return sources;
 }
 async function search(identity,{sourceIds,query,citations,signal}){
  if(signal?.aborted)throw fail('SOURCE_SEARCH_CANCELLED');
  if(activeSearches>=2)throw fail('SOURCE_SEARCH_BUSY',503);
  if(!citations&&(typeof query!=='string'||query.length>256||!query.trim()))throw fail('SOURCE_QUERY_INVALID',400);
  activeSearches++;
  try{
   const sources=await collect(identity,{sourceIds,citations});
   if(signal?.aborted)throw fail('SOURCE_SEARCH_CANCELLED');
   const result=await new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'source-search-worker.cjs'),{workerData:{tenantId:identity.tenantId,sources,query,citations},transferList:sources.map(source=>source.data.buffer),resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
    let response,failure;const stop=code=>{failure=fail(code);void worker.terminate();};
    const cancel=()=>stop('SOURCE_SEARCH_CANCELLED'),timer=setTimeout(()=>stop('SOURCE_SEARCH_TIMEOUT'),10000);
    signal?.addEventListener('abort',cancel,{once:true});worker.on('message',value=>{if(response)stop('SOURCE_SEARCH_FAILED');else response=value;});worker.on('error',()=>{failure=fail('SOURCE_SEARCH_FAILED');});
    worker.on('exit',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(failure)return reject(failure);if(code!==0||!response?.ok)return reject(fail('SOURCE_SEARCH_FAILED'));resolve(response.result);});
    if(signal?.aborted)cancel();
   });
   // Recheck revocation after extraction; bytes/index from a deleted source never leave the request.
   for(const source of sources){const current=await byRef(identity,source.ref);if(!current||current.deleted_at||current.source_version!==source.version||current.source_sha256!==source.sha256)throw fail('SOURCE_CHANGED');}
   return result;
  }finally{activeSearches--;}
 }
 async function revoke(identity,id){
  if(!UUID.test(id))throw fail('SOURCE_NOT_FOUND',404);
  const pending=await db.transaction(async tx=>{
   let row=(await tx.query('SELECT * FROM document_sources WHERE source_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',[id,identity.userId,identity.tenantId])).rows[0];
   if(!row)throw fail('SOURCE_NOT_FOUND',404);if(row.deleted_at&&row.cleanup_complete)return {row,done:true};
   if(!row.deleted_at)row=(await tx.query('UPDATE document_sources SET deleted_at=now(),source_version=source_version+1 WHERE source_id=$1 RETURNING *',[id])).rows[0];
   const conversations=(await tx.query("UPDATE conversations SET source_revocation_pending=TRUE,source_context_start=jsonb_array_length(messages) WHERE user_id=$1 AND (strpos(messages::text,$2)>0 OR EXISTS(SELECT 1 FROM memory_records m JOIN document_sources s ON s.source_id=m.source_id WHERE m.user_id=$1 AND m.tenant_id=$3 AND s.source_ref=$2) OR id IN (SELECT conversation_id FROM agent_runs WHERE user_id=$1 AND tenant_id=$3 AND strpos(request::text,$2)>0 AND state IN ('queued','running','waiting_external','awaiting_confirmation','cancelling'))) RETURNING id",[identity.userId,row.source_ref,identity.tenantId])).rows;
   return {row,conversations};
  });
  if(pending.done)return {deleted:true,alreadyDeleted:true};
  try{
   await onRevoke(identity,pending.conversations.map(row=>row.id));
   const name=pending.row.source_ref.split('/').at(-1);let root,tenant,returnMissing=false;
   try{root=pinDirectory(fs.realpathSync(uploadsRoot));tenant=root.openDirectory(identity.tenantId);tenant.unlinkFile(name);}catch(error){if(error.code!=='ENOENT'){try{fs.lstatSync(path.join(uploadsRoot,identity.tenantId,name));}catch(missing){if(missing.code==='ENOENT')returnMissing=true;else throw error;}if(!returnMissing)throw error;}}finally{tenant?.close();root?.close();}
   await db.transaction(async tx=>{
    for(const conversation of pending.conversations)await tx.query('UPDATE conversations SET source_context_start=jsonb_array_length(messages),native_session_id=NULL,native_session_key_sha256=NULL,source_revocation_pending=FALSE WHERE id=$1 AND user_id=$2',[conversation.id,identity.userId]);
    await tx.query('UPDATE document_sources SET cleanup_complete=TRUE WHERE source_id=$1',[id]);
   });
  }catch{throw fail('SOURCE_REVOCATION_PENDING');}
  return {deleted:true,invalidatedConversations:pending.conversations.length};
 }
 return {register,list,byRef,assertLive,search,revoke};
}
module.exports={createSourceStore};
