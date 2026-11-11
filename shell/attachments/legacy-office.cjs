'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const fail=code=>Object.assign(new Error('Legacy Office input could not be safely parsed'),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let verified;
function runtime(){
 const root=path.resolve(process.env.PT_LEGACY_OFFICE_RUNTIME||path.join(__dirname,'vendor-legacy'));
 const file=path.join(root,'manifest.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw fail('OFFICE_LEGACY_BACKEND_UNAVAILABLE');
 const raw=fs.readFileSync(file),signature=sha(raw);if(verified?.root===root&&verified.signature===signature)return verified;
 const m=JSON.parse(raw);if(m.schemaVersion!==1||m.platform!=='linux'||m.arch!=='x64'||!m.files||Object.keys(m.files).length>256)throw fail('OFFICE_LEGACY_RUNTIME_UNTRUSTED');
 for(const [name,record]of Object.entries(m.files)){
  if(!/^(?:bin\/(?:catdoc|xls2csv|catppt|ole-safety)|charsets\/[a-zA-Z0-9_.-]+)$/.test(name))throw fail('OFFICE_LEGACY_RUNTIME_UNTRUSTED');
  const f=path.join(root,name),s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.size!==record.size||sha(fs.readFileSync(f))!==record.sha256)throw fail('OFFICE_LEGACY_RUNTIME_UNTRUSTED');
 }
 for(const bin of ['catdoc','xls2csv','catppt','ole-safety'])if(!m.files['bin/'+bin])throw fail('OFFICE_LEGACY_RUNTIME_UNTRUSTED');
 verified={root,signature,files:Object.keys(m.files)};return verified;
}
async function parseLegacyOffice({bytes,format,signal}){
 if(!['doc','xls','ppt'].includes(format)||!Buffer.isBuffer(bytes)||bytes.length<512||bytes.length>20*1024*1024||bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw fail('OFFICE_FORMAT_MISMATCH');
 if(signal?.aborted)throw fail('OFFICE_CANCELLED');
 const backend=runtime(),parent=process.env.PT_MEDIA_PROCESSING_DIR||path.join(process.env.PT_RUNTIME_DIR||os.tmpdir(),'legacy-office');fs.mkdirSync(parent,{recursive:true,mode:0o700});
 const root=fs.realpathSync(fs.mkdtempSync(path.join(parent,'legacy-')));
 try{
  fs.mkdirSync(path.join(root,'bin'),{mode:0o700});fs.mkdirSync(path.join(root,'charsets'),{mode:0o700});
  for(const name of backend.files){fs.writeFileSync(path.join(root,name),fs.readFileSync(path.join(backend.root,name)),{flag:'wx',mode:name.startsWith('bin/')?0o500:0o400});}
  fs.writeFileSync(path.join(root,'.catdocrc'),'charset_path=./charsets\nmap_path=./charsets\nsource_charset=cp1252\ntarget_charset=utf-8\nuse_locale=no\n',{flag:'wx',mode:0o400});
  fs.writeFileSync(path.join(root,'input.bin'),bytes,{flag:'wx',mode:0o400});
  const {runLegacyProcess}=await import('../runtime/native-readonly-process.mjs');
  const checked=await runLegacyProcess({root,program:'ole-safety',args:[format,'input.bin'],signal,maxBytes:1024});
  if(checked.exitCode!==0||checked.stdout.trim()!=='OLE_SAFE')throw fail(({66:'OFFICE_ENCRYPTED',67:'OFFICE_ACTIVE_CONTENT_UNSUPPORTED',68:'OFFICE_FORMAT_MISMATCH'})[checked.exitCode]||'OFFICE_LEGACY_INVALID');
  const separator='\nR34_BOUNDARY_'+randomUUID()+'\n',program={doc:'catdoc',xls:'xls2csv',ppt:'catppt'}[format];
  const args=['-d','utf-8',...(format==='doc'?[]:['-b',separator]),'input.bin'];
  const output=await runLegacyProcess({root,program,args,signal});
  if(output.exitCode!==0||output.signal||output.stderr.trim())throw fail('OFFICE_LEGACY_PARSE_FAILED');
  if(!output.stdout.trim())throw fail('OFFICE_NO_TEXT');
  const blocks=[];
  if(format==='xls'){
   const {parseCsv}=require('./csv-parser.cjs');for(const [sheet,text]of output.stdout.split(separator).entries()){
    if(!text.trim())continue;const csv=parseCsv(Buffer.from(text));for(const row of csv.rows)for(const cell of row)blocks.push({index:blocks.length+1,text:cell.value,locator:{kind:'legacy-sheet-export-cell',sheet:sheet+1,row:cell.row,column:cell.column}});
   }
  }else for(const [segment,text]of output.stdout.split(format==='ppt'?separator:'\n\n').entries())if(text.trim())blocks.push({index:blocks.length+1,text:text.trim(),locator:{kind:'legacy-extracted-segment-not-page',segment:segment+1}});
  if(blocks.length>10000)throw fail('OFFICE_BLOCK_LIMIT');
  return {format,text:blocks.map(b=>b.text).join('\n\n'),blocks,locatorKind:format==='xls'?'legacy-sheet-export-cell':'legacy-extracted-segment-not-page',warningCount:0,limitations:'Text/value extraction using Debian-patched catdoc 0.95. Formatting, formulas, merged cells and original pagination are not preserved; XLS coordinates refer to exported tables, not guaranteed original Excel addresses. Macros/embedded active content are rejected; no external links are fetched.'};
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={parseLegacyOffice,verifyLegacyRuntime:runtime};
