import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizePtRecord:N,mergeSnapshot:M}=require('../../shell/models/capabilities.cjs');
const at='2026-10-16T01:00:00.000Z',later='2026-10-17T01:00:00.000Z',third='2026-10-18T01:00:00.000Z';
const ctx={scopeId:'permission-scope-a',observedAt:at,sourceVersion:'PT models fixture v1'};
// Shapes observed in the existing PT fixtures; identifiers never imply a capability.
const observedFixtures=[{id:'deepseek-v4-pro',supported_endpoint_types:['anthropic']},{id:'seedream-5-0-260128',supported_endpoint_types:['image-generation']},{id:'wan2.7-t2v',supported_endpoint_types:['video']}];
const explicit={id:'explicit-record',capabilities:{textChat:true,imageUnderstanding:false},input_modalities:['text'],output_modalities:['text'],supported_endpoint_types:['openai-chat'],context_window:128000,max_output_tokens:8192};
const snapshot=(records,extra={})=>({scopeId:ctx.scopeId,success:true,complete:true,observedAt:at,records,...extra});
const policy={enabled:true,source:'platform routing policy',version:'policy-1'};
const adapter={textChat:{adapterId:'dsh-text',version:'1',endpoint:'openai-chat',source:'adapter-registry/v1'}};
function verifiedOptions(raw=explicit){const base=N(raw,ctx);return {...ctx,permission:true,localPolicy:policy,adaptations:adapter,verifications:{textChat:{status:'passed',modelId:raw.id,task:'textChat',adapterId:'dsh-text',endpoint:'openai-chat',scopeId:ctx.scopeId,capabilityRevision:base.capabilityRevision,adapterVersion:'1',source:'controlled-probe/run-1',verifiedAt:at}}};}

test('existing PT record shapes preserve endpoints without guessing task or modality',()=>{
 for(const raw of observedFixtures){const m=N(raw,ctx);assert.deepEqual(m.endpoints.value,raw.supported_endpoint_types);assert.equal(m.tasks.textChat.value,null);assert.equal(m.tasks.textToImage.value,null);assert.equal(m.tasks.textToVideo.value,null);assert.equal(m.inputModalities.value,null);assert.equal(m.states.textChat.autoEligible,false);}
 assert.equal(N({id:'glm-chat-vision-audio-video'},ctx).tasks.textChat.value,null);
});
test('explicit metadata carries independent facts and paths',()=>{
 const m=N(explicit,ctx);assert.equal(m.tasks.textChat.value,true);assert.equal(m.tasks.imageUnderstanding.value,false);assert.equal(m.tasks.videoUnderstanding.value,null);assert.equal(m.tasks.textChat.source.path,'capabilities.textChat');assert.equal(m.tasks.textChat.source.version,ctx.sourceVersion);assert.equal(m.limits.contextWindow.value,128000);assert.equal(m.states.textChat.adapted,false);assert.equal(m.states.textChat.verified,false);
});
test('unsupported or malformed data remains unknown; owned_by is not provider route',()=>{
 const m=N({id:'x',owned_by:'vendor',input_modalities:['new-kind'],capabilities:{textChat:'true'},context_window:0},ctx);assert.equal(m.provider.value,null);assert.equal(m.owner.value,'vendor');assert.equal(m.inputModalities.value,null);assert.equal(m.tasks.textChat.value,null);assert.equal(m.limits.contextWindow.value,null);assert.equal(N({name:'display only'},ctx),null);
});
test('supported task list is positive-only and cannot erase explicit false',()=>{
 const m=N({id:'x',supported_tasks:['text-to-image','image-to-video','unknown-task'],capabilities:{imageToVideo:false}},ctx);assert.equal(m.tasks.textToImage.value,true);assert.equal(m.tasks.imageToVideo.value,false);assert.equal(m.tasks.textChat.value,null);
});
test('discovered, adapted, verified and AUTO eligibility are distinct',()=>{
 const m=N(explicit,verifiedOptions());assert.deepEqual(m.states.textChat,{discovered:true,adapted:true,verified:true,autoEligible:true});
 for(const opts of [{permission:false},{permission:null},{adaptations:{}},{verifications:{}}])assert.equal(N(explicit,{...verifiedOptions(),...opts}).states.textChat.autoEligible,false);
 assert.equal(N({...explicit,input_modalities:undefined},verifiedOptions({...explicit,input_modalities:undefined})).states.textChat.autoEligible,false);
 assert.equal(N(explicit,{...verifiedOptions(),adaptations:{textChat:{...adapter.textChat,endpoint:'unsupported-endpoint'}}}).states.textChat.autoEligible,false);
});
test('verification must match permission scope, revision and adapter version',()=>{
 const good=verifiedOptions();for(const patch of [{scopeId:'other'},{capabilityRevision:'stale'},{adapterVersion:'2'},{status:'failed'},{verifiedAt:'bad-date'}])assert.equal(N(explicit,{...good,verifications:{textChat:{...good.verifications.textChat,...patch}}}).states.textChat.verified,false);
 assert.equal(N({...explicit,context_window:64000},good).states.textChat.verified,false);
});
test('manual override requires provenance and is retained across upstream snapshots',()=>{
 const raw={id:'x',supported_endpoint_types:['openai-chat']};const override={id:'x',source:'PM official capability review',version:'review-1',tasks:{textChat:true},inputModalities:['text'],outputModalities:['text']};
 const a=M(null,snapshot([raw]),{overrides:{x:override}});assert.equal(a.models[0].tasks.textChat.source.kind,'manual');
 const b=M(a,snapshot([{...raw,name:'new name'}],{observedAt:later}));assert.equal(b.models[0].tasks.textChat.value,true);assert.deepEqual(b.models[0].manualOverride,override);
 assert.throws(()=>N(raw,{...ctx,override:{tasks:{textChat:true}}}));assert.throws(()=>N(raw,{...ctx,override:{...override,id:'other-model'}}));
});
test('complete same-scope snapshots add, change, tombstone and restore without AUTO resurrection',()=>{
 const initial=M(null,snapshot([explicit,{id:'other'}]),{permission:true,policies:{[explicit.id]:policy},adaptations:{[explicit.id]:adapter},verifications:{[explicit.id]:verifiedOptions().verifications}});
 assert.equal(initial.models.find(x=>x.id===explicit.id).states.textChat.autoEligible,true);
 const removed=M(initial,snapshot([{id:'other',name:'changed'}],{observedAt:later}));const tomb=removed.models.find(x=>x.id===explicit.id);assert.equal(tomb.availability,'removed');assert.equal(tomb.states.textChat.autoEligible,false);assert.equal(tomb.states.textChat.verified,false);assert.ok(removed.events.some(e=>e.type==='changed'));assert.ok(removed.events.some(e=>e.type==='removed'));
 const restored=M(removed,snapshot([explicit,{id:'other'}],{observedAt:third}));assert.ok(restored.events.some(e=>e.type==='restored'));assert.equal(restored.models.find(x=>x.id===explicit.id).states.textChat.verified,false);
 const reverification={...verifiedOptions().verifications.textChat,verifiedAt:third};const final=M(restored,snapshot([explicit,{id:'other'}],{observedAt:third}),{verifications:{[explicit.id]:{textChat:reverification}}});assert.equal(final.models.find(x=>x.id===explicit.id).states.textChat.autoEligible,true);
});
test('failed/incomplete/cross-scope snapshots never remove models',()=>{
 const initial=M(null,snapshot([explicit]));
 for(const changes of [{success:false},{complete:false},{scopeId:'different-permission'},{records:null}]){const out=M(initial,snapshot([],{observedAt:later,...changes}));assert.equal(out.models[0].availability,'present');assert.equal(initial.models[0].availability,'present');}
});
test('invalid records and duplicate IDs invalidate snapshot removal authority',()=>{
 const initial=M(null,snapshot([explicit]));for(const records of [[{}],[{id:'a'},{id:'a'}]]){const out=M(initial,snapshot(records,{observedAt:later}));assert.equal(out.models.find(x=>x.id===explicit.id).availability,'present');assert.ok(out.events.some(e=>e.type==='deletions-skipped'));}
});
test('complete empty snapshot tombstones, stale snapshot cannot regress and inputs are immutable',()=>{
 const raw=structuredClone(explicit),before=JSON.stringify(raw);const initial=M(null,snapshot([raw]));const original=JSON.stringify(initial);const removed=M(initial,snapshot([],{observedAt:later}));assert.equal(removed.models[0].availability,'removed');assert.equal(JSON.stringify(initial),original);assert.equal(JSON.stringify(raw),before);
 const stale=M(removed,snapshot([raw]));assert.equal(stale.models[0].availability,'removed');assert.equal(stale.events[0].reason,'stale-snapshot');
});

test('verification evidence cannot be transplanted to a different model, task or adapter',()=>{
 const good=verifiedOptions();for(const patch of [{modelId:'different-model'},{task:'imageUnderstanding'},{adapterId:'different-adapter'},{endpoint:'different-endpoint'}])assert.equal(N(explicit,{...good,verifications:{textChat:{...good.verifications.textChat,...patch}}}).states.textChat.verified,false);
 assert.notEqual(N({...explicit,id:'different-id'},ctx).capabilityRevision,N(explicit,ctx).capabilityRevision);
 assert.equal(N({...explicit,provider:'changed-provider'},good).states.textChat.verified,false);
});
test('streaming, structured output, protocol and file/duration limits require explicit evidence',()=>{
 const m=N({...explicit,protocol:'custom-v2',capabilities:{streaming:true,structuredOutput:false,toolCalling:true},max_file_bytes:5000,max_audio_seconds:90,max_video_seconds:300,max_images:4},ctx);
 assert.equal(m.protocol.value,'custom-v2');assert.equal(m.features.streaming.value,true);assert.equal(m.features.structuredOutput.value,false);assert.equal(m.features.toolCalling.value,true);assert.equal(m.limits.maxFileBytes.value,5000);assert.equal(m.limits.maxAudioSeconds.value,90);assert.equal(m.limits.maxVideoSeconds.value,300);assert.equal(m.limits.maxImages.value,4);
 assert.equal(N({id:'unknown'},ctx).features.streaming.value,null);assert.equal(N({id:'unknown'},ctx).limits.maxVideoSeconds.value,null);
 assert.throws(()=>N({id:'unknown'},{scopeId:'x',observedAt:null}));
});

test('versioned local disable policy and route history survive synchronization',()=>{
 const initial=M(null,snapshot([explicit]),{permission:true,policies:{[explicit.id]:{...policy,enabled:false}}});
 initial.routeVersions=['routing-v1'];initial.models[0].routeHistory=[{version:'routing-v1',source:'operator'}];
 const refreshed=M(initial,snapshot([explicit],{observedAt:later}));
 assert.equal(refreshed.models[0].localPolicy.enabled,false);assert.equal(refreshed.models[0].states.textChat.autoEligible,false);assert.deepEqual(refreshed.routeVersions,['routing-v1']);assert.deepEqual(refreshed.models[0].routeHistory,initial.models[0].routeHistory);
 assert.equal(N(explicit,{...verifiedOptions(),localPolicy:null}).states.textChat.autoEligible,false);
 assert.throws(()=>N(explicit,{...ctx,localPolicy:{enabled:true}}));
});

test('explicit unknown or denied permission revokes AUTO even for retained partial-snapshot models',()=>{
 const initial=M(null,snapshot([explicit]),{permission:true,policies:{[explicit.id]:policy},adaptations:{[explicit.id]:adapter},verifications:{[explicit.id]:verifiedOptions().verifications}});
 assert.equal(initial.models[0].states.textChat.autoEligible,true);
 for(const permission of [null,false])for(const records of [[],[explicit]]){
  const out=M(initial,snapshot(records,{observedAt:later,complete:false}),{permission});
  assert.equal(out.models[0].permission,permission);assert.equal(out.models[0].states.textChat.autoEligible,false);assert.equal(out.models[0].availability,'present');
 }
});

test('failed snapshot cannot preserve revoked local authority while retaining directory',()=>{
 const initial=M(null,snapshot([explicit]),{permission:true,policies:{[explicit.id]:policy},adaptations:{[explicit.id]:adapter},verifications:{[explicit.id]:verifiedOptions().verifications}});
 const updates=[{permission:false},{policies:{[explicit.id]:{...policy,enabled:false}}},{adaptations:{[explicit.id]:{}}},{verifications:{[explicit.id]:{}}}];
 for(const options of updates)for(const data of [{success:false},{success:true,complete:false}]){
  const out=M(initial,snapshot([],{observedAt:later,...data}),options);
  assert.equal(out.models[0].availability,'present');assert.equal(out.models[0].states.textChat.autoEligible,false);assert.equal(initial.models[0].states.textChat.autoEligible,true);
 }
 const revoked=M(initial,snapshot([],{observedAt:later,complete:false}),{adaptations:{[explicit.id]:null}});
 assert.equal(revoked.models[0].states.textChat.adapted,false);assert.equal(revoked.models[0].states.textChat.verified,false);
});
