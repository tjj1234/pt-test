import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openTenantArtifact } = require('../../shell/runtime/artifact-open.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-t10-leaf-race-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const tenantA = path.join(workspaceRoot, 'tenant-a');
  const tenantB = path.join(workspaceRoot, 'tenant-b');
  const reports = path.join(tenantA, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(tenantB, { recursive: true });
  fs.writeFileSync(path.join(reports, 'result.pdf'), 'tenant A original');
  fs.writeFileSync(path.join(tenantB, 'private.pdf'), 'tenant B private');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspaceRoot, reports, privateFile: path.join(tenantB, 'private.pdf') };
}

test('openat rejects a leaf replaced with a symlink after its parent directory is pinned', (t) => {
  const f = fixture(t);
  let swapped = false;
  assert.throws(() => openTenantArtifact({
    workspaceRoot: f.workspaceRoot,
    tenantId: 'tenant-a',
    relativePath: 'reports/result.pdf',
    onDirectoryOpened: ({ index }) => {
      if (index !== 0 || swapped) return;
      fs.unlinkSync(path.join(f.reports, 'result.pdf'));
      fs.symlinkSync(f.privateFile, path.join(f.reports, 'result.pdf'));
      swapped = true;
    },
  }), { code: 'ARTIFACT_OPEN_FAILED' });
  assert.equal(swapped, true);
});

test('openat rejects a leaf replaced with a hard link after its parent directory is pinned', (t) => {
  const f = fixture(t);
  let swapped = false;
  assert.throws(() => openTenantArtifact({
    workspaceRoot: f.workspaceRoot,
    tenantId: 'tenant-a',
    relativePath: 'reports/result.pdf',
    onDirectoryOpened: ({ index }) => {
      if (index !== 0 || swapped) return;
      fs.unlinkSync(path.join(f.reports, 'result.pdf'));
      fs.linkSync(f.privateFile, path.join(f.reports, 'result.pdf'));
      swapped = true;
    },
  }), { code: 'ARTIFACT_HARDLINK_REJECTED' });
  assert.equal(swapped, true);
});
