'use strict';
const path=require('node:path'),{Worker}=require('node:worker_threads'),{createHash}=require('node:crypto');
const fail=code=>Object.assign(new Error('Office document could not be parsed'),{code});
let activeWorkers=0;
function parseOfficeDocument({bytes,format,signal,timeoutMs=10000}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)return Promise.reject(fail('OFFICE_INPUT_LIMIT'));
 if(!['docx','xlsx','pptx','pdf'].includes(format))return Promise.reject(fail('OFFICE_FORMAT_UNSUPPORTED'));
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)return Promise.reject(fail('OFFICE_LIMIT_INVALID'));
 if(signal?.aborted)return Promise.reject(fail('OFFICE_CANCELLED'));
 if(activeWorkers>=2)return Promise.reject(fail('OFFICE_PARSER_BUSY'));
 const sourceSha256=createHash('sha256').update(bytes).digest('hex'),sourceBytes=bytes.length,data=Uint8Array.from(bytes);
 return new Promise((resolve,reject)=>{
  let worker;activeWorkers++;
  try{worker=new Worker(path.join(__dirname,'office-document-worker.cjs'),{workerData:{format,bytes:data},transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});}
  catch{activeWorkers--;reject(fail('OFFICE_WORKER_FAILED'));return;}
  let response=null,failure=null,settled=false;
  const stop=code=>{if(!failure){failure=fail(code);void worker.terminate();}};
  const cancel=()=>stop('OFFICE_CANCELLED');signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>stop('OFFICE_TIMEOUT'),timeoutMs);
  worker.on('message',message=>{if(response)return stop('OFFICE_PROTOCOL_INVALID');response=message;});
  worker.on('error',()=>{if(!failure)failure=fail('OFFICE_WORKER_FAILED');});
  worker.on('exit',code=>{
   if(settled)return;settled=true;activeWorkers--;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
   if(failure)return reject(failure);
   if(code!==0||!response)return reject(fail('OFFICE_WORKER_FAILED'));
   if(response.ok!==true)return reject(fail(/^OFFICE_[A-Z_]+$/.test(response.code||'')?response.code:'OFFICE_PARSE_FAILED'));
   resolve(Object.freeze({...response.result,sourceSha256,sourceBytes}));
  });
  if(signal?.aborted)cancel();
 });
}
module.exports={parseOfficeDocument};
