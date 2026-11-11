'use strict';
const {Worker}=require('node:worker_threads'),path=require('node:path');
const {decodeTextBuffer}=require('./text-decode.cjs');const fail=code=>Object.assign(new Error('Document bundle could not be parsed'),{code});
async function parseDocumentBundle({bytes,signal,parseMember}){
 const files=await new Promise((resolve,reject)=>{
  const data=Uint8Array.from(bytes),worker=new Worker(path.join(__dirname,'document-bundle-worker.cjs'),{workerData:{bytes:data},transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});let response,failure;
  const cancel=()=>{failure=fail('OFFICE_CANCELLED');void worker.terminate();};signal.addEventListener('abort',cancel,{once:true});
  worker.on('message',r=>{if(response){failure=fail('OFFICE_PROTOCOL_INVALID');void worker.terminate();}else response=r;});worker.on('error',()=>{failure=fail('OFFICE_ZIP_INVALID');});
  worker.on('exit',code=>{signal.removeEventListener('abort',cancel);if(failure)return reject(failure);if(code!==0||!response?.ok)return reject(fail(response?.code||'OFFICE_ZIP_INVALID'));resolve(response);});if(signal.aborted)cancel();
 });
 const blocks=[];let warnings=files.ignoredCount,total=0;
 for(const member of files.files){
  if(signal.aborted)throw fail('OFFICE_CANCELLED');const data=Buffer.from(member.bytes);let parsed;
  if(['txt','md','csv'].includes(member.format)){
   const text=decodeTextBuffer(data);if(text===null)throw fail('OFFICE_ZIP_MEMBER_ENCODING_UNSUPPORTED');
   if(member.format==='csv'){const csv=require('./csv-parser.cjs').parseCsv(data);parsed={blocks:csv.rows.flatMap(row=>row.map(cell=>({text:cell.value,locator:{row:cell.row,column:cell.column}}))),warningCount:0};}
   else parsed={blocks:text.split(/\r\n|\r|\n/).map((text,i)=>({text,locator:{line:i+1}})),warningCount:0};
  }else parsed=await parseMember({bytes:data,format:member.format,signal});
  warnings+=parsed.warningCount||0;
  for(const [memberBlockIndex,block] of parsed.blocks.entries()){total+=Buffer.byteLength(block.text);if(total>5*1024*1024||blocks.length>=10000)throw fail('OFFICE_TEXT_LIMIT');blocks.push({index:blocks.length+1,text:block.text,locator:{kind:'archive-member',member:member.name,memberSha256:member.sha256,memberFormat:member.format,memberBlock:(block.index||memberBlockIndex+1),inner:block.locator||{kind:'extracted-text-block-not-page',blockIndex:block.index||memberBlockIndex+1}}});}
 }
 return {format:'zip',text:blocks.map(b=>b.text).join('\n\n'),blocks,locatorKind:'archive-member-and-inner-location',warningCount:warnings,limitations:'Only supported document members are parsed; nested generic archives and executable members are rejected. macOS metadata is ignored with a warning. Citations bind the original archive SHA and each member SHA; page numbers are supplied only by real PDF extraction.'};
}
module.exports={parseDocumentBundle};
