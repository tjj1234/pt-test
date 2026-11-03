'use strict';
// Release-owned, model-specific standard API facts. Fresh permission is still
// required on every use. This enables manual qualification, never verification.
const {buildReviewedMediaQualificationMaps}=require('./reviewed-media-qualification.cjs');
const {applyReviewedOverride}=require('./capabilities.cjs');
const FACTS=Object.freeze({
 'seedream-5-0-260128':{source:'https://powertokens.ai/models/seedream-5-0-260128',tasks:['text2image','image2image'],adapterId:'pt-image-generations-v1',endpoint:'openai-images-generations'},
 'wan2.7-t2v':{source:'https://www.powertokens.ai/models/wan2.7-t2v',tasks:['text2video'],adapterId:'pt-video-generations-v1',endpoint:'openai-videos'}
});
function standardMediaCatalog(catalog){
 if(catalog?.catalogDiagnostics?.state!=='fresh'||catalog.catalogDiagnostics.errorCode||catalog.availability?.status!=='available')return catalog;
 const reviewedAt=new Date().toISOString();
 const reviews=(catalog.models||[]).filter(m=>Object.hasOwn(FACTS,m.id)&&m.permission===true&&m.availability==='present').map(m=>{
  const f=FACTS[m.id];return {modelId:m.id,scopeId:catalog.scopeId,capabilityRevision:m.capabilityRevision,version:'standard3-release-20261103',source:f.source,reviewedAt,tasks:f.tasks.map(taskType=>({taskType,source:f.source,adapterId:f.adapterId,endpoint:f.endpoint}))};
 });
 if(!reviews.length)return catalog;
 const maps=buildReviewedMediaQualificationMaps({catalog,reviews});
 return {...catalog,models:catalog.models.map(m=>Object.hasOwn(maps.overrides,m.id)?applyReviewedOverride(m,{override:maps.overrides[m.id],localPolicy:maps.policies[m.id],adaptations:maps.adaptations[m.id],verifications:maps.verifications[m.id]}):m)};
}
module.exports={standardMediaCatalog};
