'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {pinDirectory}=require('../runtime/backup-fs.cjs');
const {readVerifiedChatAttachmentBytes}=require('./chat-request.cjs');
const fail=code=>Object.assign(new Error('Read-only analysis inputs could not be prepared'),{code});
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
let reserved=0;const live=new WeakSet();
function directory(parent,name){try{return parent.openDirectory(name);}catch{try{parent.mkdir(name,0o700);}catch{}return parent.openDirectory(name);}}
async function prepareAnalysisWorkspace({workspaceRoot,uploadsRoot,identity,runId,refs=[],evidence=[],signal,runtimeRoot,verifyBackend}={}){
 if(!uuid(identity?.tenantId)||!uuid(runId)||!Array.isArray(refs)||refs.length>8)throw fail('ANALYSIS_INPUT_INVALID');
 if(reserved>=2)throw fail('ANALYSIS_PROCESS_BUSY');reserved++;
 const files=[],created=[];let total=0,root,tenant,inputs,run,ready=false;
 try{
  const parent=pinDirectory(fs.realpathSync(path.dirname(workspaceRoot)));
  try{root=directory(parent,path.basename(workspaceRoot));}finally{parent.close();}
  tenant=directory(root,identity.tenantId);inputs=directory(tenant,'.analysis-inputs');run=directory(inputs,runId);
  for(const [index,ref] of refs.entries()){
   if(signal?.aborted)throw fail('RUN_CANCELLED');
   const snapshot=evidence.find(item=>item.ref===ref),bytes=await readVerifiedChatAttachmentBytes(ref,snapshot,{uploadsRoot,identity,includeBytes:true,maxBytes:1024*1024});
   total+=bytes.length;if(total>2*1024*1024)throw fail('ANALYSIS_INPUT_LIMIT');
   const ext=path.extname(ref).slice(1);if(!['txt','md','csv','pdf','docx','xlsx','pptx','doc','xls','ppt','zip'].includes(ext))throw fail('ANALYSIS_FORMAT_UNSUPPORTED');
   const name='input-'+(index+1)+'.'+ext;let fd;
   try{fd=run.openFile(name,{createExclusive:true,writeOnly:true,mode:0o400});created.push(name);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}
   catch(error){if(fd!==undefined)throw error;const existing=run.openFile(name);try{const stat=fs.fstatSync(existing);if(stat.nlink!==1||stat.size!==bytes.length||createHash('sha256').update(fs.readFileSync(existing)).digest('hex')!==snapshot.sha256)throw fail('ANALYSIS_SNAPSHOT_CHANGED');}finally{fs.closeSync(existing);}}
   finally{if(fd!==undefined)fs.closeSync(fd);}
   files.push({name,size:bytes.length,sha256:snapshot.sha256});
  }
  if(signal?.aborted)throw fail('RUN_CANCELLED');
  const prepared={root:fs.realpathSync(path.join(workspaceRoot,identity.tenantId,'.analysis-inputs',runId)),files,runtimeRoot};
  if(verifyBackend)await verifyBackend(prepared);else (await import('../runtime/offline-analysis.mjs')).offlineAnalysisArguments({workspaceRoot:prepared.root,runtimeRoot,code:'pass'});
  ready=true;live.add(prepared);return prepared;
 }finally{if(!ready){for(const name of created){try{run?.unlinkFile(name);}catch{}}reserved--;}run?.close();inputs?.close();tenant?.close();root?.close();}
}
function releaseAnalysisWorkspace(prepared){
 if(!prepared||!live.has(prepared))return;live.delete(prepared);let directory;
 try{directory=pinDirectory(prepared.root);for(const file of prepared.files)directory.unlinkFile(file.name);}
 finally{directory?.close();reserved--;}
}
module.exports={prepareAnalysisWorkspace,releaseAnalysisWorkspace};
