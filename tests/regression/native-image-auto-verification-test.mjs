import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),catalog=require('../../shell/model-catalog.cjs');
const {normalizePtRecord}=require('../../shell/models/capabilities.cjs');
const {nativeImageCandidates}=require('../../shell/models/native-image-qualification.cjs');
const {routeChatTask}=require('../../shell/models/task-router.cjs');
test('image AUTO qualification requires native image admission and matching fresh scope/revision',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-image-auto-'));
 try{
  const scope='pt-scope-'+'b'.repeat(64),at=new Date().toISOString(),id='vision-fixture';
  const model=normalizePtRecord({id,supported_tasks:['textChat','imageUnderstanding'],supported_endpoint_types:['openai-response'],input_modalities:['text','image'],output_modalities:['text']},
   {scopeId:scope,observedAt:at,permission:true,localPolicy:{enabled:true,source:'fixture-policy',version:'1',tasks:['textChat']}});
  const snapshot={scopeId:scope,models:[model],lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0};
  const current={scopeId:scope,models:[model],availability:{status:'available',modelIds:[id]}};
  const write=()=>assert.equal(catalog.writeScopedCache(scope,snapshot,{cacheDir:dir}),true);write();
  const input={catalog:current,modelId:id,runId:'32c1b6f8-a12a-429b-b947-196a5ceaa686',cacheDir:dir,
   budget:{snapshot:{modelCalls:1,policyStatus:'configured'}},modelIdentity:{responses:[{configuredModelId:id,providerReportedModelId:null}]},
   imageInput:{kind:'dsh-native-images-v1',newImageCount:1,capabilityChecked:true}};
  for(const imageInput of [undefined,{kind:'dsh-native-images-v1',newImageCount:0,capabilityChecked:true},{kind:'dsh-native-images-v1',newImageCount:1,capabilityChecked:false}]){
   assert.equal(catalog.recordManualImageUnderstandingVerification({...input,imageInput}),false);
  }
  assert.equal(catalog.recordManualImageUnderstandingVerification({...input,modelIdentity:{responses:[{configuredModelId:id,providerReportedModelId:'other'}]}}),false);
  assert.equal(catalog.recordManualImageUnderstandingVerification({...input,catalog:{...current,models:[{...model,capabilityRevision:'c'.repeat(64)}]}}),false);
  snapshot.models[0]={...model,permission:false};write();assert.equal(catalog.recordManualImageUnderstandingVerification(input),false);
  snapshot.models[0]=model;write();assert.equal(catalog.recordManualImageUnderstandingVerification(input),true);
  const saved=catalog.readScopedCache(scope,{cacheDir:dir});
  assert.equal(saved.models[0].states.imageUnderstanding.autoEligible,true);
  assert.equal(saved.models[0].states.textChat.verified,false);
  assert.equal(routeChatTask({candidates:nativeImageCandidates({models:saved.models}),requirements:{task:'imageUnderstanding'},availability:current.availability}).resolvedModelId,id);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
