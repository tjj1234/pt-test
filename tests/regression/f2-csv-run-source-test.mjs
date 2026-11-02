import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCsvRunSource } from '../../shell/attachments/csv-run-source.cjs';

test('F2 Run CSV source is bound to tenant, captured digest and current bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-csv-run-'));
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const otherTenant = '22222222-2222-4222-8222-222222222222';
  const ref = `/uploads/${tenantId}/sample.csv`;
  const bytes = Buffer.from('value\n0\n2\n');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const attachmentEvidence = [{ ref, sha256: digest, size: bytes.length }];
  try {
    fs.mkdirSync(path.join(root, tenantId));
    fs.mkdirSync(path.join(root, otherTenant));
    fs.writeFileSync(path.join(root, tenantId, 'sample.csv'), bytes);
    const base = { uploadsRoot: root, identity: { userId: 'user-a', tenantId }, ref, attachmentEvidence };
    const source = await loadCsvRunSource(base);
    assert.equal(source.sha256, digest);
    assert.equal(source.rows[1][0].value, '0');
    await assert.rejects(loadCsvRunSource({ ...base, identity: { userId: 'user-a', tenantId: otherTenant } }), { code: 'CHAT_ATTACHMENT_SCOPE_INVALID' });
    await assert.rejects(loadCsvRunSource({ ...base, attachmentEvidence: [] }), { code: 'CSV_SOURCE_SNAPSHOT_REQUIRED' });
    fs.writeFileSync(path.join(root, tenantId, 'sample.csv'), Buffer.from('value\n0\n3\n'));
    await assert.rejects(loadCsvRunSource(base), { code: 'CHAT_ATTACHMENT_CHANGED' });
    fs.unlinkSync(path.join(root, tenantId, 'sample.csv'));
    fs.symlinkSync(path.join(root, otherTenant, 'secret.csv'), path.join(root, tenantId, 'sample.csv'));
    await assert.rejects(loadCsvRunSource(base), { code: 'CHAT_ATTACHMENT_UNAVAILABLE' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
