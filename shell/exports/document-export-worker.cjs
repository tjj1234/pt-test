'use strict';
const {parentPort, workerData} = require('node:worker_threads');
try {
  const {document,format}=workerData;
  if(format==='xlsx'){
    const {parseCsv}=require('../attachments/csv-parser.cjs');
    const rows=parseCsv(document.csv,{maxBytes:2*1024*1024,maxRows:5000,maxColumns:100,maxCells:50000}).rows;
    const result=require('./portable-xlsx-candidate.cjs').generatePortableXlsx({sheets:[{name:'CSV 分析',cells:rows.map(row=>row.map(cell=>cell.value))}]},{maxBytes:5*1024*1024});
    const bytes=Uint8Array.from(result.buffer);parentPort.postMessage({ok:true,bytes},[bytes.buffer]);
  }else{
  const {exportDocumentCandidate} = require('./document-export-candidate.cjs');
  const {unzipSync, zipSync, strFromU8, strToU8} = require('fflate');
  const result = exportDocumentCandidate(document, {format: 'docx', maxBytes: 5 * 1024 * 1024});
  // Preserve literal whitespace in the existing generator's text runs.
  const entries = unzipSync(result.buffer);
  entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']).replace(/<w:t>/g, '<w:t xml:space="preserve">'));
  const bytes = zipSync(entries);
  parentPort.postMessage({ok: true, bytes}, [bytes.buffer]);
  }
} catch { parentPort.postMessage({ok: false}); }
finally { parentPort.close(); }
