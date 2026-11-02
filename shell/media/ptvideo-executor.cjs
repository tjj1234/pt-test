'use strict';
// Host-only adapter glue. Route qualification and DSH execution stay in their
// existing modules; this adapter never selects a model or falls back on failure.
const { createPtVideoBridge } = require('./ptvideo-bridge.cjs');
const { guardPtVideoResult } = require('./ptvideo-result-guard-candidate.cjs');
const PYTHON_ADAPTER_IDS = new Set(['pt-python-video-v1','pt-python-seedance-v1']);
const fail = (code, fields={}) => Object.assign(new Error(code),{code,...fields});
async function executePtVideoRoute(routing,args,opts={}) {
  if (!PYTHON_ADAPTER_IDS.has(routing?.adapterId) || !['text2video','image2video'].includes(routing.taskType)) throw fail('MEDIA_ADAPTER_UNSUPPORTED');
  if (typeof args?.prompt !== 'string' || !args.prompt.trim() || args.stylePreset) throw fail('MEDIA_REQUEST_INVALID');
  for(const name of ['onExternalIntent','onExternalSubmissionStarted','onExternalTaskId','onExternalResult']) {
    if(typeof opts[name] !== 'function') throw fail('MEDIA_LIFECYCLE_REQUIRED');
  }
  const allowed = new Set(['taskType','prompt','inputImageUrl','imageUrl','duration','resolution','ratio']);
  if(Object.keys(args).some(key=>!allowed.has(key)))throw fail('MEDIA_REQUEST_FIELD_UNSUPPORTED');
  const request={model:routing.model,kind:routing.kind,prompt:args.prompt.trim(),duration:opts.duration ?? args.duration ?? opts.parsedParams?.duration ?? 5,resolution:opts.resolution ?? args.resolution ?? opts.parsedParams?.resolution ?? '720p',ratio:opts.ratio ?? args.ratio ?? 'adaptive'};
  if(!Number.isSafeInteger(request.duration)||request.duration<2||request.duration>30||typeof request.resolution!=='string'||!['480P','720P','1080P'].includes(request.resolution.toUpperCase())||!['adaptive','16:9','4:3','1:1','3:4','9:16'].includes(request.ratio))throw fail('MEDIA_REQUEST_PARAMETERS_INVALID');
  const image=args.inputImageUrl ?? args.imageUrl;
  if(routing.needsImage && (typeof image !== 'string' || !image)) throw fail('MEDIA_INPUT_IMAGE_REQUIRED');
  if(image !== undefined) {
    if(typeof image !== 'string' || !image) throw fail('MEDIA_INPUT_IMAGE_INVALID');
    if(routing.kind==='seedance' && !/^asset:\/\/[A-Za-z0-9_.-]+$/.test(image)) throw fail('MEDIA_SEEDANCE_ASSET_REQUIRED');
    if(routing.kind!=='seedance') {
      let url;try {url=new URL(image);}catch {throw fail('MEDIA_INPUT_IMAGE_INVALID');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/[\x00-\x20\x7f]/.test(image))throw fail('MEDIA_INPUT_IMAGE_INVALID');
    }
    request.first_frame=image;
  }
  const metadata=Object.freeze({provider:routing.provider,model:routing.model,taskType:routing.taskType,kind:routing.kind,endpoint:routing.path});
  const execute=opts.ptVideoBridge ?? createPtVideoBridge({validateResult:guardPtVideoResult});
  if(typeof execute!=='function')throw fail('MEDIA_BRIDGE_CONFIGURATION_INVALID');
  const startedAt=Date.now();
  const result=await execute({apiKey:opts.apiKey,request,baseUrl:opts.baseUrl ?? 'https://api.powertokens.ai',signal:opts.signal,timeoutMs:opts.timeoutMs ?? 180000,
    onBeforeSubmit:async()=>{await opts.onExternalIntent(metadata);await opts.onExternalSubmissionStarted();},
    onTaskId:async({taskId})=>opts.onExternalTaskId({...metadata,taskId}),
    onResult:async value=>{
      if(['completed','completed_partial','completed_local_save_failed','completed_locally_cancelled'].includes(value.outcome))
        await opts.onExternalResult({...metadata,outcome:'succeeded',providerStatus:'succeeded',hasResult:value.resultUrls.length>0});
    },
  });
  if(result.outcome==='remote_failed'||result.outcome==='remote_cancelled')await opts.onExternalResult({...metadata,outcome:result.outcome==='remote_failed'?'failed':'cancelled',providerStatus:result.outcome==='remote_failed'?'failed':'cancelled',hasResult:false});
  if(result.outcome!=='completed'||result.ok!==true)throw fail(result.errorCode || 'MEDIA_ENGINE_INCOMPLETE',{taskId:result.taskId,submissionMayHaveStarted:result.outcome!=='not_submitted'});
  return {taskType:routing.taskType,label:routing.label,model:routing.model,provider:routing.provider,kind:'video',url:result.resultUrls[0],elapsedMs:Date.now()-startedAt};
}
module.exports={executePtVideoRoute};
