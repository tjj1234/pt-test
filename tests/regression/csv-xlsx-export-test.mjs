import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {exportCsvWorkbook}=require('../../shell/exports/conversation-docx.cjs');
const {parseOfficeDocument}=require('../../shell/attachments/office-document-parser.cjs');
test('CSV analysis workbook uses bounded worker, preserves literal data and cancels safely',async()=>{
 const result=await exportCsvWorkbook({csv:'label,value\n中文00123,3\nformula,=1+1\n'});
 const parsed=await parseOfficeDocument({bytes:result.bytes,format:'xlsx'});
 assert.ok(parsed.text.includes('中文00123'));assert.ok(parsed.text.includes('3'));assert.ok(parsed.text.includes("'=1+1"));
 assert.equal(result.sha256.length,64);assert.match(result.mime,/spreadsheetml.sheet/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(exportCsvWorkbook({csv:'a\n1\n',signal:controller.signal}),{code:'DOCUMENT_EXPORT_CANCELLED'});
 await assert.rejects(exportCsvWorkbook({csv:'x'.repeat(2*1024*1024+1)}),{code:'DOCUMENT_EXPORT_INPUT_LIMIT'});
 await assert.rejects(exportCsvWorkbook({csv:'"unterminated'}),{code:'DOCUMENT_EXPORT_FAILED'});
});
