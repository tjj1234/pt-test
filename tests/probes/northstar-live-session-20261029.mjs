// Interactive trusted-host probe. Key remains in process memory; never argv/env/files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),mediaResults=new Map();
const {callMediaRoute}=require('../../business/media/powertokens.cjs');
const evidence=path.resolve('docs/refactor/evidence/F1-live-session-20261029.json');
const state=fs.existsSync(evidence)?JSON.parse(fs.readFileSync(evidence,'utf8')):{scope:'provider-preflight-not-product-acceptance',authorization:'user-authorized-existing-key-balance-20261029',balanceReadable:false,attempts:[]};
const save=()=>fs.writeFileSync(evidence,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
let secret='',buffer='',queue=Promise.resolve();
if(!process.stdin.isTTY)throw Error('TTY required for non-echo credential input');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
out({state:'awaiting_non_echo_key'});
const safeId=x=>typeof x==='string'&&x.length<=256&&/^[a-zA-Z0-9_.:/-]+$/.test(x)&&!x.includes(secret)?x:null;
async function request(url,init={}){
 return fetch(url,{...init,redirect:'error',headers:{Authorization:'Bearer '+secret,...init.headers},signal:AbortSignal.timeout(45000)});
}
async function command(line){
 if(!secret){if(!/^[A-Za-z0-9_-]{16,256}$/.test(line))return out({error:'KEY_FORMAT_INVALID'});secret=line;out({state:'key_loaded_in_memory'});return;}
 if(line==='exit'){secret='';process.stdin.setRawMode(false);process.exit(0);}
 if(line==='catalog'){
  try{
   const response=await request('https://api.powertokens.ai/v1/models');
   const data=await response.json();const rows=Array.isArray(data.data)?data.data:[];
   const models=rows.map(x=>({id:safeId(x.id),endpoints:Array.isArray(x.supported_endpoint_types)?x.supported_endpoint_types.map(safeId).filter(Boolean):[]})).filter(x=>x.id);
   state.catalog={at:new Date().toISOString(),httpStatus:response.status,count:models.length,models};save();out({catalog:state.catalog});
  }catch{out({error:'CATALOG_UNAVAILABLE'});}return;
 }
 if(line==='chat'){
  if(state.attempts.some(x=>x.action==='chat'))return out({error:'CHAT_ALREADY_ATTEMPTED_NO_REPEAT'});
  const attempt={action:'chat',requestModel:'qwen3.8-flash',at:new Date().toISOString(),status:'submission_may_have_started',maxTokens:32};state.attempts.push(attempt);save();
  try{
   const response=await request('https://api.powertokens.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:attempt.requestModel,messages:[{role:'user',content:'Reply with exactly: NORTHSTAR_OK'}],max_tokens:32,stream:false})});
   attempt.httpStatus=response.status;
   const data=await response.json();attempt.status=response.ok?'response_received':'rejected';attempt.responseModel=safeId(data.model);attempt.upstreamModelIdentity='unknown';attempt.responseId=safeId(data.id);
   attempt.expectedText=data.choices?.[0]?.message?.content?.trim()==='NORTHSTAR_OK';
   attempt.usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isSafeInteger(data.usage?.[k])&&data.usage[k]>=0).map(k=>[k,data.usage[k]]));
   attempt.requestId=safeId(response.headers.get('x-request-id'));save();out({chat:attempt});
  }catch{attempt.status='unknown_submission';save();out({chat:attempt});}return;
 }
 if(['agent','agent-review-r2','agent-fixed-r3'].includes(line)||/^agent-media-r\d+$/.test(line)||/^agent-i2i-r\d+$/.test(line)||/^agent-t2v-r\d+$/.test(line)||/^agent-i2v-r\d+$/.test(line)||/^agent-csv-r\d+$/.test(line)||/^agent-auto-r\d+$/.test(line)||/^agent-vision-r\d+$/.test(line)||/^agent-vision-shapes-r\d+$/.test(line)){
  if(state.attempts.some(x=>x.action===line))return out({error:'AGENT_ALREADY_ATTEMPTED_NO_REPEAT'});
  const attempt={action:line,at:new Date().toISOString(),status:'started'};state.attempts.push(attempt);save();
  const {runLiveAgent}=await import('./northstar-live-agent-20261029.mjs?revision='+Date.now());
  const mode=line.startsWith('agent-media-')?'media':line.startsWith('agent-i2i-')?'media-image2image':line.startsWith('agent-t2v-')?'media-text2video':line.startsWith('agent-i2v-')?'media-image2video':line.startsWith('agent-csv-')?'csv':line.startsWith('agent-auto-')?'auto':line.startsWith('agent-vision-shapes-')?'vision-shapes':line.startsWith('agent-vision-')?'vision':'chat';
  const result=await runLiveAgent(secret,out,line==='agent'?'':line.slice('agent'.length),mode);attempt.status=result.result;save();out({agent:result});return;
 }
 if(line.startsWith('query-video ')){
  const taskId=line.slice('query-video '.length);
  if(!/^task_[A-Za-z0-9_.-]{1,252}$/.test(taskId))return out({error:'TASK_ID_INVALID'});
  const attempt={action:'query-video',taskId,at:new Date().toISOString(),readOnly:true,status:'started'};state.attempts.push(attempt);save();
  try{
   const response=await request('https://api.powertokens.ai/v1/videos/'+encodeURIComponent(taskId));
   attempt.httpStatus=response.status;
   const reader=response.body.getReader();let bytes=0;const chunks=[];
   for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>128*1024){await reader.cancel();throw Error('bounded');}chunks.push(Buffer.from(part.value));}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const status=typeof data.status==='string'?data.status.toLowerCase():null;
   attempt.providerStatus=['succeeded','completed','finished','done','ready','failed','cancelled','pending','running','processing'].includes(status)?status:'unknown';
   const resultUrl=['succeeded','completed','finished','done','ready'].includes(status)&&!data.error&&!data.metadata?.error?(data.metadata?.url||data.metadata?.content_url||data.url):null;
   if(typeof resultUrl==='string'&&resultUrl.length<=8192){const parsed=new URL(resultUrl);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)attempt.resultHost=parsed.hostname;}
   attempt.status=response.ok?'response_received':'http_rejected';save();out({queryVideo:attempt});
  }catch{attempt.status='query_failed';save();out({queryVideo:attempt});}return;
 }
 if(line==='image'){
  if(state.attempts.some(x=>x.action==='image'))return out({error:'IMAGE_ALREADY_ATTEMPTED_NO_REPEAT'});
  if(!state.catalog?.models.some(x=>x.id==='seedream-5-0-260128'))return out({error:'MODEL_NOT_LISTED'});
  const attempt={action:'image',requestModel:'seedream-5-0-260128',at:new Date().toISOString(),status:'intent_recorded',parameters:{n:1,size:'2048x2048',sequential_image_generation:'disabled'},posts:0};state.attempts.push(attempt);save();
  try{
   const result=await callMediaRoute(null,{taskType:'text2image',prompt:'A single blue ceramic coffee cup on a plain white table, soft daylight, simple product photograph. No text.'},{apiKey:secret,n:1,size:'2048x2048',sequentialImageGeneration:'disabled',timeoutMs:120000,
    fetchImpl:async(url,init)=>{
     if(new URL(url).origin!=='https://api.powertokens.ai')throw Error('origin');
     if(init.method==='POST'){if(attempt.posts!==0)throw Error('repeat');attempt.posts++;attempt.status='submission_may_have_started';save();}
     const response=await fetch(url,{...init,redirect:'error'});attempt.lastHttpStatus=response.status;attempt.requestId=safeId(response.headers.get('x-request-id'));save();return response;
    },
    onExternalIntent:async()=>{},onExternalTaskId:async x=>{attempt.taskId=safeId(x.taskId);save();},onExternalResult:async x=>{attempt.remoteOutcome=x.outcome;save();}});
   mediaResults.set('image',result);attempt.status='remote_result_received';attempt.resultHost=new URL(result.url).hostname;attempt.elapsedMs=result.elapsedMs;save();out({image:attempt});
  }catch(error){attempt.status=attempt.posts?'needs_reconciliation':'not_submitted';attempt.errorCode=safeId(error.code)||'MEDIA_PROBE_FAILED';save();out({image:attempt});}return;
 }
 if(line.startsWith('publish-image ')){
  const allowedHost=line.slice('publish-image '.length);const result=mediaResults.get('image');
  if(!result||new URL(result.url).hostname!==allowedHost)return out({error:'EXACT_HOST_CONFIRMATION_REQUIRED'});
  const attempt=state.attempts.find(x=>x.action==='image');
  if(attempt.localMedia)return out({error:'ALREADY_PUBLISHED'});
  const {createPinnedAssetFetch}=require('../../shell/media/pinned-asset-fetch.cjs');
  const {createManagedResultPublisher}=require('../../shell/media/managed-result-publisher.cjs');
  const {writeManagedMediaArtifact}=require('../../shell/runtime/managed-media-writer-candidate.cjs');
  const workspaceRoot=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-live-managed-'));
  const identity={userId:crypto.randomUUID(),tenantId:crypto.randomUUID()},runId=crypto.randomUUID();
  try{
   const publish=createManagedResultPublisher({workspaceRoot,allowedHosts:[allowedHost],fetchImpl:createPinnedAssetFetch({allowedHosts:[allowedHost]}),writeArtifact:writeManagedMediaArtifact});
   const media=await publish(result,{identity,runId});attempt.localMedia={...media,workspaceRoot,tenantId:identity.tenantId,syntheticRun:true};save();out({published:attempt.localMedia});
  }catch(error){attempt.localSaveError=safeId(error.code)||'LOCAL_SAVE_FAILED';save();out({error:attempt.localSaveError,remoteOutcome:attempt.remoteOutcome,noResubmission:true});}return;
 }
 out({error:'UNKNOWN_COMMAND'});
}
process.stdin.on('data',chunk=>{
 for(const char of chunk){
  if(char==='\u0003'){secret='';process.stdin.setRawMode(false);process.exit(130);}
  if(char==='\r'||char==='\n'){if(buffer){const line=buffer;buffer='';queue=queue.then(()=>command(line)).catch(()=>out({error:'PROBE_FAILED'}));}}
  else if(char==='\u007f')buffer=buffer.slice(0,-1);
  else if(buffer.length<8192)buffer+=char;
 }
});
