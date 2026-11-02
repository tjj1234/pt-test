import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDshRuntime } = require('../../shell/runtime/dsh-adapter.cjs');
test('profile rejection occurs before opening process logs on repeated startup attempts', async t => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-profile-reject-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const logs = path.join(temp, 'logs');
  const runtime = createDshRuntime({ dshHome: path.join(temp, 'home'), settingsTemplate: path.join(temp, 'missing-settings'), persistentRunner: path.resolve('shell/persistent-runner.mjs'), tmpDir: logs });
  t.after(() => runtime.close());
  for (let i = 0; i < 3; i++) {
    const result = await runtime.run({ tenantId: 'rejected-profile', userId: 'user', sessionKey: 'session', workspace: temp, question: 'never sent' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROFILE_SETTINGS_FAILED');
    assert.equal(fs.existsSync(logs), false, 'no process log files or descriptors created');
  }
});
