import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCsvRunArtifact } from '../../shell/runtime/csv-run-artifact.cjs';
import { openTenantArtifact } from '../../shell/runtime/artifact-open.cjs';

test('F2 Run CSV artifact is atomically published under tenant and run ownership', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-csv-artifact-'));
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  try {
    const artifact = writeCsvRunArtifact({ workspaceRoot, tenantId, runId, csv: 'a,b\r\n1,2\r\n' });
    assert.match(artifact.rel, new RegExp(`^csv-results/${runId}/[a-f0-9-]+\\.csv$`));
    const opened = openTenantArtifact({ workspaceRoot, tenantId, relativePath: artifact.rel });
    try { assert.equal(fs.readFileSync(opened.fd, 'utf8'), 'a,b\r\n1,2\r\n'); }
    finally { fs.closeSync(opened.fd); }
    assert.deepEqual(fs.readdirSync(path.join(workspaceRoot, tenantId, 'csv-results', runId)).filter((name) => name.startsWith('.pending-')), []);
    assert.throws(() => openTenantArtifact({ workspaceRoot, tenantId: '33333333-3333-4333-8333-333333333333', relativePath: artifact.rel }));
    assert.throws(() => writeCsvRunArtifact({ workspaceRoot, tenantId, runId: '../bad', csv: 'x' }), { code: 'CSV_ARTIFACT_ARGUMENT_INVALID' });
  } finally { fs.rmSync(workspaceRoot, { recursive: true, force: true }); }
});
