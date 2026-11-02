'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {openTenantArtifact}=require('../runtime/artifact-open.cjs');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const MIME=Object.freeze({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'});
const fail=code=>Object.assign(new Error('Managed media is unavailable'),{code});
function mediaByteRange(value,size){
 if(!Number.isSafeInteger(size)||size<=0)throw fail('MEDIA_RANGE_INVALID');
 if(value===undefined)return null;
 if(typeof value!=='string'||value.length>128||!Number.isSafeInteger(size)||size<=0)throw fail('MEDIA_RANGE_INVALID');
 const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
 if(!match||(!match[1]&&!match[2]))throw fail('MEDIA_RANGE_INVALID');
 const left=match[1]?Number(match[1]):null,right=match[2]?Number(match[2]):null;
 if((left!==null&&!Number.isSafeInteger(left))||(right!==null&&!Number.isSafeInteger(right)))throw fail('MEDIA_RANGE_INVALID');
 const start=left===null?Math.max(0,size-right):left,end=left===null?size-1:right===null?size-1:Math.min(right,size-1);
 if((left===null&&right===0)||start<0||start>=size||start>end)throw fail('MEDIA_RANGE_INVALID');
 return {start,end};
}
function createManagedMediaReader({workspaceRoot,getRun,openArtifact=openTenantArtifact}={}){
 if(typeof workspaceRoot!=='string'||!path.isAbsolute(workspaceRoot)||typeof getRun!=='function'||typeof openArtifact!=='function')throw fail('MEDIA_READ_CONFIGURATION_INVALID');
 return async(req,res,identity,{runId,filename}={})=>{
  const empty=(status,headers={})=>{res.writeHead(status,{'Cache-Control':'no-store','Content-Length':0,...headers});res.end();};
  if(!['GET','HEAD'].includes(req.method))return empty(405,{Allow:'GET, HEAD'});
  const name=typeof filename==='string'&&/^([a-f0-9-]{36})\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)$/i.exec(filename);
  if(!uuid(identity?.userId)||!uuid(identity?.tenantId)||!uuid(runId)||!name||!uuid(name[1]))return empty(400);
  try{
   const run=await getRun(identity,runId);
   if(!run||run.runId!==runId||run.userId!==identity.userId||run.tenantId!==identity.tenantId)throw fail('NOT_FOUND');
  }catch(error){return empty(error?.code==='NOT_FOUND'?404:503);}
  if(res.destroyed)return;
  const canonicalName=filename.toLowerCase(),extension=name[2].toLowerCase(),mime=MIME[extension];
  let opened;
  try{opened=openArtifact({workspaceRoot,tenantId:identity.tenantId,relativePath:'media-results/'+runId.toLowerCase()+'/'+canonicalName});}
  catch{return empty(404);}
  let fd=opened.fd;
  const close=()=>{if(fd!==undefined){fs.closeSync(fd);fd=undefined;}};
  const size=opened.stat.size,limit=mime.startsWith('image/')?50*1024*1024:200*1024*1024;
  if(!Number.isSafeInteger(size)||size<=0||size>limit){close();return empty(404);}
  let range;
  try{range=mediaByteRange(req.headers.range,size);}catch{close();return empty(416,{'Content-Range':'bytes */'+size});}
  const headers={'Content-Type':mime,'Content-Length':range?range.end-range.start+1:size,'Cache-Control':'no-store','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; sandbox"};
  if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range?206:200,headers);
  if(req.method==='HEAD'){close();return res.end();}
  try{
   const stream=fs.createReadStream(opened.path,{fd,autoClose:true,...(range||{})});fd=undefined;
   stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
  }catch{close();res.destroy();}
 };
}
module.exports={createManagedMediaReader,mediaByteRange};
