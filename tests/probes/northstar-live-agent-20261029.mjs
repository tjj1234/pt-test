// Actual local product server + pinned DSH launcher + live PT. No transport mocks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStorage}=require('../../shell/storage/index.cjs');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export async function runLiveAgent(apiKey,onProgress=()=>{},label='',mode='chat'){
 const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'northstar-live-agent-'));
 const runtime=path.join(temp,'runtime'),dataDir=path.join(temp,'db'),masterKeyFile=path.join(temp,'master-key');
 const evidence={scope:'local-product-live-PT-real-pinned-DSH',startedAt:new Date().toISOString(),models:[],runs:[],noTransportMocks:true};
 let storage,child,logs='',cookie;
 const redact=value=>String(value).split(apiKey).join('[KEY_REDACTED]').replace(/https?:\/\/[^\s"\\]+/g,'[URL_REDACTED]');
 const persist=()=>fs.writeFileSync(path.join(root,'docs/refactor/evidence/F1-live-agent-20261029'+label+'.json'),JSON.stringify(evidence,null,2)+'\n');
 try{
  storage=await createStorage({dataDir,masterKeyFile});
  const suffix=crypto.randomUUID();
  const user=(await storage.repositories.auth.register({username:'live-'+suffix,email:suffix+'@example.test',password:crypto.randomBytes(24).toString('hex')})).user;
  await storage.db.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',['https://accounts.google.com','local-live-fixture-'+suffix,user.id,user.email]);
  const token=crypto.randomBytes(32).toString('hex');
  await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,hash(token),new Date(Date.now()+600000).toISOString()]);cookie='pt_session='+token;
  await storage.close();storage=null;
  const listener=createServer();await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const reviewFile=path.join(temp,'media-review.json');fs.writeFileSync(reviewFile,JSON.stringify({schemaVersion:1,reviews:[]}),{mode:0o600});
  child=spawn(process.execPath,['shell/server.cjs','--port',String(port)],{cwd:root,detached:true,env:{PATH:process.env.PATH,HOME:temp,PT_RUNTIME_DIR:runtime,PT_DB_DIR:dataDir,PT_MASTER_KEY_FILE:masterKeyFile,PT_LOG_DIR:path.join(temp,'logs'),PT_SHELL_PORT:String(port),PT_LISTEN_HOST:'127.0.0.1',PT_KEY_LIVE_VERIFY:'0',...(mode.startsWith('media')?{PT_CONTROLLED_MEDIA_AUTHORIZATION:'1',PT_MEDIA_REVIEW_FILE:reviewFile,PT_MEDIA_ASSET_HOSTS:'ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com,pub-ee388a8463c1497c8b4f503044a80ee1.r2.dev,pub-425ca9cea13d454a907692a0a9f80079.r2.dev'}:{})},stdio:['ignore','pipe','pipe']});
  const capture=chunk=>{if(logs.length<2*1024*1024)logs+=chunk.toString();};child.stdout.on('data',capture);child.stderr.on('data',capture);
  const req=(url,{method='GET',body}={})=>fetch('http://127.0.0.1:'+port+url,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(['media-text2video','media-image2video'].includes(mode)?65*60*1000:180000)});
  const json=async(url,options)=>{const response=await req(url,options);const data=await response.json();if(response.status!==200)throw Object.assign(new Error('local route rejected'),{code:typeof data.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(data.code)?data.code:'LOCAL_HTTP_'+response.status});return data;};
  let ready=false;for(let n=0;n<200;n++){if(child.exitCode!==null)throw Object.assign(new Error('server'),{code:'SERVER_EXITED'});try{if((await req('/api/auth/me')).status===200){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  if(!ready)throw Object.assign(new Error('server'),{code:'SERVER_NOT_READY'});
  await json('/api/auth/key',{method:'POST',body:{key:apiKey}});
  onProgress({state:'local_server_key_saved_encrypted'});
  const catalog=await json('/api/models');evidence.catalogCount=catalog.models?.length??null;persist();
  const conversationId=(await json('/api/conversations',{method:'POST'})).id;
  if(mode==='vision'||mode==='vision-shapes'){
   const sharp=createRequire(path.join(root,'shell/package.json'))('sharp');
   const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" fill="white"/><text x="60" y="105" font-family="sans-serif" font-size="80" fill="black">R7K2</text><circle cx="90" cy="220" r="35" fill="blue"/><circle cx="210" cy="220" r="35" fill="blue"/><circle cx="330" cy="220" r="35" fill="blue"/><rect x="440" y="185" width="70" height="70" fill="red"/></svg>')).png().toBuffer();
   const asset=path.join(root,'docs/refactor/evidence/assets/native-vision-fixture-20261030.png');
   if(fs.existsSync(asset)){if(hash(fs.readFileSync(asset))!==hash(source))throw Object.assign(Error('fixture changed'),{code:'VISION_FIXTURE_CHANGED'});}else fs.writeFileSync(asset,source,{flag:'wx'});
   const uploaded=await json('/api/upload',{method:'POST',body:{image:source.toString('base64')}});
   evidence.input={sha256:hash(source),bytes:source.length,fixture:'native-vision-fixture-20261030.png'};
   await json('/api/models/select',{method:'POST',body:{model:'qwen3.8-flash',conversationId}});
   const attempts=mode==='vision-shapes'?
    [{name:'manual-image',body:{message:'How many blue circles are in this image? Reply with only the number. Do not use tools.',image:uploaded.url},expected:'3'},
     {name:'auto-followup',body:{message:'What color is the square in the uploaded image? Reply with one lowercase English color word. Do not use tools.'},expected:'red'},
     {name:'cold-regenerate',body:{regenerate:true},expected:'red'}]:
    [{name:'manual-image',body:{message:'Read the four black characters printed in this image. Reply only with those four characters. Do not use tools.',image:uploaded.url},expected:'R7K2'},
    {name:'auto-followup',body:{message:'How many blue circles are in the uploaded image? Reply with only the number. Do not use tools.'},expected:'3'},
    {name:'cold-regenerate',body:{regenerate:true},expected:'3'}];
   for(const attempt of attempts){
    if(attempt.name==='auto-followup')await json('/api/models/select',{method:'POST',body:{model:'AUTO',conversationId}});
    const trial={name:attempt.name,status:'submitted_to_local_server',at:new Date().toISOString()};evidence.runs.push(trial);persist();
    const response=await req('/api/chat',{method:'POST',body:{conversationId,...attempt.body}});trial.runId=response.headers.get('x-agent-run-id');persist();onProgress({state:'live_vision_run',name:attempt.name,runId:trial.runId});
    trial.streamTail=redact((await response.text()).slice(-1200));
    if(trial.runId){const detail=await json('/api/runs/'+trial.runId);trial.status=detail.run.state;
     const events=(await json('/api/runs/'+trial.runId+'/events')).events;
     trial.imageQualified=events.some(e=>e.payload?.action==='image_understanding_runtime_verified');
     trial.selections=events.filter(e=>e.payload?.action==='model_selection').map(e=>({requested:e.payload.requestedModelId,resolved:e.payload.resolvedModelId,task:e.payload.task}));
     trial.budgets=events.filter(e=>e.type==='usage'&&e.payload?.kind==='run_budget').map(e=>({limits:e.payload.limits,snapshot:e.payload.snapshot}));
    }
    const history=(await json('/api/conversations/'+conversationId)).conversation.messages;
    const last=history.filter(m=>m.role==='assistant').at(-1);trial.answer=redact(last?.text||'');trial.expectedAnswer=attempt.expected;
    trial.answerMatches=trial.answer.trim()===attempt.expected&&last?.runId===trial.runId&&trial.status==='completed';persist();
    if(!trial.answerMatches||(attempt.name==='manual-image'&&!trial.imageQualified))break;
   }
   evidence.result=evidence.runs.length===3&&evidence.runs.every(r=>r.answerMatches)&&evidence.runs[1].selections.some(s=>s.requested==='AUTO'&&s.task==='imageUnderstanding')?'PASS':'INCOMPLETE';persist();return evidence;
  }
  if(mode==='auto'){
   const warmupModel='seed-2-0-lite-260228';
   await json('/api/models/select',{method:'POST',body:{model:warmupModel,conversationId}});
   const manualResponse=await req('/api/chat',{method:'POST',body:{conversationId,message:'Reply with exactly NORTHSTAR_MANUAL_OK. Do not use tools.'}});
   const manualRunId=manualResponse.headers.get('x-agent-run-id');evidence.manualQualification={runId:manualRunId,modelId:warmupModel,status:'submitted_to_local_server'};persist();onProgress({state:'real_manual_qualification_request',runId:manualRunId});
   evidence.manualQualification.streamTail=redact((await manualResponse.text()).slice(-1200));
   const manualDetail=await json('/api/runs/'+manualRunId);evidence.manualQualification.status=manualDetail.run.state;
   const manualEvents=(await json('/api/runs/'+manualRunId+'/events')).events;
   evidence.manualQualification.verified=manualEvents.some(x=>x.type==='state'&&x.payload?.action==='text_chat_runtime_verified'&&x.payload?.modelId===warmupModel);
   if(evidence.manualQualification.status!=='completed'||!evidence.manualQualification.verified){evidence.result='INCOMPLETE';persist();return evidence;}
   await json('/api/models/select',{method:'POST',body:{model:'AUTO',conversationId}});
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Reply with exactly NORTHSTAR_AUTO_OK. Do not use tools.'}});
   const runId=response.headers.get('x-agent-run-id');evidence.auto={runId,status:'submitted_to_local_server'};persist();onProgress({state:'real_auto_agent_request',runId});
   evidence.auto.streamTail=redact((await response.text()).slice(-2000));
   const detail=await json('/api/runs/'+runId);evidence.auto.status=detail.run.state;
   const events=(await json('/api/runs/'+runId+'/events')).events;
   evidence.auto.modelSelections=events.filter(x=>x.type==='state'&&x.payload?.action==='model_selection').map(x=>({requestedModelId:x.payload.requestedModelId,resolvedModelId:x.payload.resolvedModelId,upstreamModelId:x.payload.upstreamModelId}));
   evidence.auto.budgets=events.filter(x=>x.type==='usage'&&x.payload?.kind==='run_budget').map(x=>({limits:x.payload.limits,snapshot:x.payload.snapshot}));
   const history=(await json('/api/conversations/'+conversationId)).conversation.messages;
   evidence.auto.historyExpectedText=history.some(x=>x.role==='assistant'&&x.text?.includes('NORTHSTAR_AUTO_OK'));
   evidence.result=evidence.auto.status==='completed'&&evidence.auto.modelSelections.some(x=>x.requestedModelId==='AUTO'&&typeof x.resolvedModelId==='string'&&x.resolvedModelId!=='AUTO')&&evidence.auto.historyExpectedText&&evidence.auto.budgets.some(x=>x.snapshot?.toolCalls===0)?'PASS':'INCOMPLETE';persist();return evidence;
  }
  if(mode==='csv'){
   const bytes=Buffer.from('amount\n0\n2\n2\n');
   const uploaded=await json('/api/upload-doc',{method:'POST',body:{name:'live-sum.csv',data:bytes.toString('base64')}});
   const selection={sourceRef:uploaded.url,sourceSha256:hash(bytes),headerRow:1,startRow:2,column:1};
   const preview=await json('/api/csv/selection-preview',{method:'POST',body:{sourceRef:selection.sourceRef,headerRow:1,startRow:2,column:1}});
   evidence.csv={sourceSha256:hash(bytes),previewType:preview.preview?.type,previewSourceBound:preview.preview?.sourceSha256===hash(bytes),status:'preflight'};persist();
   await json('/api/models/select',{method:'POST',body:{model:'seed-2-0-lite-260228',conversationId}});
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Use csv_analyze exactly once to calculate the sum of the selected amount column in the attached CSV. The values are 0, 2, 2. Return the computed sum and the generated CSV artifact; do not calculate only in prose.',documents:[uploaded.url],csvSelections:[selection]}});
   const runId=response.headers.get('x-agent-run-id');evidence.csv.runId=runId;evidence.csv.status='submitted_to_local_server';persist();onProgress({state:'real_csv_agent_request',runId});
   const frames=await response.text();evidence.csv.streamTail=redact(frames.slice(-2000));
   const detail=await json('/api/runs/'+runId);evidence.csv.status=detail.run.state;
   const events=(await json('/api/runs/'+runId+'/events')).events;
   const artifact=events.find(x=>x.type==='artifact')?.payload?.artifact;
   evidence.csv.artifact=artifact?{rel:artifact.rel,sha256:artifact.sha256}:null;
   evidence.csv.budgets=events.filter(x=>x.type==='usage'&&x.payload?.kind==='run_budget').map(x=>({limits:x.payload.limits,snapshot:x.payload.snapshot}));
   if(artifact?.rel){const url='/api/artifact?p='+encodeURIComponent(artifact.rel);const download=await req(url);const file=Buffer.from(await download.arrayBuffer());evidence.csv.download={status:download.status,byteCount:file.length,sha256:hash(file),mime:download.headers.get('content-type'),containsSum4:require('../../shell/attachments/csv-parser.cjs').parseCsv(file.toString('utf8')).rows[1]?.[5]?.value==='4'};evidence.csv.anonymousStatus=(await fetch('http://127.0.0.1:'+port+url)).status;}
   const history=(await json('/api/conversations/'+conversationId)).conversation.messages;
   evidence.csv.historyArtifact=Boolean(artifact&&history.some(x=>x.role==='assistant'&&x.artifacts?.some(a=>a.rel===artifact.rel)));
   evidence.result=evidence.csv.status==='completed'&&evidence.csv.previewSourceBound&&evidence.csv.download?.status===200&&evidence.csv.download?.sha256===artifact?.sha256&&evidence.csv.download?.containsSum4&&evidence.csv.anonymousStatus===401&&evidence.csv.historyArtifact?'PASS':'INCOMPLETE';persist();return evidence;
  }
  if(mode.startsWith('media')){
   const taskType=mode==='media-text2video'?'text2video':mode==='media-image2video'?'image2video':mode==='media-image2image'?'image2image':'text2image';
   const modelId=taskType.endsWith('video')?'dreamina-seedance-2-0-mini-260615':'seedream-5-0-260128';
   const mediaModel=catalog.models.find(x=>x.id===modelId);if(!mediaModel)throw Object.assign(new Error('model'),{code:'MEDIA_MODEL_NOT_LISTED'});
   const source='https://powertokens.ai/models/'+modelId;
   const reviewedAt=new Date().toISOString();const review={modelId:mediaModel.id,scopeId:mediaModel.scopeId,capabilityRevision:mediaModel.capabilityRevision,source,version:'live-trial-20261029.1',reviewedAt,expiresAt:new Date(Date.now()+3600000).toISOString(),tasks:[{taskType,source,adapterId:taskType.endsWith('video')?'pt-python-seedance-v1':'pt-image-generations-v1',endpoint:taskType.endsWith('video')?'openai-videos':'openai-images-generations'}]};
   fs.writeFileSync(reviewFile,JSON.stringify({schemaVersion:1,reviews:[review]}));
   await json('/api/models/select',{method:'POST',body:{model:'seed-2-0-lite-260228',conversationId}});
   const trial={taskType,requestModel:mediaModel.id,status:'submitted_to_local_server',at:new Date().toISOString()};evidence.runs.push(trial);persist();
   let image;
   if(taskType.startsWith('image2')){
    const source=fs.readFileSync(path.join(root,'docs/refactor/evidence/assets/f1-pt-t2i-20261024.jpg'));
    const uploaded=await json('/api/upload',{method:'POST',body:{image:source.toString('base64')}});
    image=uploaded.url;trial.inputSourceSha256=hash(source);trial.inputByteCount=source.length;persist();
   }
   const message=taskType==='text2video'
    ? 'Use media_route exactly once with taskType text2video to generate one 5 second 720P 16:9 video of a blue ceramic coffee cup on a white table, with gentle camera movement. Actually call the video tool, then briefly confirm completion.'
    : taskType==='image2video'
    ? 'Use media_route exactly once with taskType image2video and the current uploaded image to generate one 5 second 720P 16:9 video. Keep the blue ceramic coffee cup and white table, with gentle camera movement. Actually call the video tool, then briefly confirm completion.'
    : taskType==='image2image'
    ? 'Use media_route exactly once with taskType image2image and the current uploaded image. Change the blue ceramic coffee cup to green while keeping the white table. Actually call the tool, then briefly confirm completion.'
    : 'Use media_route exactly once with taskType text2image to generate a single blue ceramic coffee cup on a white table. Do not provide instructions; actually call the image generation tool, then briefly confirm completion.';
   const response=await req('/api/chat',{method:'POST',body:{conversationId,taskType,message,...(image?{image}:{})}});
   trial.runId=response.headers.get('x-agent-run-id');trial.httpStatus=response.status;persist();const streaming=response.text();
   let pending=false;for(let n=0;n<200;n++){const status=await req('/api/runs/'+trial.runId+'/media-authorization');if(status.status===200){pending=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
   if(!pending)throw Object.assign(new Error('consent'),{code:'MEDIA_CONSENT_NOT_PENDING'});
   await json('/api/runs/'+trial.runId+'/media-authorization',{method:'POST',body:{confirmed:true,modelId:mediaModel.id}});trial.authorization='explicit-single-submission';persist();onProgress({state:'real_media_authorized',runId:trial.runId});
   trial.streamTail=redact((await streaming).slice(-2000));
   const detail=await json('/api/runs/'+trial.runId);trial.status=detail.run.state;trial.externalOperations=detail.externalOperations;trial.managedMedia=detail.managedMedia;
   const events=(await json('/api/runs/'+trial.runId+'/events')).events;trial.budgets=events.filter(x=>x.type==='usage'&&x.payload?.kind==='run_budget').map(x=>({limits:x.payload.limits,snapshot:x.payload.snapshot}));
   if(taskType.startsWith('image2'))trial.inputBound=events.some(x=>x.type==='state'&&x.payload?.action==='media_input_bound'&&x.payload?.sha256===trial.inputSourceSha256);
   const media=detail.managedMedia?.media?.[0];
   if(media){const file=await req(media.url);const bytes=Buffer.from(await file.arrayBuffer());trial.download={status:file.status,byteCount:bytes.length,sha256:hash(bytes),mime:file.headers.get('content-type')};trial.anonymousStatus=(await fetch('http://127.0.0.1:'+port+media.url)).status;}
   const history=(await json('/api/conversations/'+conversationId)).conversation.messages;trial.historyManagedUrl=Boolean(media&&history.some(x=>x.role==='assistant'&&x.media?.some(item=>item.url===media.url)));
   evidence.result=trial.status==='completed'&&media&&media.type===(taskType.endsWith('video')?'video':'image')&&trial.download?.status===200&&trial.historyManagedUrl&&(!taskType.startsWith('image2')||trial.inputBound)?'PASS':'INCOMPLETE';persist();return evidence;
  }
  for(const model of ['qwen3.5-flash','seed-2-0-lite-260228']){
   await json('/api/models/select',{method:'POST',body:{model,conversationId}});evidence.models.push(model);persist();
   const trial={requestedModel:model,status:'submission_may_have_started',at:new Date().toISOString()};evidence.runs.push(trial);persist();onProgress({state:'live_agent_request',model});
   const response=await req('/api/chat',{method:'POST',body:{conversationId,message:'Reply with exactly NORTHSTAR_AGENT_OK. Do not use tools.'}});
   trial.httpStatus=response.status;trial.runId=response.headers.get('x-agent-run-id');persist();
   const stream=await response.text();trial.streamTail=redact(stream.slice(-3000));
   if(trial.runId){
    const detail=await json('/api/runs/'+trial.runId);trial.status=detail.run.state;
    const events=(await json('/api/runs/'+trial.runId+'/events')).events;
    trial.modelSelections=events.filter(x=>x.type==='state'&&x.payload?.action==='model_selection').map(x=>({requestedModelId:x.payload.requestedModelId,resolvedModelId:x.payload.resolvedModelId,upstreamModelId:x.payload.upstreamModelId}));
    trial.budgets=events.filter(x=>x.type==='usage'&&x.payload?.kind==='run_budget').map(x=>({limits:x.payload.limits,snapshot:x.payload.snapshot}));
    trial.errorCodes=events.filter(x=>x.type==='error').map(x=>x.payload?.code).filter(x=>typeof x==='string'&&/^[A-Z0-9_]{1,80}$/.test(x));
   }
   const currentHistory=(await json('/api/conversations/'+conversationId)).conversation.messages;
   trial.expectedTextPresent=currentHistory.filter(x=>x.role==='assistant').slice(-1).some(x=>JSON.stringify(x).includes('NORTHSTAR_AGENT_OK'))&&trial.status==='completed';
   persist();onProgress({state:'live_agent_result',...trial});
   if(trial.status!=='completed'||!trial.expectedTextPresent)break;
  }
  const history=(await json('/api/conversations/'+conversationId)).conversation;
  evidence.historyAssistantCount=history.messages.filter(x=>x.role==='assistant').length;
  evidence.historyExpectedTextCount=history.messages.filter(x=>x.role==='assistant'&&JSON.stringify(x).includes('NORTHSTAR_AGENT_OK')).length;
  evidence.result=evidence.runs.length===2&&evidence.runs.every(x=>x.status==='completed'&&x.expectedTextPresent)?'PASS':'INCOMPLETE';
 }catch(error){evidence.result='INCOMPLETE';evidence.errorCode=typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'LIVE_AGENT_PROBE_FAILED';}
 finally{
  if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([done,new Promise(resolve=>setTimeout(resolve,3000))]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
  if(storage)await storage.close();
  evidence.serverLogCredentialLeak=logs.includes(apiKey);evidence.credentialStorage='temporary-encrypted-BYOK-db-removed';evidence.endedAt=new Date().toISOString();persist();
  fs.rmSync(temp,{recursive:true,force:true});
 }
 return evidence;
}
