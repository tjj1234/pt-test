'use strict';
const {randomUUID,createHash}=require('node:crypto');
const YAML=require('yaml');
const {createSkillReleaseSnapshot,pinSkillReleases}=require('./release-snapshot.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const sha=value=>createHash('sha256').update(value).digest('hex');
function validateRelease(input){
 if(!input||Object.keys(input).some(k=>!['skillId','version','files'].includes(k))||!ID.test(input.skillId||'')||input.skillId.length>80||typeof input.version!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version)||!Array.isArray(input.files)||!input.files.length||input.files.length>16)throw fail('SKILL_RELEASE_INVALID',400);
 let size=0;const files=input.files.map(file=>{
  if(!file||Object.keys(file).sort().join(',')!=='content,path'||typeof file.path!=='string'||file.path.length>240||! /\.(md|txt|json|yaml|yml)$/i.test(file.path)||typeof file.content!=='string'||Buffer.from(file.content).toString('utf8')!==file.content)throw fail('SKILL_FILE_INVALID',400);
  size+=Buffer.byteLength(file.content);if(size>256*1024)throw fail('SKILL_RELEASE_LIMIT',400);return {path:file.path,content:file.content};
 });
 const main=files.find(file=>file.path==='SKILL.md');if(!main||Buffer.byteLength(main.content)>64*1024)throw fail('SKILL_MAIN_REQUIRED',400);
 const match=/^---\r?\n([\s\S]{1,4096}?)\r?\n---(?:\r?\n|$)/.exec(main.content);if(!match||match[1].split('\n').length>64)throw fail('SKILL_FRONTMATTER_INVALID',400);
 let meta;try{const doc=YAML.parseDocument(match[1],{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error();meta=doc.toJS({maxAliasCount:0});}catch{throw fail('SKILL_FRONTMATTER_INVALID',400);}
 if(!meta||meta.name!==input.skillId||typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>500||meta['disable-model-invocation']===true||!main.content.slice(match[0].length).trim())throw fail('SKILL_FRONTMATTER_INVALID',400);
 let snapshot;try{snapshot=createSkillReleaseSnapshot({...input,files});}catch{throw fail('SKILL_RELEASE_INVALID',400);}
 return {files,snapshot,description:meta.description,body:main.content.slice(match[0].length).trim()};
}
function createSkillPublicationStore({db,onInvalidate}){
 const locks=new Set(),identityArgs=i=>[i.userId,i.tenantId];
 async function owned(identity){if((await db.query('SELECT tenant_id FROM users WHERE id=$1',[identity.userId])).rows[0]?.tenant_id!==identity.tenantId)throw fail('SKILL_NOT_FOUND',404);}
 async function list(identity){await owned(identity);return (await db.query('SELECT p.*,r.release_id,r.version,r.content_hash,r.files,r.created_at FROM skill_publications p JOIN skill_releases r ON r.release_id=p.active_release_id WHERE p.user_id=$1 AND p.tenant_id=$2 ORDER BY p.skill_id LIMIT 100',identityArgs(identity))).rows.map(({files,...row})=>({...row,fileCount:files.length}));}
 async function publish(identity,input){await owned(identity);const checked=validateRelease(input);if(locks.has(identity.userId))throw fail('SKILL_UPDATE_BUSY');locks.add(identity.userId);try{return await db.transaction(async tx=>{
  const pub=(await tx.query('SELECT * FROM skill_publications WHERE user_id=$1 AND tenant_id=$2 AND skill_id=$3 FOR UPDATE',[...identityArgs(identity),input.skillId])).rows[0];if(pub?.pending_cleanup)throw fail('SKILL_CLEANUP_PENDING');
  const counts=(await tx.query('SELECT count(*) AS n FROM skill_releases WHERE user_id=$1',[identity.userId])).rows[0];if(Number(counts.n)>=1000)throw fail('SKILL_RELEASE_LIMIT',400);
  if(!pub&&Number((await tx.query('SELECT count(*) AS n FROM skill_publications WHERE user_id=$1',[identity.userId])).rows[0].n)>=100)throw fail('SKILL_PUBLICATION_LIMIT',400);
  let release=(await tx.query('SELECT * FROM skill_releases WHERE user_id=$1 AND skill_id=$2 AND version=$3',[identity.userId,input.skillId,input.version])).rows[0];
  if(release&&release.content_hash!==checked.snapshot.contentHash)throw fail('SKILL_VERSION_IMMUTABLE');
  if(!release)release=(await tx.query('INSERT INTO skill_releases(release_id,user_id,tenant_id,skill_id,version,content_hash,files) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',[randomUUID(),...identityArgs(identity),input.skillId,input.version,checked.snapshot.contentHash,JSON.stringify(checked.files)])).rows[0];
  await tx.query('INSERT INTO skill_publications(user_id,tenant_id,skill_id,active_release_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,skill_id) DO UPDATE SET active_release_id=EXCLUDED.active_release_id,enabled=TRUE,revision=skill_publications.revision+1',[...identityArgs(identity),input.skillId,release.release_id]);
  return {ok:true,releaseId:release.release_id,skillId:release.skill_id,version:release.version,contentHash:release.content_hash};
 });}finally{locks.delete(identity.userId);}}
 async function pin(identity,ids=[]){await owned(identity);if(!Array.isArray(ids)||ids.length>1||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!UUID.test(id)))throw fail('SKILL_SELECTION_INVALID',400);
  const skills=[];for(const id of ids){const row=(await db.query('SELECT r.* FROM skill_releases r JOIN skill_publications p ON p.active_release_id=r.release_id WHERE r.release_id=$1 AND r.user_id=$2 AND r.tenant_id=$3 AND p.enabled=TRUE AND p.pending_cleanup=FALSE',[id,...identityArgs(identity)])).rows[0];if(!row)throw fail('SKILL_NOT_AVAILABLE');skills.push(identityOf(row));}
  const snapshot=pinSkillReleases(skills.map(skill=>({schemaVersion:1,...skill})));return {schemaVersion:1,skills,pinHash:sha(JSON.stringify(snapshot))};
 }
 function identityOf(row){return {releaseId:row.release_id,skillId:row.skill_id,version:row.version,contentHash:row.content_hash};}
 async function readPinned(identity,pinSnapshot,id){
  await owned(identity);if(!UUID.test(id||'')||!pinSnapshot||pinSnapshot.schemaVersion!==1||!Array.isArray(pinSnapshot.skills)||pinSnapshot.skills.length>1)throw fail('SKILL_NOT_PINNED');
  if(pinSnapshot.pinHash!==sha(JSON.stringify(pinSkillReleases(pinSnapshot.skills.map(skill=>({schemaVersion:1,...skill}))))))throw fail('SKILL_NOT_PINNED');
  const pinned=pinSnapshot.skills.find(skill=>skill.releaseId===id);if(!pinned)throw fail('SKILL_NOT_PINNED');
  const row=(await db.query('SELECT r.*,p.enabled,p.pending_cleanup FROM skill_releases r JOIN skill_publications p ON p.user_id=r.user_id AND p.tenant_id=r.tenant_id AND p.skill_id=r.skill_id WHERE r.release_id=$1 AND r.user_id=$2 AND r.tenant_id=$3',[id,...identityArgs(identity)])).rows[0];
  if(!row||!row.enabled||row.pending_cleanup||Object.entries(identityOf(row)).some(([key,value])=>pinned[key]!==value))throw fail('SKILL_NOT_AVAILABLE');
  const checked=validateRelease({skillId:row.skill_id,version:row.version,files:row.files});if(checked.snapshot.contentHash!==pinned.contentHash)throw fail('SKILL_SNAPSHOT_CHANGED');
  return {...pinned,files:checked.files,body:checked.body,description:checked.description};
 }
 async function disable(identity,skillId){await owned(identity);if(!ID.test(skillId||'')||locks.has(identity.userId))throw fail('SKILL_UPDATE_BUSY');locks.add(identity.userId);
  try{
   await db.transaction(async tx=>{const row=(await tx.query('UPDATE skill_publications SET enabled=FALSE,pending_cleanup=TRUE,revision=revision+CASE WHEN enabled THEN 1 ELSE 0 END WHERE user_id=$1 AND tenant_id=$2 AND skill_id=$3 RETURNING skill_id',[...identityArgs(identity),skillId])).rows[0];if(!row)throw fail('SKILL_NOT_FOUND',404);await tx.query('UPDATE conversations SET skill_revocation_pending=TRUE WHERE user_id=$1',[identity.userId]);});
   try{await onInvalidate(identity);}catch{throw fail('SKILL_CLEANUP_PENDING',503);}
   await db.transaction(async tx=>{await tx.query('UPDATE conversations SET native_session_id=NULL,native_session_key_sha256=NULL,source_context_start=jsonb_array_length(messages),skill_revocation_pending=FALSE WHERE user_id=$1',[identity.userId]);await tx.query('UPDATE skill_publications SET pending_cleanup=FALSE WHERE user_id=$1 AND tenant_id=$2 AND skill_id=$3',[...identityArgs(identity),skillId]);});return {ok:true,disabled:true};
  }finally{locks.delete(identity.userId);}
 }
 return {list,publish,pin,readPinned,disable};
}
module.exports={createSkillPublicationStore,validateRelease};
