import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {exportConversationDocx} = require('../../shell/exports/conversation-docx.cjs');
const {parseOfficeDocument} = require('../../shell/attachments/office-document-parser.cjs');
const source = () => ({title: '中文对话记录', messages: [{role: 'user', text: '编号00123\n  原始空格🙂'}, {role: 'assistant', text: '=SUM(A1:A2)\n<&>纯文本', documents: ['/private/not-embedded']} ]});
test('conversation Word export round-trips Chinese/literals and does not embed attachment contents', async () => {
  const conversation = source(), original = JSON.stringify(conversation);
  const result = await exportConversationDocx({conversation});
  assert.equal(JSON.stringify(conversation), original);
  assert.equal(result.sha256.length, 64); assert.equal(result.sourceSha256.length, 64);
  const parsed = await parseOfficeDocument({bytes: result.bytes, format: 'docx'});
  for (const value of ['中文对话记录', '编号00123', '  原始空格🙂', '=SUM(A1:A2)', '<&>纯文本', '附件及产物内容未嵌入']) assert.ok(parsed.text.includes(value), value);
  assert.equal(parsed.text.includes('/private/not-embedded'), false);
});
test('invalid XML, oversized conversations, cancelled and expired exports fail with safe errors', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportConversationDocx({conversation: source(), signal: controller.signal}), {code: 'DOCUMENT_EXPORT_CANCELLED'});
  await assert.rejects(exportConversationDocx({conversation: source(), timeoutMs: 1}), {code: 'DOCUMENT_EXPORT_TIMEOUT'});
  await assert.rejects(exportConversationDocx({conversation: {title: 'x', messages: [{role: 'assistant', text: 'private\u0000payload'}]}}), error => error.code === 'DOCUMENT_EXPORT_TEXT_INVALID' && !error.message.includes('private'));
  await assert.rejects(exportConversationDocx({conversation: {title: 'x', messages: [{role: 'assistant', text: 'x'.repeat(2 * 1024 * 1024 + 1)}]}}), {code: 'DOCUMENT_EXPORT_INPUT_LIMIT'});
  const after = await exportConversationDocx({conversation: source()}); assert.ok(after.bytes.length);
});
