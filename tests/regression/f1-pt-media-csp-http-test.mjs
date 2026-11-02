import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ptAssetHost = 'https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev';

function directive(policy, name) {
  const part = policy.split(';').map(value => value.trim()).find(value => value.startsWith(name + ' '));
  return part ? part.slice(name.length + 1).split(/\s+/) : [];
}

test('isolated Northstar HTTP response permits the verified PT image result host in image and download CSP', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-f1-media-csp-'));
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let child;
  let output = '';
  try {
    child = spawn(process.execPath, ['shell/server.cjs', '--port', String(port)], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        PT_DB_DIR: path.join(temp, 'db'),
        PT_MASTER_KEY_FILE: path.join(temp, 'key'),
        PT_LOG_DIR: path.join(temp, 'logs'),
        PT_SHELL_PORT: String(port),
        PT_LISTEN_HOST: '127.0.0.1',
        PT_KEY_LIVE_VERIFY: '0',
        PT_CHAT_DRYRUN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let response;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response, output.slice(-2000));
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, 'main page response must have CSP');
    assert.ok(directive(csp, 'img-src').includes(ptAssetHost), 'generated image must be visible in chat and history');
    assert.ok(directive(csp, 'connect-src').includes(ptAssetHost), 'download fetch must be permitted');
    assert.ok(directive(csp, 'media-src').includes(ptAssetHost), 'generated video must be playable');
    assert.equal(directive(csp, 'script-src').includes(ptAssetHost), false, 'asset host must not gain script execution');
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
