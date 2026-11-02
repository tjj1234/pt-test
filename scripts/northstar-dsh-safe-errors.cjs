'use strict';
// Read-only bounded JSONL diagnosis. Never print messages, paths, prompts or keys.
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];
if(!root||!path.isAbsolute(root))throw Error('ABSOLUTE_ROOT_REQUIRED');
let visited=0,skipped=0,compressed=0;const files=[];
function walk(dir,depth){
 if(depth>12||visited>=10000){skipped++;return;}
 let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{skipped++;return;}
 for(const e of entries){if(++visited>10000){skipped++;break;}if(e.isSymbolicLink())continue;
 const p=path.join(dir,e.name);
 if(e.isDirectory())walk(p,depth+1);
 else if(e.isFile()&&(e.name.endsWith('.jsonl')||e.name.endsWith('.jsonl.zstd'))){try{const s=fs.statSync(p);if(s.size<=8*1024*1024)files.push({p,mtime:s.mtimeMs});else skipped++;}catch{skipped++;}}
 }
}
walk(root,0);files.sort((a,b)=>b.mtime-a.mtime);
const allowed=new Set(['MODEL_NOT_FOUND','UNSUPPORTED_CONTENT','UNSUPPORTED_REASONING_EFFORT','UNAUTHORIZED','RATE_LIMITED','INVALID_REQUEST','CONTEXT_LENGTH_EXCEEDED','NETWORK_ERROR','TIMEOUT','AUTHENTICATION_ERROR','RUN_MODEL_CALL_LIMIT','RUN_BUDGET_CONFIG_INVALID']);
const errors=[];
for(const code of ['AUTH','RATE_LIMIT','NO_ADAPTER','INVALID_ARGS','INVARIANT','UNKNOWN','MODEL_NOT_SUPPORTED','UNSUPPORTED_MODEL','PROVIDER_ERROR','NETWORK','ABORTED'])allowed.add(code);
for(const code of ['UNKNOWN_MODEL','INVALID_REPLAY_STATE','UNSUPPORTED_OPTION','TRANSPORT','STREAM_CLOSED','MALFORMED_RESPONSE','EMPTY_RESPONSE','INVALID_RESPONSE','API_ERROR','PROVIDER_UNAVAILABLE','MISSING_API_KEY','INVALID_API_KEY'])allowed.add(code);
for(const f of files.slice(0,100)){
 try{let bytes=fs.readFileSync(f.p);if(f.p.endsWith('.zstd')){const z=require('node:zlib');if(typeof z.zstdDecompressSync!=='function'){compressed++;continue;}bytes=z.zstdDecompressSync(bytes,{maxOutputLength:8*1024*1024});}for(const line of bytes.toString('utf8').split('\n')){
 if(!line||line.length>1024*1024)continue;let e;try{e=JSON.parse(line);}catch{continue;}
 if(e.type!=='turn/end'&&e.type!=='agent/request-error')continue;
 const d=e.data||e.payload||{},r=d.reason||{},err=r.error||d.error||{};
 if(r.kind!=='error'&&e.type!=='agent/request-error')continue;
 const status=[err.status,err.statusCode,err.details?.status].find(x=>Number.isInteger(x)&&x>=400&&x<=599);
 errors.push({sessionHash:require('node:crypto').createHash('sha256').update(f.p).digest('hex').slice(0,16),fileModifiedAt:new Date(f.mtime).toISOString(),seq:Number.isSafeInteger(e.seq)?e.seq:null,event:e.type,reason:r.kind==='error'?'error':undefined,code:allowed.has(err.code)?err.code:'UNCLASSIFIED',status:status??null});
 }}catch{skipped++;}
}
console.log(JSON.stringify({scanned:Math.min(files.length,100),skipped,compressedNotRead:compressed,errors:errors.slice(-30)}));
