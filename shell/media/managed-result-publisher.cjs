'use strict';
const {ingestMediaAssetCandidate}=require('./asset-ingest-candidate.cjs');
const {controlledMediaParameters}=require('../tasks/controlled-media-parameters.cjs');
const fail=code=>Object.assign(new Error('Generated media could not be saved locally; do not resubmit'),{code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);

// Host composition only. The caller must supply a network-pinned anonymous
// fetch and the reviewed filesystem publisher; no implicit global network.
function createManagedResultPublisher({workspaceRoot,allowedHosts,fetchImpl,writeArtifact,onPublished=null}={}){
 if(typeof workspaceRoot!=='string'||!Array.isArray(allowedHosts)||allowedHosts.length===0||typeof fetchImpl!=='function'||typeof writeArtifact!=='function'||(onPublished!==null&&typeof onPublished!=='function'))throw fail('MEDIA_PUBLISH_CONFIGURATION_INVALID');
 const hosts=Object.freeze([...allowedHosts]);
 return async function publish(result,{identity,runId,signal}={}){
  if(!uuid(identity?.userId)||!uuid(identity?.tenantId)||!uuid(runId)||!result||!['image','video'].includes(result.kind)||typeof result.url!=='string'||result.url.length>8192)throw fail('MEDIA_PUBLISH_ARGUMENT_INVALID');
  const {kind,url}=result,tenantId=identity.tenantId,metadata={};
  for(const key of ['taskType','label','model','provider'])if(Object.hasOwn(result,key)){
   const value=result[key];if(typeof value!=='string'||value.length===0||value.length>256||/[\x00-\x1f\x7f]/.test(value))throw fail('MEDIA_PUBLISH_ARGUMENT_INVALID');metadata[key]=value;
  }
  if(metadata.taskType&&!((kind==='image'?['text2image','image2image']:['text2video','image2video']).includes(metadata.taskType)))throw fail('MEDIA_PUBLISH_ARGUMENT_INVALID');
  if(Object.hasOwn(result,'elapsedMs')){if(typeof result.elapsedMs!=='number'||!Number.isFinite(result.elapsedMs)||result.elapsedMs<0)throw fail('MEDIA_PUBLISH_ARGUMENT_INVALID');metadata.elapsedMs=result.elapsedMs;}
  try{
   const asset=await ingestMediaAssetCandidate({resultUrl:url,expectedKind:kind,allowedHosts:hosts,fetchImpl,signal,timeoutMs:60000});
   const artifact=await writeArtifact({workspaceRoot,tenantId,runId,buffer:asset.buffer,kind,mime:asset.mime});
   const match=typeof artifact?.rel==='string'&&/^media-results\/([a-f0-9-]{36})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|gif|avif|mp4|webm|mov))$/i.exec(artifact.rel);
   if(!match||match[1]!==runId||!uuid(match[2].split('.')[0])||artifact.kind!==kind||artifact.mime!==asset.mime||artifact.size!==asset.byteCount||artifact.sha256!==asset.sha256)throw fail('MEDIA_PUBLISH_RECEIPT_INVALID');
   const media=Object.freeze({kind,url:'/api/run-media/'+runId+'/'+match[2],managed:Object.freeze({rel:artifact.rel,mime:artifact.mime,size:artifact.size,sha256:artifact.sha256})});
   if(onPublished)await onPublished(media);
   // Original signed URLs never cross back to the SDK or enter this receipt.
   return Object.freeze({...media,...metadata});
  }catch(error){
   throw fail(error?.code==='MEDIA_PUBLISH_RECEIPT_INVALID'?'MEDIA_PUBLISH_RECEIPT_INVALID':'MEDIA_RESULT_LOCAL_SAVE_FAILED');
  }
 };
}

// Execute exactly once. A durable remote terminal acknowledgement must exist
// before local downloading/writing; local errors never become remote failures.
function createManagedMediaExecutor({executeMedia,publishResult,inputImageUrl=null}={}){
 if(typeof executeMedia!=='function'||typeof publishResult!=='function')throw fail('MEDIA_PUBLISH_CONFIGURATION_INVALID');
 if(inputImageUrl!==null&&typeof inputImageUrl!=='string')throw fail('MEDIA_PUBLISH_CONFIGURATION_INVALID');
 return async(context,args,options={})=>{
  let remoteSucceeded=false;
  if(typeof options.onExternalResult!=='function')throw fail('MEDIA_REMOTE_ACK_REQUIRED');
  const parameters=controlledMediaParameters(args?.taskType),effectiveArgs={...args};
  delete effectiveArgs.imageUrl;delete effectiveArgs.inputImageUrl;
  if(args.taskType.startsWith('image2')){
   if(!inputImageUrl)throw fail('MEDIA_INPUT_IMAGE_REQUIRED');
   effectiveArgs.inputImageUrl=options.preparedInputImageUrl||inputImageUrl;
  }
  const result=await executeMedia(context,effectiveArgs,{...options,...parameters.executorOptions,onExternalResult:async metadata=>{
   await options.onExternalResult(metadata);
   remoteSucceeded=metadata.outcome==='succeeded';
  }});
  if(!remoteSucceeded)throw fail('MEDIA_REMOTE_ACK_REQUIRED');
  return publishResult(result,{context,signal:options.signal});
 };
}
module.exports={createManagedResultPublisher,createManagedMediaExecutor};
