'use strict';
/** Pure metadata normalization only. No I/O, model calls, directory or credentials. */
const {createHash}=require('node:crypto');
const TASKS=Object.freeze(['textChat','imageUnderstanding','audioUnderstanding','videoUnderstanding','textToImage','imageToImage','textToVideo','imageToVideo','speechToText','textToSpeech','embedding','rerank','toolCalling']);
const MODALITIES=Object.freeze(['text','image','audio','video']);
const PT_METADATA_FIELDS=Object.freeze(['capabilities','supported_tasks','input_modalities','output_modalities','supported_endpoint_types','supported_endpoints','modalities','protocol','provider','owned_by','context_window','max_output_tokens','max_file_bytes','max_audio_seconds','max_video_seconds','max_images']);
const TASK_IO=Object.freeze({textChat:[['text'],['text']],imageUnderstanding:[['image'],['text']],audioUnderstanding:[['audio'],['text']],videoUnderstanding:[['video'],['text']],textToImage:[['text'],['image']],imageToImage:[['image'],['image']],textToVideo:[['text'],['video']],imageToVideo:[['image'],['video']],speechToText:[['audio'],['text']],textToSpeech:[['text'],['audio']],toolCalling:[['text'],['text']]});
// PT endpoint labels describe task capability; they are distinct from local adapter endpoints.
// The live PT catalog also advertises "openai" for image, video and speech
// models. That transport label alone does not establish textChat capability.
const PT_ENDPOINT_TASKS=Object.freeze({anthropic:'textChat','openai-response':'textChat','image-generation':'textToImage','openai-video':'textToVideo'});
const PT_TASK_ADAPTER_ENDPOINTS=Object.freeze({textChat:'openai-chat-completions'});
const TASK_MODALITIES=Object.freeze({textChat:[['text'],['text']],textToImage:[['text'],['image']],textToVideo:[['text'],['video']]});
const aliases=Object.freeze({'text-chat':'textChat','image-understanding':'imageUnderstanding','audio-understanding':'audioUnderstanding','video-understanding':'videoUnderstanding','text-to-image':'textToImage','image-to-image':'imageToImage','text-to-video':'textToVideo','image-to-video':'imageToVideo','speech-to-text':'speechToText','text-to-speech':'textToSpeech','tool-calling':'toolCalling'});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
const text=x=>typeof x==='string'&&x.trim()?x.trim():null;
function timestamp(value){if(value==null)throw new TypeError('observedAt required');const t=new Date(value);if(!Number.isFinite(t.getTime()))throw new TypeError('observedAt must be a valid timestamp');return t.toISOString();}
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(plain(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
function revision(x){return createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');}
function list(value){if(Array.isArray(value)&&value.every(x=>typeof x==='string'))return [...new Set(value.map(s=>s.trim()).filter(Boolean))].sort();return null;}
function metadataFieldNames(raw){return PT_METADATA_FIELDS.filter(key=>Object.hasOwn(raw,key)).sort();}
function capabilityFieldNames(raw){return plain(raw.capabilities)?Object.keys(raw.capabilities).filter(key=>/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)).sort().slice(0,64):[];}
function sourceOf(path,ctx,kind='pt-metadata'){return {kind,path,version:ctx.sourceVersion||null,observedAt:ctx.observedAt};}
function unknown(){return {value:null,source:null};}
function fact(value,path,ctx){return value==null?unknown():{value,source:sourceOf(path,ctx)};}
function normalizeOverride(value,id){
 if(value==null)return null;
 if(!plain(value)||!text(value.source)||!text(value.version)||(value.id!=null&&value.id!==id))throw new TypeError('manual override requires matching model id, source and version');
 const tasks={};
 for(const [k,v]of Object.entries(value.tasks||{})){if(!TASKS.includes(k)||![true,false,null].includes(v))throw new TypeError('invalid manual task capability');tasks[k]=v;}
 const out={id,source:value.source,version:value.version,tasks};
 for(const k of ['inputModalities','outputModalities'])if(Object.hasOwn(value,k)){const values=list(value[k]);if(value[k]!==null&&(!values||values.some(v=>!MODALITIES.includes(v))))throw new TypeError('invalid manual modalities');out[k]=values;}
 if(Object.hasOwn(value,'endpoints')){const values=list(value.endpoints);if(!values||values.some(v=>!/^[a-z][a-z0-9-]{0,63}$/.test(v)))throw new TypeError('invalid manual endpoints');out.endpoints=values;}
 return out;
}
/** Supported PT fields are explicit data, not guesses based on model ID or protocol.
 * Unknown fields stay unknown. An endpoint's existence never proves task/modality support.
 */
function normalizePtRecord(raw,options={}){
 if(!plain(raw))return null;
 const id=text(raw.id)||text(raw.model);if(!id)return null;
 const ctx={scopeId:text(options.scopeId),observedAt:timestamp(options.observedAt),sourceVersion:text(options.sourceVersion)};
 if(!ctx.scopeId)throw new TypeError('scopeId required (non-secret principal/permission fingerprint)');
 const tasks=Object.fromEntries(TASKS.map(k=>[k,unknown()]));
 if(plain(raw.capabilities))for(const [key,value]of Object.entries(raw.capabilities)){const task=aliases[key]||key;if(TASKS.includes(task)&&typeof value==='boolean')tasks[task]=fact(value,'capabilities.'+key,ctx);}
 const supported=list(raw.supported_tasks);
 if(supported)for(const key of supported){const task=aliases[key]||key;if(TASKS.includes(task)&&tasks[task].value===null)tasks[task]=fact(true,'supported_tasks',ctx);}
 const endpointField=Object.hasOwn(raw,'supported_endpoint_types')?'supported_endpoint_types':'supported_endpoints';
 const endpointValue=raw[endpointField];
 const endpointList=typeof endpointValue==='string'?list(endpointValue.split(/[,\s]+/)):list(endpointValue);
 let inputModalities=fact(list(raw.input_modalities),'input_modalities',ctx),outputModalities=fact(list(raw.output_modalities),'output_modalities',ctx);
 // Unknown modality labels do not silently become supported known types.
 for(const f of [inputModalities,outputModalities])if(f.value?.some(x=>!MODALITIES.includes(x)))f.value=null;
 const rawPtEndpoints=raw.supported_endpoint_types;
 const trustedPtEndpoints=typeof rawPtEndpoints==='string'?list(rawPtEndpoints.split(/[ ,\s]+/)):list(rawPtEndpoints);
 const ptEndpointTasks=trustedPtEndpoints?fact([...new Set(trustedPtEndpoints.map(endpoint=>PT_ENDPOINT_TASKS[endpoint]).filter(Boolean))].sort(),'supported_endpoint_types',ctx):unknown();
 if(trustedPtEndpoints)for(const endpoint of trustedPtEndpoints){const task=PT_ENDPOINT_TASKS[endpoint];if(!task)continue;if(tasks[task].value===null)tasks[task]=fact(true,'supported_endpoint_types',ctx);const io=TASK_MODALITIES[task];if(io&&inputModalities.value===null)inputModalities=fact(io[0],'supported_endpoint_types',ctx);if(io&&outputModalities.value===null)outputModalities=fact(io[1],'supported_endpoint_types',ctx);}
 const override=normalizeOverride(options.override,id);
 if(override){const src={kind:'manual',source:override.source,version:override.version};for(const[k,v]of Object.entries(override.tasks))tasks[k]={value:v,source:clone(src)};for(const k of ['inputModalities','outputModalities'])if(Object.hasOwn(override,k)){const f={value:clone(override[k]),source:clone(src)};if(k==='inputModalities')inputModalities=f;else outputModalities=f;}}
 let endpoints=fact(endpointList,endpointField,ctx);
 if(override&&Object.hasOwn(override,'endpoints'))endpoints={value:clone(override.endpoints),source:{kind:'manual',source:override.source,version:override.version}};
 const protocol=fact(text(raw.protocol),'protocol',ctx);
 const features={};for(const key of ['streaming','structuredOutput'])features[key]=fact(typeof raw.capabilities?.[key]==='boolean'?raw.capabilities[key]:null,'capabilities.'+key,ctx);
 features.toolCalling=clone(tasks.toolCalling);
 const limits={};for(const [key,field]of [['contextWindow','context_window'],['maxOutputTokens','max_output_tokens'],['maxFileBytes','max_file_bytes'],['maxAudioSeconds','max_audio_seconds'],['maxVideoSeconds','max_video_seconds'],['maxImages','max_images']])limits[key]=fact(Number.isSafeInteger(raw[field])&&raw[field]>0?raw[field]:null,field,ctx);
 const capabilityRevision=null;
 const permission=typeof options.permission==='boolean'?options.permission:null;
 const availability=options.availability==='removed'?'removed':'present';
 const verificationNotBefore=options.verificationNotBefore?timestamp(options.verificationNotBefore):null;
 const localPolicy=options.localPolicy==null?null:clone(options.localPolicy);
 if(localPolicy&&(!text(localPolicy.source)||!text(localPolicy.version)||typeof localPolicy.enabled!=='boolean'))throw new TypeError('local policy requires boolean enabled, source and version');

 const model={id,name:text(raw.display_name)||text(raw.displayName)||text(raw.name)||id,owner:fact(text(raw.owned_by),'owned_by',ctx),provider:fact(text(raw.provider),'provider',ctx),scopeId:ctx.scopeId,availability,tasks,inputModalities,outputModalities,endpoints,ptEndpointTasks,protocol,features,limits,metadataFields:metadataFieldNames(raw),capabilityFields:capabilityFieldNames(raw),capabilityRevision,permission,states:{},localPolicy,verificationNotBefore,manualOverride:override,adaptations:clone(options.adaptations||{}),verifications:clone(options.verifications||{}),observedAt:ctx.observedAt,sourceVersion:ctx.sourceVersion};
 model.capabilityRevision=capabilityRevisionOfModel(model);
 model.states=eligibility(model);
 return model;
}
function capabilityRevisionOfModel(model){
 return revision({id:model.id,provider:model.provider.value,protocol:model.protocol.value,features:Object.fromEntries(Object.entries(model.features).map(([k,v])=>[k,v.value])),tasks:Object.fromEntries(TASKS.map(k=>[k,model.tasks[k].value])),taskSources:Object.fromEntries(TASKS.map(k=>[k,model.tasks[k].source?.path||model.tasks[k].source?.kind||null])),input:model.inputModalities.value,output:model.outputModalities.value,endpoints:model.endpoints.value,endpointSource:model.endpoints.source?.path||model.endpoints.source?.kind||null,ptEndpointTasks:model.ptEndpointTasks.value,limits:Object.fromEntries(Object.entries(model.limits).map(([k,v])=>[k,v.value])),overrideSource:model.manualOverride?.source??null,overrideVersion:model.manualOverride?.version??null});
}
// Apply reviewed facts to normalized source facts without reconstructing or
// relabeling the original PT metadata. Same revision recipe as normalization.
function applyReviewedOverride(model,{override,localPolicy,adaptations,verifications}){
 const updated=clone(model),normalized=normalizeOverride(override,model.id);
 if(!normalized)throw new TypeError("Reviewed override required");
 const source={kind:"manual",source:normalized.source,version:normalized.version};
 for(const [task,value]of Object.entries(normalized.tasks))updated.tasks[task]={value,source:clone(source)};
 for(const key of ["inputModalities","outputModalities","endpoints"])if(Object.hasOwn(normalized,key))updated[key]={value:clone(normalized[key]),source:clone(source)};
 updated.features.toolCalling=clone(updated.tasks.toolCalling);
 updated.manualOverride=normalized;
 updated.capabilityRevision=capabilityRevisionOfModel(updated);
 return applyLocalUpdates(updated,{policies:{[model.id]:localPolicy},adaptations:{[model.id]:adaptations},verifications:{[model.id]:verifications}});
}
function eligibility(model){
 const states={};
 for(const task of TASKS){
  const a=model.adaptations?.[task],v=model.verifications?.[task];
  const adapted=!!(a&&text(a.adapterId)&&text(a.version)&&text(a.endpoint)&&text(a.source));
  const verified=!!(adapted&&v?.status==='passed'&&v.modelId===model.id&&v.task===task&&v.adapterId===a.adapterId&&v.endpoint===a.endpoint&&v.scopeId===model.scopeId&&v.capabilityRevision===model.capabilityRevision&&v.adapterVersion===a.version&&text(v.source)&&text(v.verifiedAt)&&Number.isFinite(Date.parse(v.verifiedAt))&&(!model.verificationNotBefore||new Date(v.verifiedAt)>=new Date(model.verificationNotBefore)));
  const ptEndpointTask=model.ptEndpointTasks.value?.includes(task)===true;
  const manualEndpointCompatible=model.endpoints.source?.kind==='manual'&&model.endpoints.value?.includes(a?.endpoint)===true;
  const imageChatCompatible=task==='imageUnderstanding'&&model.tasks[task].value===true&&
    model.inputModalities.value?.includes('image')&&model.ptEndpointTasks.value?.includes('textChat')&&a?.endpoint==='openai-chat-completions';
  const mappedAdapterCompatible=(ptEndpointTask&&PT_TASK_ADAPTER_ENDPOINTS[task]===a?.endpoint)||imageChatCompatible;
  const endpointCompatible=!!(adapted&&(manualEndpointCompatible||mappedAdapterCompatible));
  const io=TASK_IO[task];const modalitiesKnown=!!(io&&io[0].every(x=>model.inputModalities.value?.includes(x))&&io[1].every(x=>model.outputModalities.value?.includes(x)));
  states[task]={discovered:true,adapted,endpointCompatible,verified,autoEligible:model.availability==='present'&&model.permission===true&&model.localPolicy?.enabled===true&&Array.isArray(model.localPolicy.tasks)&&model.localPolicy.tasks.includes(task)&&model.tasks[task].value===true&&endpointCompatible&&modalitiesKnown&&adapted&&verified};
 }
 return states;
}
function applyLocalUpdates(model,options){
 const updated=clone(model);
 if(Object.hasOwn(options,'permission'))updated.permission=typeof options.permission==='boolean'?options.permission:null;
 if(options.permissions&&Object.hasOwn(options.permissions,model.id))updated.permission=typeof options.permissions[model.id]==='boolean'?options.permissions[model.id]:null;
 for(const [map,field]of [['policies','localPolicy'],['adaptations','adaptations'],['verifications','verifications']])if(options[map]&&Object.hasOwn(options[map],model.id))updated[field]=clone(options[map][model.id])||(field==='localPolicy'?null:{});
 if(updated.localPolicy&&(!text(updated.localPolicy.source)||!text(updated.localPolicy.version)||typeof updated.localPolicy.enabled!=='boolean'))throw new TypeError('local policy requires boolean enabled, source and version');
 updated.states=eligibility(updated);
 return updated;
}
/** previous={scopeId,models,lastSuccessfulAt}; snapshot complete means every page and same access scope.
 * A caller must change scopeId when principal/credential permission scope changes. Never put a Key here.
 */
function mergeSnapshot(previous,snapshot,options={}){
 if(!plain(snapshot)||!text(snapshot.scopeId))throw new TypeError('snapshot scopeId required');
 const at=timestamp(snapshot.observedAt),prior=previous?clone(previous):{scopeId:snapshot.scopeId,models:[],lastSuccessfulAt:null};
 const events=[];
 if(prior.scopeId!==snapshot.scopeId)return {...prior,events:[{type:'snapshot-ignored',reason:'scope-mismatch'}]};
 prior.models=prior.models.map(model=>applyLocalUpdates(model,options));
 if(prior.lastSuccessfulAt&&at<prior.lastSuccessfulAt)return {...prior,events:[{type:'snapshot-ignored',reason:'stale-snapshot'}]};
 if(snapshot.success!==true||!Array.isArray(snapshot.records))return {...prior,events:[{type:'snapshot-ignored',reason:'failed-or-invalid-snapshot'}]};
 const byId=new Map(prior.models.map(m=>[m.id,m])),incoming=new Map();let valid=true;
 for(const raw of snapshot.records){
  const id=plain(raw)?text(raw.id)||text(raw.model):null;
  if(!id||incoming.has(id)){valid=false;events.push({type:'invalid-record',id});continue;}
  const old=byId.get(id);
  const overrides=options.overrides||{};
  const override=Object.hasOwn(overrides,id)?overrides[id]:old?.manualOverride;
  const model=normalizePtRecord(raw,{scopeId:snapshot.scopeId,observedAt:at,sourceVersion:snapshot.sourceVersion,override,localPolicy:old?.localPolicy??options.policies?.[id],adaptations:old?.adaptations??options.adaptations?.[id],verifications:old?.verifications??options.verifications?.[id],verificationNotBefore:old?.removedAt||old?.verificationNotBefore,permission:options.permissions&&Object.hasOwn(options.permissions,id)?options.permissions[id]:Object.hasOwn(options,'permission')?options.permission:old?.permission??null});
  if(old&&old.capabilityRevision===model.capabilityRevision&&old.name===model.name&&old.owner?.value===model.owner.value){
   for(const key of ['tasks','inputModalities','outputModalities','endpoints','ptEndpointTasks','protocol','features','limits','owner','provider'])model[key]=clone(old[key]);
   model.observedAt=old.observedAt;model.sourceVersion=old.sourceVersion;
  }
  model.routeHistory=clone(old?.routeHistory||[]);
  model.firstSeenAt=old?.firstSeenAt||at;model.lastSeenAt=at;model.removedAt=null;
  incoming.set(id,model);
  const type=!old?'added':old.availability==='removed'?'restored':old.capabilityRevision!==model.capabilityRevision||old.name!==model.name?'changed':'observed';
  events.push({type,id});
 }
 const authoritative=snapshot.complete===true&&valid;
 for(const[id,old]of byId)if(!incoming.has(id)){
  const retained=clone(old);
  if(options.permissions&&Object.hasOwn(options.permissions,id)){
   retained.permission=typeof options.permissions[id]==='boolean'?options.permissions[id]:null;
   if(retained.permission!==true)for(const state of Object.values(retained.states))state.autoEligible=false;
  }else if(Object.hasOwn(options,'permission')){
   retained.permission=typeof options.permission==='boolean'?options.permission:null;
   if(retained.permission!==true)for(const state of Object.values(retained.states))state.autoEligible=false;
  }
  if(authoritative&&old.availability!=='removed'){
   retained.availability='removed';retained.removedAt=at;retained.verificationNotBefore=at;
   for(const s of Object.values(retained.states)){s.autoEligible=false;s.verified=false;}
   events.push({type:'removed',id});
  }
  incoming.set(id,retained);
 }
 if(!authoritative)events.push({type:'deletions-skipped',reason:valid?'incomplete-snapshot':'invalid-records'});
 return {...prior,scopeId:prior.scopeId,models:[...incoming.values()].sort((a,b)=>a.id.localeCompare(b.id)),lastSuccessfulAt:at,lastCompleteAt:authoritative?at:prior.lastCompleteAt??null,events};
}
module.exports={TASKS,MODALITIES,PT_ENDPOINT_TASKS,PT_TASK_ADAPTER_ENDPOINTS,normalizePtRecord,mergeSnapshot,applyReviewedOverride,applyLocalUpdates};
