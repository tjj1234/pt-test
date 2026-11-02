import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openTenantArtifact } = require('../../shell/runtime/artifact-open.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-openat-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const tenantA = path.join(workspaceRoot, 'tenant-a');
  const tenantB = path.join(workspaceRoot, 'tenant-b');
  fs.mkdirSync(tenantA, { recursive: true });
  fs.mkdirSync(tenantB, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, workspaceRoot, tenantA, tenantB };
}

function readOpened(result) {
  try { return fs.readFileSync(result.fd, 'utf8'); }
  finally { fs.closeSync(result.fd); }
}

test('openat pins every directory and returns only a single-link regular file', (t) => {
  const { workspaceRoot, tenantA } = fixture(t);
  fs.writeFileSync(path.join(tenantA, 'report.pdf'), 'tenant A report');
  const opened = openTenantArtifact({ workspaceRoot, tenantId: 'tenant-a', relativePath: 'report.pdf' });
  assert.equal(opened.stat.isFile(), true);
  assert.equal(opened.stat.nlink, 1);
  assert.equal(readOpened(opened), 'tenant A report');
});

test('openat rejects final/intermediate symlinks, tenant-root symlinks, and hard links', (t) => {
  const { workspaceRoot, tenantA, tenantB } = fixture(t);
  const privateFile = path.join(tenantB, 'private.pdf');
  fs.writeFileSync(privateFile, 'tenant B secret');
  fs.symlinkSync(privateFile, path.join(tenantA, 'leaf.pdf'));
  fs.symlinkSync(tenantB, path.join(tenantA, 'directory-link'));
  fs.mkdirSync(path.join(tenantA, 'hard'), { recursive: true });
  fs.linkSync(privateFile, path.join(tenantA, 'hard', 'copy.pdf'));
  for (const relativePath of ['leaf.pdf', 'directory-link/private.pdf', 'hard/copy.pdf']) {
    assert.throws(() => openTenantArtifact({ workspaceRoot, tenantId: 'tenant-a', relativePath }));
  }

  const otherRoot = path.join(workspaceRoot, 'tenant-c');
  fs.symlinkSync(tenantB, otherRoot);
  assert.throws(() => openTenantArtifact({ workspaceRoot, tenantId: 'tenant-c', relativePath: 'private.pdf' }));
});

test('directory rename and replacement after open cannot redirect the leaf to another tenant', (t) => {
  const { workspaceRoot, tenantA, tenantB } = fixture(t);
  const reports = path.join(tenantA, 'reports');
  fs.mkdirSync(reports);
  fs.writeFileSync(path.join(reports, 'result.pdf'), 'tenant A pinned inode');
  fs.writeFileSync(path.join(tenantB, 'result.pdf'), 'tenant B canary');

  let swapped = false;
  const opened = openTenantArtifact({
    workspaceRoot,
    tenantId: 'tenant-a',
    relativePath: 'reports/result.pdf',
    onDirectoryOpened: ({ index }) => {
      if (index !== 0 || swapped) return;
      fs.renameSync(reports, path.join(tenantA, 'reports-held'));
      fs.symlinkSync(tenantB, reports);
      swapped = true;
    },
  });
  assert.equal(swapped, true);
  assert.equal(readOpened(opened), 'tenant A pinned inode');
});

test('openat helper rejects malformed tenant and relative path components', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'unused');
  for (const [tenantId, relativePath] of [['../tenant-b', 'x.pdf'], ['tenant-a', '../private.pdf'], ['tenant-a', 'a//b.pdf']]) {
    assert.throws(() => openTenantArtifact({ workspaceRoot, tenantId, relativePath }), { code: 'ARTIFACT_PATH_INVALID' });
  }
});
