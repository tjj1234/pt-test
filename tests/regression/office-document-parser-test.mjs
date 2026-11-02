import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),shellRequire=createRequire(new URL('../../shell/package.json',import.meta.url));
const {parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs');
const {inspectOfficeZip}=require('../../shell/attachments/office-zip-guard.cjs');
const {zipSync,strToU8}=shellRequire('fflate');
// A standalone OOXML fixture keeps archive tests independent of export candidates.
const document=()=>Buffer.from(zipSync({
 '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
 '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
 'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文资料，编号00123。</w:t></w:r></w:p><w:p><w:r><w:t>=SUM(A1:A2) 作为文本保留。</w:t></w:r></w:p></w:body></w:document>'),
}));
test('real DOCX parser preserves Chinese and source hash without evaluating document text',async()=>{
 const bytes=document(),r=await parseOfficeDocument({bytes,format:'docx'});
 assert.match(r.text,/中文资料，编号00123/);assert.match(r.text,/=SUM\(A1:A2\)/);assert.equal(r.sourceBytes,bytes.length);
 assert.equal(r.sourceSha256.length,64);assert.equal(r.locatorKind,'extracted-text-block-not-page');
});
test('ZIP guard refuses path traversal, excessive expansion and active embeds',()=>{
 for(const name of ['../escape','word/vbaProject.bin','word/embeddings/object.bin']){
  const bytes=Buffer.from(zipSync({'[Content_Types].xml':strToU8('types'),[name]:strToU8('payload')}));
  assert.throws(()=>inspectOfficeZip(bytes),e=>e.code.startsWith('OFFICE_'));
 }
 const bytes=Buffer.from(zipSync({'[Content_Types].xml':strToU8('types'),'word/document.xml':strToU8('x'.repeat(100000))}));
 assert.throws(()=>inspectOfficeZip(bytes,{maxExpandedBytes:1000}),{code:'OFFICE_ZIP_EXPANSION_LIMIT'});
 // Lie in the local uncompressed-size field; actual decoded bytes must still
 // hit the measured budget before Mammoth gets the archive.
 const forged=Buffer.from(bytes),second=forged.indexOf(Buffer.from([0x50,0x4b,0x03,0x04]),4);
 assert.ok(second>0);forged.writeUInt32LE(1,second+22);
 assert.throws(()=>inspectOfficeZip(forged,{maxExpandedBytes:1000}),{code:'OFFICE_ZIP_EXPANSION_LIMIT'});
});
test('global parser capacity rejects excess work and releases slots after exit',async()=>{
 const bytes=document(),a=parseOfficeDocument({bytes,format:'docx'}),b=parseOfficeDocument({bytes,format:'docx'});
 try{await assert.rejects(parseOfficeDocument({bytes,format:'docx'}),{code:'OFFICE_PARSER_BUSY'});}finally{await Promise.all([a,b]);}
 assert.equal((await parseOfficeDocument({bytes,format:'docx'})).format,'docx');
});
test('deadline and cancellation settle only after the worker exits with safe errors',async()=>{
 const bytes=document(),controller=new AbortController();controller.abort();
 await assert.rejects(parseOfficeDocument({bytes,format:'docx',signal:controller.signal}),{code:'OFFICE_CANCELLED'});
 await assert.rejects(parseOfficeDocument({bytes,format:'docx',timeoutMs:1}),{code:'OFFICE_TIMEOUT'});
 await assert.rejects(parseOfficeDocument({bytes:Buffer.from('private sentinel'),format:'docx'}),e=>!e.message.includes('sentinel')&&e.code.startsWith('OFFICE_'));
 await assert.rejects(parseOfficeDocument({bytes,format:'doc'}),{code:'OFFICE_FORMAT_UNSUPPORTED'});
});
