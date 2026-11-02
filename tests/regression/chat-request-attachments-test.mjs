import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  normalizeChatRequest,
  captureDurableChatAttachments,
  readVerifiedChatAttachmentBytes,
  verifyDurableChatAttachments,
  isReplayableChatRequest,
  validateStoredChatRequest,
} = require('../../shell/tasks/chat-request.cjs');

const tenantId = '12345678-1234-4234-8234-123456789abc';
const identity = { userId: 'fixture-user', tenantId };

test('durable attachment snapshots bind tenant-local regular file bytes and fail closed', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'northstar-chat-attachments-'));
  const uploadsRoot = path.join(temp, 'uploads');
  const tenantRoot = path.join(uploadsRoot, tenantId);
  await fs.mkdir(tenantRoot, { recursive: true });
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const image = `/uploads/${tenantId}/0123456789abcdef0123456789abcdef.png`;
  const doc = `/uploads/${tenantId}/abcdef0123456789abcdef0123456789.txt`;
  const video = `/uploads/${tenantId}/00112233445566778899aabbccddeeff.mp4`;
  await fs.writeFile(path.join(tenantRoot, path.basename(image)), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(tenantRoot, path.basename(doc)), 'durable text fixture');
  await fs.writeFile(path.join(tenantRoot, path.basename(video)), 'media fixture');

  const plain = normalizeChatRequest({ message: 'text only' }, tenantId);
  assert.equal(plain.schemaVersion, 1);
  assert.equal(isReplayableChatRequest(plain, tenantId), true, 'text-only v1 remains replayable');
  assert.equal((await captureDurableChatAttachments(plain, { uploadsRoot, identity })).schemaVersion, 1);

  const input = normalizeChatRequest({ message: 'inspect these', image, documents: [doc], media: [{ type: 'video', url: video }] }, tenantId);
  const captured = await captureDurableChatAttachments(input, { uploadsRoot, identity });
  assert.equal(captured.schemaVersion, 2);
  assert.deepEqual(captured.attachmentEvidence.map((entry) => entry.ref), [image, doc, video]);
  assert.equal(isReplayableChatRequest(captured, tenantId), true);
  assert.deepEqual(await verifyDurableChatAttachments(captured, { uploadsRoot, identity }), captured);
  await assert.rejects(readVerifiedChatAttachmentBytes(image, undefined, { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_EVIDENCE_MISSING' });
  assert.deepEqual(await readVerifiedChatAttachmentBytes(image, { ref: image, sha256: captured.attachmentEvidence[0].sha256, size: captured.attachmentEvidence[0].size }, { uploadsRoot, identity }), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual(validateStoredChatRequest(captured, tenantId), captured);
  assert.equal(isReplayableChatRequest(input, tenantId), false, 'legacy attachment envelopes fail closed');
  await assert.rejects(verifyDurableChatAttachments(input, { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_EVIDENCE_MISSING' });

  await fs.writeFile(path.join(tenantRoot, path.basename(doc)), 'replacement contents');
  await assert.rejects(verifyDurableChatAttachments(captured, { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_CHANGED' });

  const missing = normalizeChatRequest({ message: 'missing', image: `/uploads/${tenantId}/ffffffffffffffffffffffffffffffff.png` }, tenantId);
  await assert.rejects(captureDurableChatAttachments(missing, { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_UNAVAILABLE' });

  const symlinkName = '11111111111111111111111111111111.txt';
  const outside = path.join(temp, 'outside.txt');
  await fs.writeFile(outside, 'outside tenant root');
  await fs.symlink(outside, path.join(tenantRoot, symlinkName));
  const symlinkRequest = normalizeChatRequest({ message: 'symlink', documents: [`/uploads/${tenantId}/${symlinkName}`] }, tenantId);
  await assert.rejects(captureDurableChatAttachments(symlinkRequest, { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_UNAVAILABLE' });

  assert.throws(() => normalizeChatRequest({ message: 'cross tenant', image: `/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${path.basename(image)}` }, tenantId), { code: 'CHAT_REQUEST_INVALID' });
  assert.throws(() => normalizeChatRequest({ message: 'dot segment', documents: [`/uploads/${tenantId}/..`] }, tenantId), { code: 'CHAT_REQUEST_INVALID' });
  await assert.rejects(captureDurableChatAttachments(input, { uploadsRoot, identity: { userId: 'fixture-user', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), { code: 'CHAT_REQUEST_INVALID' });
});

test('confirmed CSV selection is canonical and bound to captured attachment bytes', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'northstar-csv-selection-'));
  const uploadsRoot = path.join(temp, 'uploads');
  const tenantRoot = path.join(uploadsRoot, tenantId);
  await fs.mkdir(tenantRoot, { recursive: true });
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const ref = `/uploads/${tenantId}/a.csv`;
  const bytes = Buffer.from('amount\n1\n2\n');
  await fs.writeFile(path.join(tenantRoot, 'a.csv'), bytes);
  const selection = { sourceRef: ref, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    headerRow: 1, startRow: 2, column: 1 };
  const request = normalizeChatRequest({ message: 'sum selected column', documents: [ref], csvSelections: [selection] }, tenantId);
  const captured = await captureDurableChatAttachments(request, { uploadsRoot, identity });
  assert.deepEqual(captured.body.csvSelections, [selection]);
  assert.equal(isReplayableChatRequest(captured, tenantId), true);
  assert.throws(() => normalizeChatRequest({ message: 'x', documents: [ref], csvSelections: [{ ...selection, startRow: 1 }] }, tenantId), { code: 'CHAT_REQUEST_INVALID' });
  await assert.rejects(captureDurableChatAttachments(normalizeChatRequest({ message: 'x', documents: [ref], csvSelections: [{ ...selection, sourceSha256: '0'.repeat(64) }] }, tenantId), { uploadsRoot, identity }), { code: 'CHAT_ATTACHMENT_CHANGED' });
});
