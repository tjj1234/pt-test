'use strict';
const path=require('node:path'),{Worker}=require('node:worker_threads'),{createHash}=require('node:crypto');
const fail=code=>Object.assign(new Error('Office document could not be parsed'),{code});let activeWorkers=0;
function parseOfficeWorker({bytes,format,signal,timeoutMs=10000}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)return Promise.reject(fail('OFFICE_INPUT_LIMIT'));
 if(!['docx','xlsx','pptx','pdf'].includes(format))return Promise.reject(fail('OFFICE_FORMAT_UNSUPPORTED'));
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)return Promise.reject(fail('OFFICE_LIMIT_INVALID'));
 if(signal?.aborted)return Promise.reject(fail('OFFICE_CANCELLED'));
 const sourceSha256=createHash('sha256').update(bytes).digest('hex'),sourceBytes=bytes.length,data=Uint8Array.from(bytes);
 return new Promise((resolve,reject)=>{
  let worker;
  try{worker=new Worker(path.join(__dirname,'office-document-worker.cjs'),{workerData:{format,bytes:data},transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});}
  catch{reject(fail('OFFICE_WORKER_FAILED'));return;}
  let response=null,failure=null,settled=false;const controller=new AbortController();
  const stop=code=>{if(!failure){failure=fail(code);controller.abort();void worker.terminate();}};
  const cancel=()=>stop('OFFICE_CANCELLED');signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(()=>stop('OFFICE_TIMEOUT'),timeoutMs);
  worker.on('message',message=>{if(response)return stop('OFFICE_PROTOCOL_INVALID');response=message;});
  worker.on('error',()=>{if(!failure)failure=fail('OFFICE_WORKER_FAILED');});
  worker.on('exit',async code=>{
   if(settled)return;settled=true;
   try{
    if(failure)throw failure;if(code!==0||!response)throw fail('OFFICE_WORKER_FAILED');
    if(response.ok!==true)throw fail(/^OFFICE_[A-Z_]+$/.test(response.code||'')?response.code:'OFFICE_PARSE_FAILED');
    const result=response.result,pages=result.ocrPages||[];delete result.ocrPages;
    for(const page of pages){
     if(controller.signal.aborted)throw failure||fail('OFFICE_CANCELLED');
     try{result.blocks[page.page-1].text=await require('../media/local-content-runtime.cjs').recognizeImage(Buffer.from(page.image),{signal:controller.signal});result.blocks[page.page-1].locator.method='ocr';}
     catch{if(failure)throw failure;throw fail('OFFICE_PDF_OCR_UNAVAILABLE');}
    }
    if(pages.length){result.text=result.blocks.map(b=>b.text).join('\n\n');result.ocrPageCount=pages.length;result.warningCount=result.blocks.filter(b=>!b.text).length;result.limitations='PDF text layer plus local OCR on empty text pages; OCR can misrecognize. Page numbers are physical PDF pages, not inferred Word pagination.';}
    if(Buffer.byteLength(result.text)>5*1024*1024)throw fail('OFFICE_TEXT_LIMIT');
    if(failure||signal?.aborted)throw failure||fail('OFFICE_CANCELLED');resolve(Object.freeze({...result,sourceSha256,sourceBytes}));
   }catch(error){reject(failure||(/^OFFICE_[A-Z_]+$/.test(error.code||'')?error:fail('OFFICE_PARSE_FAILED')));}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  });if(signal?.aborted)cancel();
 });
}
async function parseOfficeDocument({bytes,format,signal,timeoutMs=10000}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw fail('OFFICE_INPUT_LIMIT');
 if(!['docx','xlsx','pptx','pdf','doc','xls','ppt','zip'].includes(format))throw fail('OFFICE_FORMAT_UNSUPPORTED');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw fail('OFFICE_LIMIT_INVALID');
 if(signal?.aborted)throw fail('OFFICE_CANCELLED');if(activeWorkers>=2)throw fail('OFFICE_PARSER_BUSY');
 const deadline=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,deadline]):deadline;
 async function parse(options){
  if(['doc','xls','ppt'].includes(options.format))return require('./legacy-office.cjs').parseLegacyOffice({...options,signal:combined});
  return parseOfficeWorker({...options,signal:combined,timeoutMs});
 }
 activeWorkers++;
 try{
  const result=format==='zip'?await require('./document-bundle.cjs').parseDocumentBundle({bytes,signal:combined,parseMember:parse}):await parse({bytes,format});
  if(combined.aborted)throw fail(signal?.aborted?'OFFICE_CANCELLED':'OFFICE_TIMEOUT');
  return Object.freeze({...result,sourceSha256:createHash('sha256').update(bytes).digest('hex'),sourceBytes:bytes.length});
 }catch(error){if(signal?.aborted)throw fail('OFFICE_CANCELLED');if(deadline.aborted)throw fail('OFFICE_TIMEOUT');if(/^ISOLATION_/.test(error.code||'')||error.code==='ENOENT')throw fail('OFFICE_LEGACY_BACKEND_UNAVAILABLE');throw /^OFFICE_[A-Z_]+$/.test(error.code||'')?error:fail('OFFICE_PARSE_FAILED');}
 finally{activeWorkers--;}
}
module.exports={parseOfficeDocument};
