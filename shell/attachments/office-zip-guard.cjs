'use strict';
const {Unzip,UnzipInflate}=require('fflate');
const fail=code=>Object.assign(new Error('Office archive rejected'),{code});
// Decode only in a bounded worker. Feed small compressed slices and discard
// decoded chunks; never extract entries to filesystem paths.
function inspectOfficeZip(bytes,{maxExpandedBytes=64*1024*1024,maxEntries=512}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>20*1024*1024||bytes.readUInt32LE(0)!==0x04034b50)throw fail('OFFICE_ZIP_INVALID');
 if(!Number.isSafeInteger(maxExpandedBytes)||maxExpandedBytes<1||maxExpandedBytes>64*1024*1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>512)throw fail('OFFICE_LIMIT_INVALID');
 const names=new Set();let expanded=0,declared=0,finished=0;
 const unzip=new Unzip(file=>{
  if(names.has(file.name)||file.name.startsWith('/')||file.name.includes('\\')||file.name.split('/').some(p=>p==='..'||p==='.')||/^[A-Za-z]:/.test(file.name))throw fail('OFFICE_ZIP_PATH_INVALID');
  names.add(file.name);if(names.size>maxEntries)throw fail('OFFICE_ZIP_ENTRY_LIMIT');
  if(/vbaProject\.bin$|(^|\/)embeddings\//i.test(file.name))throw fail('OFFICE_ACTIVE_CONTENT_UNSUPPORTED');
  if(file.compression!==0&&file.compression!==8)throw fail('OFFICE_ZIP_COMPRESSION_UNSUPPORTED');
  if(Number.isFinite(file.originalSize))declared+=file.originalSize;
  if(declared>maxExpandedBytes)throw fail('OFFICE_ZIP_EXPANSION_LIMIT');
  file.ondata=(error,chunk,final)=>{
   if(error)throw error.code?.startsWith('OFFICE_')?error:fail('OFFICE_ZIP_INVALID');expanded+=chunk.length;
   if(expanded>maxExpandedBytes)throw fail('OFFICE_ZIP_EXPANSION_LIMIT');if(final)finished++;
  };
  file.start();
 });
 unzip.register(UnzipInflate);
 try{for(let i=0;i<bytes.length;i+=1024)unzip.push(bytes.subarray(i,i+1024),i+1024>=bytes.length);}
 catch(error){if(error.code?.startsWith('OFFICE_'))throw error;throw fail('OFFICE_ZIP_INVALID');}
 if(!names.size||finished!==names.size||!names.has('[Content_Types].xml'))throw fail('OFFICE_ZIP_INVALID');
 return {names:[...names],expandedBytes:expanded};
}
module.exports={inspectOfficeZip};
