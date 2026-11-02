import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('openat rejects a FIFO artifact promptly instead of blocking before the regular-file check', { timeout: 5000 }, t => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    t.skip('openTenantArtifact only supports Linux and Darwin');
    return;
  }
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-t10-fifo-'));
  const workspaceRoot = path.join(temp, 'workspaces');
  const tenant = path.join(workspaceRoot, 'tenant-a');
  fs.mkdirSync(tenant, { recursive: true });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const fifo = path.join(tenant, 'report.pdf');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr || 'mkfifo failed');

  const helperPath = path.join(root, 'shell/runtime/artifact-open.cjs');
  const probe = 'const { openTenantArtifact } = require(' + JSON.stringify(helperPath) + '); try { openTenantArtifact({ workspaceRoot: ' + JSON.stringify(workspaceRoot) + ', tenantId: "tenant-a", relativePath: "report.pdf" }); process.exit(2); } catch (error) { console.log(error.code || error.message); process.exit(error.code === "ARTIFACT_NOT_REGULAR_FILE" ? 0 : 3); }';
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: root,
    encoding: 'utf8',
    timeout: 800,
  });

  assert.equal(result.error?.code || null, null,
    'opening a FIFO blocked before fstat could reject it; child error=' + (result.error?.code || 'none') + ', stdout=' + (result.stdout || '') + ', stderr=' + (result.stderr || ''));
  assert.equal(result.status, 0, 'expected ARTIFACT_NOT_REGULAR_FILE, got status=' + result.status + ', stdout=' + result.stdout + ', stderr=' + result.stderr);
  assert.match(result.stdout, /ARTIFACT_NOT_REGULAR_FILE/);
});
