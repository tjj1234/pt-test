import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {routeChatTask,routeTextTask}=require('../../shell/models/task-router.cjs');
const model=()=>({id:'vision-fixture',permission:true,availability:'present',localPolicy:{enabled:true,tasks:['textChat','imageUnderstanding']},tasks:{imageUnderstanding:{value:true}},states:{imageUnderstanding:{adapted:true,endpointCompatible:true,verified:false,autoEligible:false}},inputModalities:{value:['text','image']},outputModalities:{value:['text']}});
const request=c=>({candidates:[c],requirements:{task:'imageUnderstanding'},selection:{mode:'manual',modelId:c.id},availability:{status:'available',modelIds:[c.id]}});
const {normalizePtRecord}=require('../../shell/models/capabilities.cjs');
const {nativeImageCandidates}=require('../../shell/models/native-image-qualification.cjs');
const {reviewedImageOverrides}=require('../../shell/models/reviewed-image-facts.cjs');
test('exact reviewed gateway facts enable only the documented image model and never runtime verification',()=>{
 const raw={id:'qwen3.8-flash',supported_endpoint_types:['openai-response']},overrides=reviewedImageOverrides();
 const c=normalizePtRecord(raw,{scopeId:'fixture',observedAt:'2026-10-30T00:00:00Z',permission:true,
  override:overrides[raw.id],localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']}});
 const [qualified]=nativeImageCandidates({models:[c]});
 assert.equal(qualified.tasks.imageUnderstanding.value,true);assert.equal(qualified.states.imageUnderstanding.endpointCompatible,true);
 assert.equal(qualified.states.imageUnderstanding.verified,false);assert.equal(overrides['qwen3.8-flash-other'],undefined);
});
test('image qualification permits explicit first manual trial and requires independent AUTO evidence',()=>{
 const c=model();assert.equal(routeChatTask(request(c)).ok,true);
 assert.equal(routeChatTask({...request(c),selection:{mode:'auto'}}).ok,false);
 assert.equal(routeTextTask(request(c)).code,'TASK_REQUIREMENTS_INVALID');
});
test('native image adaptation preserves source facts and never upgrades unknown task from endpoint alone',()=>{
 const make=tasks=>normalizePtRecord({id:'vision',supported_endpoint_types:['openai-response'],supported_tasks:tasks,input_modalities:['text','image'],output_modalities:['text']},
  {scopeId:'scope',observedAt:'2026-10-30T00:00:00Z',sourceVersion:'fixture',permission:true,localPolicy:{enabled:true,source:'fixture policy',version:'1',tasks:['textChat']}});
 const known=make(['textChat','imageUnderstanding']),unknown=make(['textChat']);
 const [adapted,untouched]=nativeImageCandidates({models:[known,unknown]});
 assert.equal(adapted.states.imageUnderstanding.adapted,true);assert.equal(adapted.states.imageUnderstanding.endpointCompatible,true);
 assert.equal(adapted.capabilityRevision,known.capabilityRevision);assert.deepEqual(adapted.tasks,known.tasks);
 assert.equal(known.states.imageUnderstanding.adapted,false);assert.equal(untouched.states.imageUnderstanding.adapted,false);
 assert.deepEqual(nativeImageCandidates({models:[adapted]})[0],adapted);
});
test('text eligibility never substitutes for image capability, policy, modalities or adapter',()=>{
 for(const mutate of [c=>c.permission=false,c=>c.tasks.imageUnderstanding.value=null,c=>c.localPolicy.tasks=['textChat'],c=>c.inputModalities.value=['text'],c=>c.states.imageUnderstanding.adapted=false,c=>c.states.imageUnderstanding.endpointCompatible=false]){
  const c=model();mutate(c);assert.equal(routeChatTask(request(c)).ok,false);
 }
 const c=model();c.states.imageUnderstanding={adapted:true,endpointCompatible:true,verified:true,autoEligible:true};
 assert.equal(routeChatTask({...request(c),selection:{mode:'auto'}}).resolvedModelId,c.id);
});
