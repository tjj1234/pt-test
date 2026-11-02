'use strict';
const {parentPort, workerData} = require('node:worker_threads');
try {
  const {exportDocumentCandidate} = require('./document-export-candidate.cjs');
  const {unzipSync, zipSync, strFromU8, strToU8} = require('fflate');
  const result = exportDocumentCandidate(workerData, {format: 'docx', maxBytes: 5 * 1024 * 1024});
  // Preserve literal whitespace in the existing generator's text runs.
  const entries = unzipSync(result.buffer);
  entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']).replace(/<w:t>/g, '<w:t xml:space="preserve">'));
  const bytes = zipSync(entries);
  parentPort.postMessage({ok: true, bytes}, [bytes.buffer]);
} catch { parentPort.postMessage({ok: false}); }
finally { parentPort.close(); }
