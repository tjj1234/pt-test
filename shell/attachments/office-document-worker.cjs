'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {inspectOfficeZip}=require('./office-zip-guard.cjs');
(async()=>{
 try{
  const bytes=Buffer.from(workerData.bytes);
  if(workerData.format==='pdf'){
   const result=await require('./pdf-text-parser.cjs').extractPdfText(bytes);
   parentPort.postMessage({ok:true,result});return;
  }
  const archive=inspectOfficeZip(bytes);
  if(['xlsx','pptx'].includes(workerData.format)){
   const result=require('./ooxml-structured-text.cjs').extractStructuredOffice(bytes,workerData.format,archive);
   parentPort.postMessage({ok:true,result});return;
  }
  if(workerData.format!=='docx'||!archive.names.includes('word/document.xml'))throw Object.assign(Error(),{code:'OFFICE_FORMAT_MISMATCH'});
  // Raw text only: never embed converted HTML, execute macros, or supply a
  // filesystem path. One fresh worker per document contains parser state.
  const result=await require('mammoth').extractRawText({buffer:bytes});
  if(Buffer.byteLength(result.value)>5*1024*1024)throw Object.assign(Error(),{code:'OFFICE_TEXT_LIMIT'});
  const blocks=result.value.split(/\n\n/).map((text,index)=>({index:index+1,text}));
  if(blocks.length>10000)throw Object.assign(Error(),{code:'OFFICE_BLOCK_LIMIT'});
  parentPort.postMessage({ok:true,result:{format:'docx',text:result.value,blocks,
   locatorKind:'extracted-text-block-not-page',warningCount:result.messages.length,expandedBytes:archive.expandedBytes}});
 }catch(error){parentPort.postMessage({ok:false,code:typeof error.code==='string'&&/^OFFICE_[A-Z_]+$/.test(error.code)?error.code:'OFFICE_PARSE_FAILED'});}
})().finally(()=>parentPort.close());
