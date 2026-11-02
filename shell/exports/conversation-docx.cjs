'use strict';
const path = require('node:path');
const {Worker} = require('node:worker_threads');
const {createHash} = require('node:crypto');
const fail = code => Object.assign(new Error('Conversation document export could not be completed'), {code});
let active = 0;
function conversationDocument(conversation) {
  if (!conversation || typeof conversation.title !== 'string' || conversation.title.length > 500 || !Array.isArray(conversation.messages) || conversation.messages.length > 2000) throw fail('DOCUMENT_EXPORT_INPUT_LIMIT');
  const paragraphs = []; let bytes = 0;
  const add = value => {
    for (const character of value) {
      const code = character.codePointAt(0);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) throw fail('DOCUMENT_EXPORT_TEXT_INVALID');
    }
    paragraphs.push(value);
    if (paragraphs.length > 8000) throw fail('DOCUMENT_EXPORT_INPUT_LIMIT');
  };
  for (const message of conversation.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    const text = message.text == null ? '' : message.text;
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw fail('DOCUMENT_EXPORT_INPUT_LIMIT');
    bytes += Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024) throw fail('DOCUMENT_EXPORT_INPUT_LIMIT');
    add(message.role === 'user' ? '用户' : '助手');
    for (const line of text.split(/\r\n|\n|\r/)) {
      for (let offset = 0; offset < line.length || offset === 0;) {
        let end = Math.min(line.length, offset + 8000);
        if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end--;
        add(line.slice(offset, end));
        if (end === line.length) break;
        offset = end;
      }
    }
    if (message.image || message.documents?.length || message.media?.length || message.artifacts?.length) add('附件及产物内容未嵌入此导出文件，请在原对话中查看。');
  }
  const title = conversation.title.trim() || '对话记录';
  // Validate the title under the same XML rules before handing off to rendering.
  const count = paragraphs.length; add(title); paragraphs.pop();
  if (paragraphs.length !== count) throw fail('DOCUMENT_EXPORT_INPUT_LIMIT');
  return {title, sections: [{paragraphs}]};
}
function exportDocumentInWorker({document, format = 'docx', signal, timeoutMs = 10000} = {}) {
  if (signal?.aborted) return Promise.reject(fail('DOCUMENT_EXPORT_CANCELLED'));
  if (active >= 2) return Promise.reject(fail('DOCUMENT_EXPORT_BUSY'));
  if (!['docx','xlsx'].includes(format)) return Promise.reject(fail('DOCUMENT_EXPORT_FORMAT_INVALID'));
  try { if (Buffer.byteLength(JSON.stringify(document)) > 4 * 1024 * 1024) return Promise.reject(fail('DOCUMENT_EXPORT_INPUT_LIMIT')); } catch { return Promise.reject(fail('DOCUMENT_EXPORT_INPUT_LIMIT')); }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) return Promise.reject(fail('DOCUMENT_EXPORT_LIMIT_INVALID'));
  const sourceSha256 = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  return new Promise((resolve, reject) => {
    let worker; active++;
    try { worker = new Worker(path.join(__dirname, 'document-export-worker.cjs'), {workerData: {document,format}, resourceLimits: {maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4}}); }
    catch { active--; reject(fail('DOCUMENT_EXPORT_FAILED')); return; }
    let response, failure;
    const stop = code => { if (!failure) { failure = fail(code); void worker.terminate(); } };
    const cancel = () => stop('DOCUMENT_EXPORT_CANCELLED');
    signal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => stop('DOCUMENT_EXPORT_TIMEOUT'), timeoutMs);
    worker.on('message', value => { if (response) stop('DOCUMENT_EXPORT_FAILED'); else response = value; });
    worker.on('error', () => { if (!failure) failure = fail('DOCUMENT_EXPORT_FAILED'); });
    worker.on('exit', code => {
      active--; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (failure) return reject(failure);
      if (code !== 0 || !response?.ok || !(response.bytes instanceof Uint8Array) || response.bytes.length > 5 * 1024 * 1024) return reject(fail('DOCUMENT_EXPORT_FAILED'));
      const bytes = Buffer.from(response.bytes);
      resolve({bytes, sourceSha256, sha256: createHash('sha256').update(bytes).digest('hex'), mime: format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    });
    if (signal?.aborted) cancel();
  });
}
function exportConversationDocx(options = {}) {
  try {return exportDocumentInWorker({...options,format:'docx',document:conversationDocument(options.conversation)});}
  catch(error){return Promise.reject(error);}
}
function exportCsvWorkbook({csv,signal,timeoutMs} = {}) {
  if (typeof csv !== 'string' || csv.length>2*1024*1024 || Buffer.byteLength(csv)>2*1024*1024) return Promise.reject(fail('DOCUMENT_EXPORT_INPUT_LIMIT'));
  return exportDocumentInWorker({document:{csv},format:'xlsx',signal,timeoutMs});
}
module.exports = {exportConversationDocx, conversationDocument, exportCsvWorkbook};
