'use strict';
const {parentPort,workerData}=require('node:worker_threads'),{Unzip,UnzipInflate}=require('fflate'),{crc32}=require('node:zlib'),{createHash}=require('node:crypto');
const fail=code=>Object.assign(new Error('Document bundle rejected'),{code});
try{
 const bytes=Buffer.from(workerData.bytes);if(bytes.length<22||bytes.length>20*1024*1024||bytes.readUInt32LE(0)!==0x04034b50)throw fail('OFFICE_ZIP_INVALID');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))throw fail('OFFICE_ZIP_INVALID');
 const count=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),length=bytes.readUInt32LE(end+12);if(count<1||count>64||start+length!==end)throw fail('OFFICE_ZIP_ENTRY_LIMIT');
 const expected=new Map();let offset=start,declared=0;
 for(let i=0;i<count;i++){
  if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw fail('OFFICE_ZIP_INVALID');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),size=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
  if(flags&1)throw fail('OFFICE_ENCRYPTED');if(![0,8].includes(method))throw fail('OFFICE_ZIP_COMPRESSION_UNSUPPORTED');
  if(offset+46+nameLength+extra+comment>end||nameLength<1||nameLength>512||local+30>start||bytes.readUInt32LE(local)!==0x04034b50)throw fail('OFFICE_ZIP_INVALID');
  const raw=bytes.subarray(offset+46,offset+46+nameLength);if(!(flags&2048)&&raw.some(b=>b>127))throw fail('OFFICE_ZIP_NAME_ENCODING_UNSUPPORTED');
  const name=new TextDecoder('utf-8',{fatal:true}).decode(raw),directory=name.endsWith('/'),parts=(directory?name.slice(0,-1):name).split('/');
  if(name.startsWith('/')||name.includes('\\')||/^[a-z]:/i.test(name)||/[\x00-\x1f\x7f]/.test(name)||parts.some(s=>s==='..'||s==='.'||!s))throw fail('OFFICE_ZIP_PATH_INVALID');
  const type=(bytes.readUInt32LE(offset+38)>>>16)&0xf000;if(![0,0x8000,0x4000].includes(type)||(type===0x4000&&!directory))throw fail('OFFICE_ZIP_LINK_UNSUPPORTED');
  if(expected.has(name))throw fail('OFFICE_ZIP_DUPLICATE');
  const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28);if(!bytes.subarray(local+30,local+30+localName).equals(raw)||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||local+30+localName+localExtra+bytes.readUInt32LE(offset+20)>start)throw fail('OFFICE_ZIP_INVALID');
  if(directory&&size!==0)throw fail('OFFICE_ZIP_INVALID');
  declared+=size;if(size>10*1024*1024||declared>20*1024*1024)throw fail('OFFICE_ZIP_EXPANSION_LIMIT');
  if(/\.(?:exe|dll|com|bat|cmd|ps1|vbs|js|scr|docm|xlsm|pptm)$/i.test(name)||/vbaProject\.bin$/i.test(name))throw fail('OFFICE_ACTIVE_CONTENT_UNSUPPORTED');
  const ignored=parts[0]==='__MACOSX'||parts.at(-1)==='.DS_Store'||parts.at(-1).startsWith('._');
  const extension=name.split('.').at(-1).toLowerCase();if(!directory&&!ignored&&!['txt','md','csv','docx','xlsx','pptx','pdf','doc','xls','ppt'].includes(extension))throw fail('OFFICE_ZIP_MEMBER_UNSUPPORTED');
  expected.set(name,{size,crc:bytes.readUInt32LE(offset+16),directory,ignored,format:extension});offset+=46+nameLength+extra+comment;
 }
 if(offset!==end)throw fail('OFFICE_ZIP_INVALID');
 let actual=0,completed=0;const seen=new Set(),files=[];
 const unzip=new Unzip(file=>{
  const info=expected.get(file.name);if(!info||seen.has(file.name))throw fail('OFFICE_ZIP_INVALID');seen.add(file.name);let size=0,chunks=[];
  file.ondata=(error,chunk,final)=>{
   if(error)throw /^OFFICE_[A-Z_]+$/.test(error.code||'')?error:fail('OFFICE_ZIP_INVALID');actual+=chunk.length;size+=chunk.length;if(size>info.size||actual>20*1024*1024)throw fail('OFFICE_ZIP_EXPANSION_LIMIT');chunks.push(chunk);
   if(final){if(size!==info.size)throw fail('OFFICE_ZIP_INVALID');const data=Buffer.concat(chunks);if(crc32(data)!==info.crc)throw fail('OFFICE_ZIP_CHECKSUM_INVALID');completed++;
    if(!info.directory&&!info.ignored){if(files.length>=16)throw fail('OFFICE_ZIP_ENTRY_LIMIT');files.push({name:file.name,format:info.format,sha256:createHash('sha256').update(data).digest('hex'),bytes:Uint8Array.from(data)});}
   }
  };file.start();
 });unzip.register(UnzipInflate);
 for(let i=0;i<bytes.length;i+=1024)unzip.push(bytes.subarray(i,i+1024),i+1024>=bytes.length);
 if(completed!==count||!files.length)throw fail('OFFICE_ZIP_INVALID');
 parentPort.postMessage({ok:true,files,ignoredCount:[...expected.values()].filter(x=>x.ignored&&!x.directory).length},files.map(f=>f.bytes.buffer));
}catch(error){parentPort.postMessage({ok:false,code:/^OFFICE_[A-Z_]+$/.test(error.code||'')?error.code:'OFFICE_ZIP_INVALID'});}finally{parentPort.close();}
