import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {readHostMediaReviews,createReviewedMediaCatalogGetter}=require('../../shell/models/reviewed-media-catalog-view.cjs');
const {normalizePtRecord}=require('../../shell/models/capabilities.cjs');
const {buildReviewedMediaQualificationMaps}=require('../../shell/models/reviewed-media-qualification.cjs');
const {routeMediaTask}=require('../../shell/models/media-task-router.cjs');
const now=Date.parse('2026-10-29T00:00:00.000Z'),scopeId='pt-scope-'+'a'.repeat(64);
const model=normalizePtRecord({id:'reviewed-image',supported_endpoint_types:['image-generation']},{scopeId,observedAt:new Date(now).toISOString(),permission:true});
const catalog={scopeId,models:[model],availability:{status:'available',modelIds:[model.id]},catalogDiagnostics:{state:'fresh',errorCode:null,lastSuccessfulAt:new Date(now).toISOString()}};
const review=()=>({modelId:model.id,scopeId,capabilityRevision:model.capabilityRevision,version:'1',source:'https://vendor.example/model-specific-page',reviewedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),tasks:[{taskType:'text2image',source:'https://vendor.example/model-specific-page',adapterId:'pt-image-generations-v1',endpoint:'openai-images-generations'}]});
function fixture(run){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'northstar-review-file-'));const file=path.join(dir,'review.json');const write=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});try{return run({dir,file,write});}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('host file is bounded, exact-schema and time-limited',()=>fixture(({file,write})=>{
 const value={schemaVersion:1,reviews:[review()]};write(value);assert.equal(readHostMediaReviews(file,{now}).length,1);
 for(const mutate of [v=>v.extra=true,v=>v.reviews[0].expiresAt=new Date(now).toISOString(),v=>v.reviews[0].expiresAt=new Date(now+86400001).toISOString(),v=>v.reviews[0].modelId='__proto__',v=>v.reviews[0].tasks[0].extra=true]){const bad=structuredClone(value);mutate(bad);write(bad);assert.throws(()=>readHostMediaReviews(file,{now}),{code:'MEDIA_HOST_REVIEW_INVALID'});}
}));
test('unsafe file types, links, permissions and oversized bytes deny without details',()=>fixture(({dir,file,write})=>{
 write({schemaVersion:1,reviews:[]});fs.chmodSync(file,0o666);assert.throws(()=>readHostMediaReviews(file,{now}));fs.chmodSync(file,0o600);
 const link=path.join(dir,'link');fs.symlinkSync(file,link);assert.throws(()=>readHostMediaReviews(link,{now}));
 const hard=path.join(dir,'hard');fs.linkSync(file,hard);assert.throws(()=>readHostMediaReviews(file,{now}));fs.unlinkSync(hard);
 fs.writeFileSync(file,'x'.repeat(65537));assert.throws(()=>readHostMediaReviews(file,{now}),error=>error.code==='MEDIA_HOST_REVIEW_INVALID'&&!error.message.includes(dir));
}));
test('review overlays exact current scope/revision without mutating base cache or enabling AUTO',async()=>{
 const before=structuredClone(catalog);const get=createReviewedMediaCatalogGetter({getCatalog:async()=>catalog,readReviews:()=>[review()]});
 const result=await get({});assert.deepEqual(catalog,before);
 const input={candidates:result.models,availability:{...result.availability,scopeId},taskType:'text2image'};
 assert.equal(routeMediaTask({...input,selection:{mode:'manual',modelId:model.id}}).ok,true);
 assert.equal(routeMediaTask({...input,selection:{mode:'auto'}}).ok,false);
 assert.equal(result.models[0].states.textToImage.verified,false);
 assert.deepEqual((await get({})).models,result.models);
});
test('changed credential scope cannot receive another scope review',async()=>{
 const other={...catalog,scopeId:'pt-scope-'+'b'.repeat(64)};
 const result=await createReviewedMediaCatalogGetter({getCatalog:async()=>other,readReviews:()=>[review()]})({});
 assert.equal(result,other);
});
test('revision drift, permission revocation and failed refresh reject reviewed admission',async()=>{
 for(const current of [{...catalog,catalogDiagnostics:{state:'sync_failed',errorCode:'PT_HTTP_ERROR'}},{...catalog,models:[{...model,permission:false}]},{...catalog,models:[{...model,capabilityRevision:'0'.repeat(64)}]}]){
  const get=createReviewedMediaCatalogGetter({getCatalog:async()=>current,readReviews:()=>[review()]});await assert.rejects(get({}));
 }
});
test('removing all host reviews restores the unmodified base catalog',async()=>{
 let reviews=[review()];const get=createReviewedMediaCatalogGetter({getCatalog:async()=>catalog,readReviews:()=>reviews});assert.notEqual(await get({}),catalog);reviews=[];assert.equal(await get({}),catalog);
});
test('overlay uses the same revision and facts as normalization while retaining unrelated metadata',async()=>{
 const maps=buildReviewedMediaQualificationMaps({catalog,reviews:[review()]});
 const expected=normalizePtRecord({id:model.id,supported_endpoint_types:['image-generation']},{scopeId,observedAt:new Date(now).toISOString(),permission:true,override:maps.overrides[model.id],localPolicy:maps.policies[model.id],adaptations:maps.adaptations[model.id],verifications:maps.verifications[model.id]});
 const actual=(await createReviewedMediaCatalogGetter({getCatalog:async()=>catalog,readReviews:()=>[review()]})({})).models[0];
 assert.equal(actual.capabilityRevision,expected.capabilityRevision);
 for(const key of ['tasks','inputModalities','outputModalities','endpoints','ptEndpointTasks','features','limits','states'])assert.deepEqual(actual[key],expected[key]);
});
