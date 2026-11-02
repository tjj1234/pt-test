import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const engine = path.resolve('shell/media/vendor/powertokens_video');
test('vendored engine stays bound to reviewed upstream and main overlay', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(engine, 'UPSTREAM.json')));
  assert.equal(metadata.originalGitBlob, '7a01e4131e8ea32dbebaa38a674533603debab24');
  assert.equal(sha(path.join(engine, 'pt_video.py')), metadata.engineSha256);
  assert.equal(sha(path.join(engine, 'LICENSE')), metadata.licenseSha256);
  assert.equal(sha(metadata.r3Patch), metadata.r3PatchSha256);
  assert.equal(sha(metadata.mainOverlay), metadata.mainOverlaySha256);
});
test('reviewed engine passes original 67 cases and 15 main-review counterexamples offline', { timeout: 20_000 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-engine-offline-'));
  try {
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', PT_VIDEO_CONFIG: path.join(directory, 'absent.json') };
    for (const [file, args, count] of [
      ['powertokens-video-engine-hardening-r3-test.py', ['--engine-path', engine], 67],
      ['ptvideo-main-engine-test.py', [], 15],
    ]) {
      const result = spawnSync('python3', ['-B', path.resolve('tests/regression', file), ...args], { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr.slice(-3000));
      assert.match(result.stderr, new RegExp('Ran ' + count + ' tests'));
      assert.match(result.stderr, /\nOK\s*$/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
