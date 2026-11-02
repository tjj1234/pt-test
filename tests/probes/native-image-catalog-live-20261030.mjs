// GET-only same-Key capability discovery. Credential enters a non-echo TTY,
// never argv/env/files; only allowlisted non-secret model facts are recorded.
import fs from 'node:fs';
if(!process.stdin.isTTY)throw Error('Non-echo TTY required');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
let input='',running=false;
console.log(JSON.stringify({state:'awaiting_non_echo_key',request:'GET /v1/models only'}));
process.stdin.on('data',async chunk=>{
 if(running)return;
 for(const char of chunk){
  if(char==='\u0003'){input='';process.stdin.setRawMode(false);process.exit(130);}
  if(char!=='\r'&&char!=='\n'){if(input.length<256)input+=char;continue;}
  running=true;let secret=input;input='';
  try{
   if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw Error('invalid credential format');
   const response=await fetch('https://api.powertokens.ai/v1/models',{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('catalog unavailable');const raw=await response.json();
   const safe=x=>typeof x==='string'&&x.length<=200&&/^[A-Za-z0-9_.:/-]+$/.test(x)&&!x.includes(secret)?x:null;
   const list=x=>Array.isArray(x)?x.map(safe).filter(Boolean).slice(0,30):null;
   const rows=(Array.isArray(raw.data)?raw.data:[]).map(m=>({id:safe(m.id),inputModalities:list(m.input_modalities),outputModalities:list(m.output_modalities),supportedTasks:list(m.supported_tasks),endpoints:list(m.supported_endpoint_types),
    explicitImageUnderstanding:typeof m.capabilities?.imageUnderstanding==='boolean'?m.capabilities.imageUnderstanding:
      typeof m.capabilities?.['image-understanding']==='boolean'?m.capabilities['image-understanding']:null})).filter(m=>m.id);
   const evidence={at:new Date().toISOString(),scope:'same-Key-GET-only-model-facts',httpStatus:response.status,count:rows.length,models:rows,paidPosts:0};
   const encoded=JSON.stringify(evidence,null,2)+'\n';if(encoded.includes(secret))throw Error('redaction refused');
   fs.writeFileSync('docs/refactor/evidence/native-image-catalog-live-20261030.json',encoded,{flag:'wx'});
   console.log(JSON.stringify({result:'PASS',count:rows.length,explicitImageFactCount:rows.filter(m=>m.explicitImageUnderstanding===true||m.supportedTasks?.some(t=>t==='imageUnderstanding'||t==='image-understanding')).length,explicitImageInputCount:rows.filter(m=>m.inputModalities?.includes('image')).length,paidPosts:0}));
  }catch{console.log(JSON.stringify({result:'INCOMPLETE',code:'CATALOG_DISCOVERY_FAILED_NO_PAID_POST'}));process.exitCode=1;}
  finally{secret='';process.stdin.setRawMode(false);process.stdin.pause();}
  return;
 }
});
