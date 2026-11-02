import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const catalog=require('../../shell/model-catalog.cjs');
const {normalizePtRecord}=require('../../shell/models/capabilities.cjs');
const {routeTextTask}=require('../../shell/models/task-router.cjs');

test('only a matching successful manual model response promotes AUTO eligibility',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pt-auto-verification-'));
 try{
  const scope='pt-scope-'+'a'.repeat(64),id='fixture-chat',runId='32c1b6f8-a12a-429b-b947-196a5ceaa686';
  const at=new Date().toISOString();
  const model=normalizePtRecord({id,supported_endpoint_types:['openai-response'],input_modalities:['text'],output_modalities:['text']},{scopeId:scope,observedAt:at,permission:true,localPolicy:{enabled:true,source:'review',version:'1',tasks:['textChat']},adaptations:{textChat:{adapterId:'locked-dsh',version:'1',endpoint:'openai-chat-completions',source:'review'}}});
  const snapshot={scopeId:scope,models:[model],lastSuccessfulAt:at,lastCompleteAt:null,nextSyncAt:null,syncFailureCount:0};
  assert.equal(catalog.writeScopedCache(scope,snapshot,{cacheDir:dir}),true);
  const current={scopeId:scope,models:[model],availability:{status:'available',modelIds:[id]}};
  const budget={snapshot:{modelCalls:1,policyStatus:'configured'}};
  const modelIdentity={responses:[{configuredModelId:id,providerReportedModelId:null}]};
  const input={catalog:current,modelId:id,runId,budget,modelIdentity,cacheDir:dir};
  assert.equal(catalog.recordManualTextChatVerification({...input,budget:{snapshot:{modelCalls:0,policyStatus:'configured'}}}),false);
  assert.equal(catalog.recordManualTextChatVerification({...input,modelIdentity:{responses:[{configuredModelId:id,providerReportedModelId:'other'}]}}),false);
  assert.equal(catalog.recordManualTextChatVerification({...input,catalog:{...current,models:[{...model,capabilityRevision:'b'.repeat(64)}]}}),false);
  assert.equal(catalog.recordManualTextChatVerification(input),true);
  const saved=catalog.readScopedCache(scope,{cacheDir:dir});
  assert.equal(saved.models[0].states.textChat.autoEligible,true);
  assert.equal(saved.models[0].verifications.textChat.source,`product-run/${runId}`);
  assert.equal(routeTextTask({candidates:saved.models,requirements:{task:'textChat'},availability:current.availability}).resolvedModelId,id);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
