'use strict';
const {createPtAssetUploadBridge}=require('../media/pt-asset-upload-bridge-r2-candidate.cjs');
const {setTimeout:delay}=require('node:timers/promises');
const fail=code=>Object.assign(new Error(code),{code});

// Asset upload is a separate external operation from paid video generation.
// A known task is recoverable by GET only; no failure path resubmits its POST.
function createMediaInputAsset({operations,emit,bridgeFactory=createPtAssetUploadBridge}={}){
 if(!operations||typeof emit!=='function'||typeof bridgeFactory!=='function')throw fail('MEDIA_ASSET_CONFIGURATION_INVALID');
 return async function upload({identity,taskRun,requestId,bytes,filename='reference.png',apiKey,signal}={}){
  if(!identity?.userId||!identity?.tenantId||!taskRun?.runId||!taskRun?.leaseOwner||
      !/^[0-9a-f-]{36}$/i.test(requestId||'')||!Buffer.isBuffer(bytes)||!bytes.length||!apiKey)
    throw fail('MEDIA_ASSET_INPUT_INVALID');
  const operationKey=`${taskRun.runId}:${requestId}:asset`;
  let intent=false,started=false,taskId=null,assetId=null;
  const bridge=bridgeFactory();
  const persistSuccess=async result=>{
   if(!result?.ok||result.outcome!=='succeeded'||result.taskId!==taskId||result.assetId!==assetId)
     throw fail('MEDIA_ASSET_UPLOAD_INCOMPLETE');
   await operations.recordSubmissionResult(identity,taskRun.runId,operationKey,{runLeaseOwner:taskRun.leaseOwner,
    outcome:'succeeded',providerStatus:'succeeded',queried:true,observedAt:new Date().toISOString()});
   return `asset://${assetId}`;
  };
  try{
   const result=await bridge.upload({buffer:bytes,filename,apiKey,signal,
    onBeforeSubmit:async()=>{
     if(signal?.aborted||taskRun.signal?.aborted)throw fail('SESSION_ABORTED');
     await operations.createIntent(identity,taskRun.runId,{operationKey,provider:'powertokens_asset',runLeaseOwner:taskRun.leaseOwner});intent=true;
    },
    onSubmissionStarted:async()=>{if(!intent||signal?.aborted||taskRun.signal?.aborted)throw fail('SESSION_ABORTED');started=true;},
    onTaskId:async({taskId:value})=>{taskId=value;await operations.recordTaskId(identity,taskRun.runId,operationKey,{taskId:value,runLeaseOwner:taskRun.leaseOwner});},
    onAssetId:async({assetId:value})=>{assetId=value;await emit('state',{action:'media_input_asset_id',operationKey,assetId:value,taskId});},
   });
   return await persistSuccess(result);
  }catch(error){
   // A persisted task ID permits an anonymous GET-only recovery. This never
   // submits bytes again and keeps generation behind the durable asset ID.
   if(taskId&&!signal?.aborted&&!taskRun.signal?.aborted &&
      !['ASSET_ENGINE_PROTOCOL_INVALID','ASSET_ENGINE_RESULT_INVALID','ASSET_ENGINE_CANCELLED'].includes(error?.code)){
    for(let attempt=0;attempt<4&&!signal?.aborted&&!taskRun.signal?.aborted;attempt++){
     if(attempt){try{await delay(3000,undefined,{signal});}catch{break;}}
     try{
      const recovered=await bridge.recover({taskId,signal,timeoutMs:30000,pollTimeout:30,onAssetId:async({assetId:value})=>{
       assetId=value;await emit('state',{action:'media_input_asset_id',operationKey,assetId:value,taskId});
      }});
      return await persistSuccess(recovered);
     }catch{/* retain task ID for later manual GET-only reconciliation */}
    }
   }
   if(intent&&!started){
    try{await operations.recordSubmissionResult(identity,taskRun.runId,operationKey,{runLeaseOwner:taskRun.leaseOwner,
      outcome:'cancelled',reason:'not_submitted',observedAt:new Date().toISOString()});}catch{}
   }else if(intent&&started&&!taskId){
    try{await operations.markUnknownSubmission(identity,taskRun.runId,operationKey,{runLeaseOwner:taskRun.leaseOwner,
      reason:'submission_response_unknown',observedAt:new Date().toISOString()});}catch{}
   }
   throw fail('MEDIA_ASSET_UPLOAD_INCOMPLETE');
  }
 };
}
module.exports={createMediaInputAsset};
