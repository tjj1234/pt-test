'use strict';
const {applyLocalUpdates}=require('./capabilities.cjs');
const ADAPTER=Object.freeze({adapterId:'northstar-dsh-native-image',version:'0.1.1-rc.2-image-v1',endpoint:'openai-chat-completions',source:'locked DSH native attachment and pi-ai image input pipeline'});
// Transport adaptation is known; model capability is never inferred from ID,
// provider name or a text endpoint. Keep the source facts and revision intact.
function nativeImageCandidates(catalog){
 return (catalog?.models||[]).map(model=>{
  if(model.tasks?.imageUnderstanding?.value!==true||!model.inputModalities?.value?.includes('image')||
    !model.inputModalities?.value?.includes('text')||!model.outputModalities?.value?.includes('text')||
    model.localPolicy?.enabled!==true)return model;
  const policy=model.localPolicy.tasks?.includes('imageUnderstanding')?model.localPolicy:
   {...model.localPolicy,tasks:[...new Set([...(model.localPolicy.tasks||[]),'imageUnderstanding'])],
    source:model.localPolicy.source+'; native image understanding product policy',version:model.localPolicy.version+'-image-v1'};
  return applyLocalUpdates(model,{policies:{[model.id]:policy},adaptations:{[model.id]:{...model.adaptations,imageUnderstanding:ADAPTER}}});
 });
}
module.exports={nativeImageCandidates,NATIVE_IMAGE_ADAPTER:ADAPTER};
