'use strict';
const {guardStructuredDocumentInput}=require('../exports/document-input-guard-candidate.cjs');
const {exportDocumentInWorker}=require('../exports/conversation-docx.cjs');
const {writeDocumentRunArtifact}=require('../runtime/csv-run-artifact.cjs');
const fail=code=>Object.assign(new Error('Document export could not be verified'),{code});
function createDocumentExportHandler({workspaceRoot,identity,runId,assertLive,emit}){
 if(typeof assertLive!=='function'||typeof emit!=='function')throw fail('DOCUMENT_EXPORT_CONFIGURATION_INVALID');
 return {async handle({args,signal}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='document,format'||!['docx','pdf','xlsx'].includes(args.format))throw fail('DOCUMENT_EXPORT_INPUT_INVALID');
  const {normalized:document}=guardStructuredDocumentInput(args.document,{maxBytes:65536,maxCells:5000,maxRows:1000,maxSections:20,maxParagraphs:500});
  if(signal?.aborted)throw fail('DOCUMENT_EXPORT_CANCELLED');await assertLive();
  const result=await exportDocumentInWorker({document,format:args.format,signal});
  if(signal?.aborted)throw fail('DOCUMENT_EXPORT_CANCELLED');await assertLive();
  const artifact=writeDocumentRunArtifact({workspaceRoot,tenantId:identity.tenantId,runId,bytes:result.bytes,format:args.format});
  if(signal?.aborted)throw fail('DOCUMENT_EXPORT_CANCELLED');
  await emit('artifact',{artifact});
  return {artifact,sourceSha256:result.sourceSha256,sha256:result.sha256,degradations:result.degradations};
 }};
}
module.exports={createDocumentExportHandler};
