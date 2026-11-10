import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';import path from 'node:path';
const require=createRequire(import.meta.url),sr=createRequire(new URL('../../shell/package.json',import.meta.url));
const {parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs');
const {exportConversationPdf}=require('../../shell/exports/conversation-docx.cjs');
const {buildSourceIndex}=require('../../shell/attachments/source-retrieval-candidate.cjs');
async function fixture({pages=2,blank=false}={}){
 const PDF=sr('pdfkit'),doc=new PDF({compress:true}),parts=[];
 const result=new Promise((resolve,reject)=>{doc.on('data',b=>parts.push(b));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);});
 for(let i=1;i<=pages;i++){if(i>1)doc.addPage();if(!blank)doc.text('Original page '+i+' - invoice 00123');}doc.end();return result;
}
test('real multipage PDF preserves page numbers, content hash and searchable citation locator',async()=>{
 const bytes=await fixture(),parsed=await parseOfficeDocument({bytes,format:'pdf'});
 assert.equal(parsed.pageCount,2);assert.equal(parsed.sourceBytes,bytes.length);assert.match(parsed.blocks[1].text,/Original page 2/);
 assert.deepEqual(parsed.blocks[1].locator,{kind:'pdf-page',page:2});
 const index=buildSourceIndex({tenantId:'tenant-pdf',documentId:'invoice.pdf',sourceSha256:parsed.sourceSha256,version:1,format:'pdf',blocks:parsed.blocks});
 assert.deepEqual(index.blocks[1].locator,{kind:'pdf-page',page:2});assert.equal(index.locatorKind,'pdf-page');
});
test('Chinese PDF export embeds a real subset font and round-trips literal content',async()=>{
 const result=await exportConversationPdf({conversation:{title:'中文资料验收',messages:[{role:'user',text:'编号00123，预算与费用。'},{role:'assistant',text:'=SUM(A1:A2) <&> 保留原文。'}]}});
 assert.equal(result.mime,'application/pdf');assert.match(result.bytes.subarray(0,8).toString(),/^%PDF-/);assert.ok(result.bytes.length<1024*1024);
 const parsed=await parseOfficeDocument({bytes:result.bytes,format:'pdf'});
 for(const text of ['中文资料验收','编号00123','预算与费用','=SUM(A1:A2)','<&>'])assert.ok(parsed.text.includes(text),text);
 assert.match(result.bytes.toString('latin1'),/\/FontFile3/);
});
test('malformed, excessive-page, unavailable OCR, timed out and cancelled PDFs fail closed',async()=>{
 await assert.rejects(parseOfficeDocument({bytes:Buffer.from('private payload'),format:'pdf'}),e=>e.code==='OFFICE_FORMAT_MISMATCH'&&!e.message.includes('private'));
 await assert.rejects(parseOfficeDocument({bytes:await fixture({pages:201}),format:'pdf'}),{code:'OFFICE_PAGE_LIMIT'});
 if(process.platform==='linux'&&process.env.PT_NATIVE_MEDIA_RUNTIME){const blank=await parseOfficeDocument({bytes:await fixture({blank:true}),format:'pdf'});assert.equal(blank.ocrPageCount,2);assert.equal(blank.text.trim(),'');}
 else await assert.rejects(parseOfficeDocument({bytes:await fixture({blank:true}),format:'pdf'}),{code:'OFFICE_PDF_OCR_UNAVAILABLE'});
 const bytes=await fixture();await assert.rejects(parseOfficeDocument({bytes,format:'pdf',timeoutMs:1}),{code:'OFFICE_TIMEOUT'});
 const controller=new AbortController(),pending=parseOfficeDocument({bytes,format:'pdf',signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'OFFICE_CANCELLED'});
 assert.equal((await parseOfficeDocument({bytes,format:'pdf'})).pageCount,2);
});
test('unsupported output glyphs fail instead of silently losing source text',async()=>{
 await assert.rejects(exportConversationPdf({conversation:{title:'test',messages:[{role:'user',text:'unsupported \u{1FAE0}'}]}}),{code:'DOCUMENT_EXPORT_FAILED'});
});
test('real scanned PDF page uses local Chinese OCR and retains physical page and original hash',{skip:!process.env.R34_MEDIA_PROOF_ROOT},async()=>{
 const PDF=sr('pdfkit'),doc=new PDF(),parts=[];
 const bytes=new Promise((resolve,reject)=>{doc.on('data',b=>parts.push(b));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);});
 doc.text('Original physical page 1');doc.addPage().image(fs.readFileSync(path.join(process.env.R34_MEDIA_PROOF_ROOT,'ocr-proof.png')),30,50,{width:540});doc.end();
 const parsed=await parseOfficeDocument({bytes:await bytes,format:'pdf'});
 assert.equal(parsed.pageCount,2);assert.equal(parsed.ocrPageCount,1);assert.match(parsed.blocks[1].text,/12345/);assert.match(parsed.blocks[1].text,/中文/);
 assert.deepEqual(parsed.blocks[1].locator,{kind:'pdf-page',page:2,method:'ocr'});
 const index=buildSourceIndex({tenantId:'tenant-pdf',documentId:'scanned.pdf',sourceSha256:parsed.sourceSha256,version:1,format:'pdf',blocks:parsed.blocks});
 assert.equal(index.blocks[1].locator.page,2);assert.equal(index.sourceSha256,parsed.sourceSha256);
});
