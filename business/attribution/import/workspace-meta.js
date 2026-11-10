"use strict";
// First successful connection has its own immutable authority. Publish complete
// bytes with link(O_EXCL semantics); no expiring locks or PID-liveness guesses.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const fail=code=>Object.assign(new Error('Workspace metadata could not be verified'),{code});
function createWorkspaceMetaStore(opts={}){
 const root=opts.storageDir||process.env.PT_IMPORT_STORAGE_DIR||path.join(__dirname,'../../../analytics/data/imports');
 function paths(workspaceId){
  const id=String(workspaceId);if(!id||id.length>255)throw fail('WORKSPACE_META_INVALID');
  const dir=path.join(root,'_workspaces');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,id.replace(/[^a-zA-Z0-9._-]/g,'_')+'.json');
  return {dir,file,first:file+'.first-connected'};
 }
 function read(file){
  let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  try{
   const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw fail('WORKSPACE_META_CORRUPTED');
   let row;try{row=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw fail('WORKSPACE_META_CORRUPTED');}
   if(!row||typeof row!=='object'||Array.isArray(row))throw fail('WORKSPACE_META_CORRUPTED');return row;
  }finally{fs.closeSync(fd);}
 }
 function stamp(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw fail('WORKSPACE_META_TIMESTAMP_INVALID');return value;}
 function writeTemp(file,row){
  const bytes=Buffer.from(JSON.stringify(row,null,2));if(bytes.length>65536)throw fail('WORKSPACE_META_LIMIT');
  const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}finally{fs.closeSync(fd);}
  return temp;
 }
 function syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function publishFirst(p,workspaceId,value){
  const prior=read(p.first);if(prior){stamp(prior.firstConnectedAt);return prior;}
  const temp=writeTemp(p.first,{workspaceId,firstConnectedAt:stamp(value)});
  try{try{fs.linkSync(temp,p.first);syncDirectory(p.dir);}catch(error){if(error.code!=='EEXIST')throw error;}}
  finally{fs.unlinkSync(temp);}
  const winner=read(p.first);if(!winner)throw fail('WORKSPACE_META_CORRUPTED');stamp(winner.firstConnectedAt);return winner;
 }
 function load(workspaceId){
  const p=paths(workspaceId),metadata=read(p.file),first=read(p.first);
  if(first)stamp(first.firstConnectedAt);if(metadata?.firstConnectedAt)stamp(metadata.firstConnectedAt);
  return {...(metadata||{}),workspaceId,firstConnectedAt:first?.firstConnectedAt||metadata?.firstConnectedAt||null,updatedAt:metadata?.updatedAt||first?.firstConnectedAt||null};
 }
 function save(row){
  if(!row||typeof row!=='object')throw fail('WORKSPACE_META_INVALID');
  const {workspaceId}=row,p=paths(workspaceId),existing=load(workspaceId);
  // Seed from a legacy committed value before considering any new proposal.
  const proposal=existing.firstConnectedAt||row.firstConnectedAt;
  const first=proposal?publishFirst(p,workspaceId,proposal):null;
  const next={...existing,...row,workspaceId,firstConnectedAt:first?.firstConnectedAt||null,updatedAt:row.updatedAt||new Date().toISOString()};
  const temp=writeTemp(p.file,next);try{fs.renameSync(temp,p.file);syncDirectory(p.dir);}finally{try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return load(workspaceId);
 }
 function markFirstConnected(workspaceId,atIso){
  const existing=load(workspaceId),p=paths(workspaceId);
  const first=publishFirst(p,workspaceId,existing.firstConnectedAt||atIso||new Date().toISOString());
  return {...existing,firstConnectedAt:first.firstConnectedAt,updatedAt:existing.updatedAt||first.firstConnectedAt};
 }
 return {root,load,save,markFirstConnected};
}
module.exports={createWorkspaceMetaStore};
