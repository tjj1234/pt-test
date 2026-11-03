import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),policy=require('../../shell/models/release-media-policy.cjs'),{routeMediaTask}=require('../../shell/models/media-task-router.cjs');
test('standard-three release excludes Seedance and image-to-video',()=>{
 for(const type of ['text2image','image2image','text2video'])assert.equal(policy.allowedTask(type,'standard3'),true);
 assert.equal(policy.allowedTask('image2video','standard3'),false);assert.equal(policy.allowedTask('text2video','off'),false);
 assert.deepEqual(policy.visibleModels([{id:'Seedance-1-5'},{id:'dreamina-seedance-mini'},{id:'wan'}]),[{id:'wan'}]);
 for(const mode of ['auto','manual']){const r=routeMediaTask({candidates:[{id:'dreamina-seedance-2-0-mini'}],availability:{status:'available',scopeId:'fixture',modelIds:['dreamina-seedance-2-0-mini']},taskType:'text2video',selection:{mode,modelId:'dreamina-seedance-2-0-mini'}});assert.equal(r.ok,false);assert.equal(r.detail[0].code,'MODEL_EXCLUDED_FROM_RELEASE');}
});
