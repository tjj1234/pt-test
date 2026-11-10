'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {createHash}=require('node:crypto');
const {buildSourceIndex,querySourceIndex}=require('./source-retrieval-candidate.cjs');
const {inspectOfficeZip}=require('./office-zip-guard.cjs');
(async()=>{
 try{
  const indexes=[],trustedSources=[],coverage=[];
  for(const source of workerData.sources){
   const bytes=Buffer.from(source.data),format=source.format==='md'?'markdown':source.format;
   if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('snapshot');
   let blocks;
   if(format==='pdf'){
    if(!Array.isArray(source.pdfBlocks))throw Error('PDF parse authority missing');blocks=source.pdfBlocks;
   }else if(['docx','xlsx','pptx'].includes(format)){
    const archive=inspectOfficeZip(bytes);
    if(format==='docx'){
     const parsed=await require('mammoth').extractRawText({buffer:bytes});
     if(parsed.value.length>5*1024*1024)throw Error('limit');
     blocks=parsed.value.split(/\n\n/).map(text=>({text}));
    }else blocks=require('./ooxml-structured-text.cjs').extractStructuredOffice(bytes,format,archive).blocks;
   }else if(format==='csv'){
    const parsed=require('./csv-parser.cjs').parseCsv(bytes);
    blocks=parsed.rows.flatMap(row=>row.map(cell=>({text:cell.value,locator:{row:cell.row,column:cell.column,sourceLine:cell.sourceLine,sourceColumn:cell.sourceColumn}})));
   }else{
    const text=require('./text-decode.cjs').decodeTextBuffer(bytes);if(text===null)throw Error('text');
    blocks=text.split(/\r\n|\n|\r/).map((text,index)=>({text,locator:{line:index+1}}));
   }
   const totalBlocks=blocks.length;
   blocks=blocks.slice(0,5000).map((block,index)=>({...block,index:index+1}));
   const index=buildSourceIndex({tenantId:workerData.tenantId,documentId:source.ref,sourceSha256:source.sha256,version:source.version,format,blocks});
   indexes.push(index);trustedSources.push({tenantId:index.tenantId,documentId:index.documentId,sourceSha256:index.sourceSha256,version:index.documentVersion,coverageHash:index.summary.coverageHash});
   coverage.push({sourceId:source.id,sourceRef:source.ref,version:source.version,sourceSha256:source.sha256,totalBlocks,indexedBlocks:blocks.length,truncated:blocks.length<totalBlocks});
  }
  if(workerData.citations){
   const results=workerData.citations.map(citation=>{
    const index=indexes.find(index=>index.documentId===citation.sourceRef);
    const block=index?.blocks[citation.blockIndex-1];
    if(!index||index.sourceSha256!==citation.sourceSha256||index.documentVersion!==citation.version||!block||block.textSha256!==citation.textSha256)throw Error('citation');
    return {sourceRef:index.documentId,sourceSha256:index.sourceSha256,version:index.documentVersion,blockIndex:block.blockIndex,locator:block.locator,textSha256:block.textSha256,excerpt:block.text.slice(0,2000),truncated:block.text.length>2000};
   });
   parentPort.postMessage({ok:true,result:{citations:results,coverage}});
  }else{
   const result=querySourceIndex({tenantId:workerData.tenantId,query:workerData.query,indexes,trustedSources,options:{maxResults:10}});
   result.results=result.results.map(({rawText,...hit})=>({...hit,excerpt:hit.excerpt.slice(0,512)}));
   parentPort.postMessage({ok:true,result:{...result,sourceCoverage:coverage}});
  }
 }catch{parentPort.postMessage({ok:false,code:'SOURCE_SEARCH_FAILED'});}
})().finally(()=>parentPort.close());
