import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCsvRunHandler } from '../../shell/tasks/csv-run-handler.cjs';
import { collectArtifacts } from '../../shell/runtime/artifacts.cjs';

test('F2 parent Run accepts only current captured CSV and explicit selector', async () => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-run-handler-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-run-workspace-'));
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const sourceRef = `/uploads/${tenantId}/sample.csv`;
  const bytes = Buffer.from('amount\n0\n2\n2\n');
  const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    fs.mkdirSync(path.join(uploadsRoot, tenantId));
    fs.writeFileSync(path.join(uploadsRoot, tenantId, 'sample.csv'), bytes);
    const emitted = [];
    const handler = createCsvRunHandler({ uploadsRoot, workspaceRoot, runId, identity: { userId: 'user-a', tenantId },
      documentRefs: [sourceRef], attachmentEvidence: [{ ref: sourceRef, sha256: sourceSha256, size: bytes.length }],
      confirmedSelections: [{ sourceRef, sourceSha256, headerRow: 1, startRow: 2, column: 1 }],
      emit: async (...items) => emitted.push(items),
    });
    const args = { sourceRef, sourceSha256, operation: 'sum', column: 1, startRow: 2 };
    const result = await handler.handle({ args });
    assert.equal(result.result, '4');
    assert.equal(result.valueCount, 3);
    assert.deepEqual(result.evidence.sources.map((cell) => cell.row), [2, 3, 4]);
    assert.match(result.artifact.rel, new RegExp(`^csv-results/${runId}/`));
    assert.equal(emitted[0][0], 'artifact');
    assert.match(fs.readFileSync(path.join(workspaceRoot, tenantId, result.artifact.rel), 'utf8'), /summary/);
    assert.ok(collectArtifacts(path.join(workspaceRoot, tenantId), 0).some((item) => item.rel === result.artifact.rel));
    await assert.rejects(handler.handle({ args: { ...args, sourceSha256: 'a'.repeat(64) } }), { code: 'CSV_SELECTION_NOT_CONFIRMED' });
    await assert.rejects(handler.handle({ args: { ...args, sourceRef: `/uploads/${tenantId}/other.csv` } }), { code: 'CSV_SOURCE_NOT_CURRENT' });
    await assert.rejects(handler.handle({ args: { ...args, startRow: 1 } }), { code: 'CSV_SELECTION_NOT_CONFIRMED' });
    const empty = createCsvRunHandler({ uploadsRoot, workspaceRoot, runId, identity: { userId: 'user-a', tenantId }, documentRefs: [], attachmentEvidence: [] });
    await assert.rejects(empty.handle({ args }), { code: 'CSV_DOCUMENT_REQUIRED' });
  } finally {
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
