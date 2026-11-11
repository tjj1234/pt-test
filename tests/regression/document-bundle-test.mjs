import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{zipSync,strToU8}=createRequire(new URL('../../shell/package.json',import.meta.url))('fflate'),{parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs'),{exportDocumentInWorker}=require('../../shell/exports/conversation-docx.cjs'),{buildSourceIndex}=require('../../shell/attachments/source-retrieval-candidate.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex'),bundle=entries=>Buffer.from(zipSync(entries));
test('ZIP documents retain archive and member fingerprints and inner document locators',async()=>{
 const docx=await exportDocumentInWorker({document:{title:'Bundle fixture',sections:[{paragraphs:['中文 member witness']}]},format:'docx'}),text=strToU8('archive text witness\nsecond line'),bytes=bundle({'folder/note.txt':text,'table.csv':strToU8('name,value\none,7\n'),'word.docx':docx.bytes});
 const result=await parseOfficeDocument({bytes,format:'zip'});assert.equal(result.sourceSha256,sha(bytes));assert.match(result.text,/中文 member witness/);assert.match(result.text,/archive text witness/);
 const block=result.blocks.find(b=>b.text==='archive text witness');assert.equal(block.locator.member,'folder/note.txt');assert.equal(block.locator.memberSha256,sha(text));
 const index=buildSourceIndex({tenantId:'fixture',documentId:'bundle.zip',sourceSha256:sha(bytes),format:'zip',blocks:result.blocks});assert.equal(index.blocks[0].locator.memberSha256,sha(text));assert.equal(index.blocks[0].locator.inner.blockIndex,1);
});
for(const [name,bytes,expected]of [
 ['traversal',bundle({'../escape.txt':strToU8('x')}),'OFFICE_ZIP_PATH_INVALID'],
 ['executable',bundle({'run.exe':strToU8('MZ')}),'OFFICE_ACTIVE_CONTENT_UNSUPPORTED'],
 ['nested archive',bundle({'inner.zip':strToU8('PK')}),'OFFICE_ZIP_MEMBER_UNSUPPORTED'],
 ['expansion',bundle({'large.txt':new Uint8Array(11*1024*1024)}),'OFFICE_ZIP_EXPANSION_LIMIT'],
 ['too many members',bundle(Object.fromEntries(Array.from({length:65},(_,i)=>['f'+i+'.txt',strToU8('x')]))),'OFFICE_ZIP_ENTRY_LIMIT']
])test('ZIP rejects '+name,()=>assert.rejects(parseOfficeDocument({bytes,format:'zip'}),e=>e.code===expected));
test('ZIP rejects encryption, symlink metadata and CRC mismatch; cancellation stops workers',async()=>{
 const source=bundle({'note.txt':strToU8('hello')});let central=source.indexOf(Buffer.from([0x50,0x4b,1,2]));
 const encrypted=Buffer.from(source);encrypted.writeUInt16LE(encrypted.readUInt16LE(6)|1,6);encrypted.writeUInt16LE(encrypted.readUInt16LE(central+8)|1,central+8);await assert.rejects(parseOfficeDocument({bytes:encrypted,format:'zip'}),e=>e.code==='OFFICE_ENCRYPTED');
 const link=Buffer.from(source);link.writeUInt32LE((0xa1ff<<16)>>>0,central+38);await assert.rejects(parseOfficeDocument({bytes:link,format:'zip'}),e=>e.code==='OFFICE_ZIP_LINK_UNSUPPORTED');
 const crc=Buffer.from(source);crc.writeUInt32LE((crc.readUInt32LE(central+16)^1)>>>0,central+16);await assert.rejects(parseOfficeDocument({bytes:crc,format:'zip'}),e=>e.code==='OFFICE_ZIP_CHECKSUM_INVALID');
 const abort=new AbortController();abort.abort();await assert.rejects(parseOfficeDocument({bytes:source,format:'zip',signal:abort.signal}),e=>e.code==='OFFICE_CANCELLED');
 const during=new AbortController(),pending=parseOfficeDocument({bytes:bundle({'data.txt':new Uint8Array(8*1024*1024).fill(65)}),format:'zip',signal:during.signal});setTimeout(()=>during.abort(),1);await assert.rejects(pending,e=>e.code==='OFFICE_CANCELLED');
 assert.match((await parseOfficeDocument({bytes:source,format:'zip'})).text,/hello/);
});
