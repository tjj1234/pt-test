'use strict';
const {isDeepStrictEqual}=require('node:util');
const candidate=require('./docx-evidence-index-candidate.cjs');
// Ownership and current source evidence must come from the trusted host.
// Rebuild all derived fields before accepting a persisted index.
function verifyDocxEvidenceIndex(index,target){
 if(!target||typeof target.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(target.sourceSha256)||!Number.isSafeInteger(target.version)||target.version<1)return false;
 if(!candidate.verifyDocxEvidenceIndex(index,target))return false;
 try{
  if(!Array.isArray(index.blocks)||index.blocks.length>candidate.MAX_BLOCKS_LIMIT)return false;
  const rebuilt=candidate.buildDocxEvidenceIndex({tenantId:target.tenantId,documentId:target.documentId,sourceSha256:target.sourceSha256,version:target.version,blocks:index.blocks.map(b=>({index:b.blockIndex,text:b.text}))});
  return isDeepStrictEqual(index,rebuilt);
 }catch{return false;}
}
module.exports={...candidate,verifyDocxEvidenceIndex};
