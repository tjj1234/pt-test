'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs');
const fixture=path.resolve('tests/fixtures/legacy-r34'),sha=x=>createHash('sha256').update(x).digest('hex');
(async()=>{
 for(const [name,format,witness]of [['SampleDoc.doc','doc',/I am a test document/],['Simple.xls','xls',/replaceMe/],['basic_test_ppt_file.ppt','ppt',/This is a test title/]]){
  const bytes=fs.readFileSync(path.join(fixture,name)),parsed=await parseOfficeDocument({bytes,format});assert.match(parsed.text,witness);assert.equal(parsed.sourceSha256,sha(bytes));assert(parsed.blocks.length>0);assert(!parsed.blocks.some(b=>b.locator.page));console.log('LEGACY_REAL_PARSE_PASS',format,parsed.blocks.length);
 }
 for(const name of ['SimpleMacro.doc','SimpleMacro.xls','WithMacros.ppt'])await assert.rejects(parseOfficeDocument({bytes:fs.readFileSync(path.join(fixture,name)),format:path.extname(name).slice(1)}),e=>e.code==='OFFICE_ACTIVE_CONTENT_UNSUPPORTED');console.log('LEGACY_MACRO_REJECTION_PASS');
 for(const name of ['PasswordProtected.doc','Password_Protected-hello.ppt'])await assert.rejects(parseOfficeDocument({bytes:fs.readFileSync(path.join(fixture,name)),format:path.extname(name).slice(1)}),e=>e.code==='OFFICE_ENCRYPTED');console.log('LEGACY_ENCRYPTION_REJECTION_PASS');
 await assert.rejects(parseOfficeDocument({bytes:fs.readFileSync(path.join(fixture,'Simple.xls')),format:'doc'}),e=>e.code==='OFFICE_FORMAT_MISMATCH');
 const corrupt=Buffer.alloc(512);Buffer.from('d0cf11e0a1b11ae1','hex').copy(corrupt);await assert.rejects(parseOfficeDocument({bytes:corrupt,format:'doc'}));console.log('LEGACY_CORRUPT_AND_MISMATCH_PASS');
 const controller=new AbortController(),cp=require('node:child_process'),{syncBuiltinESMExports}=require('node:module'),original=cp.spawn,pids=[];
 cp.spawn=function(...args){const child=original(...args);pids.push(child.pid);queueMicrotask(()=>controller.abort());return child;};syncBuiltinESMExports();
 try{await assert.rejects(parseOfficeDocument({bytes:fs.readFileSync(path.join(fixture,'SampleDoc.doc')),format:'doc',signal:controller.signal}),e=>e.code==='OFFICE_CANCELLED');assert(pids.length>0);for(const pid of pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');}
 finally{cp.spawn=original;syncBuiltinESMExports();}console.log('LEGACY_ACTUAL_SPAWN_CANCEL_AND_JOIN_PASS');
 const {zipSync,strToU8}=require('../../shell/node_modules/fflate'),bytes=Buffer.from(zipSync({'note.txt':strToU8('bundle witness'),'legacy.xls':fs.readFileSync(path.join(fixture,'Simple.xls'))}));
 const parsed=await parseOfficeDocument({bytes,format:'zip'});assert.match(parsed.text,/bundle witness/);assert.match(parsed.text,/replaceMe/);assert.equal(parsed.sourceSha256,sha(bytes));
 const {buildSourceIndex}=require('../../shell/attachments/source-retrieval-candidate.cjs');const index=buildSourceIndex({tenantId:'fixture',documentId:'bundle.zip',sourceSha256:sha(bytes),format:'zip',blocks:parsed.blocks});assert(index.blocks.some(b=>b.locator.member==='legacy.xls'&&b.locator.inner.kind==='legacy-sheet-export-cell'));console.log('LEGACY_ZIP_MEMBER_PROVENANCE_PASS');
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
