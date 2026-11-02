import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createStorage } = require('../../shell/storage/index.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('T10 artifact download refuses a tenant workspace symlink to another tenant file', { timeout: 45000 }, async t => {
  assert.equal(Object.keys(process.env).some(k => k.startsWith('PT_PG_') && process.env[k]), false);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'northstar-t10-artifact-'));
  const runtimeDir = path.join(temp, 'runtime');
  const dbDir = path.join(temp, 'db');
  const masterKeyFile = path.join(temp, 'key');
  const tenants = [], cookies = [], users = [];
  let storage, child, output = '';
  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    for (let i = 0; i < 2; i++) {
      const registered = await storage.repositories.auth.register({
        username: `t10-artifact-${i}`,
        email: `t10-artifact-${i}@example.test`,
        password: 'FixtureReview123',
      });
      assert.equal(registered.ok, true);
      users.push(registered.user.id);
      tenants.push(registered.user.tenant_id);
      await storage.db.query(
        'INSERT INTO google_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)',
        ['https://accounts.google.com', `fixture-t10-${i}`, registered.user.id, registered.user.email],
      );
      const token = crypto.randomBytes(32).toString('hex');
      await storage.db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [
        registered.user.id, hash(token), new Date(Date.now() + 120000).toISOString(),
      ]);
      cookies.push(`pt_session=${token}`);
    }
    const workspaceRoot = path.join(runtimeDir, 'workspaces');
    const tenantA = path.join(workspaceRoot, tenants[0]);
    const tenantB = path.join(workspaceRoot, tenants[1]);
    fs.mkdirSync(tenantA, { recursive: true });
    fs.mkdirSync(tenantB, { recursive: true });
    fs.writeFileSync(path.join(tenantA, 'valid-report.pdf'), 'tenant A report');
    const privateArtifact = path.join(tenantB, 'private-report.pdf');
    fs.writeFileSync(privateArtifact, 'tenant B private artifact');
    fs.symlinkSync(privateArtifact, path.join(tenantA, 'leak.pdf'));
    fs.symlinkSync(tenantB, path.join(tenantA, 'linked-directory'));
    fs.linkSync(privateArtifact, path.join(tenantA, 'hardlink.pdf'));
    const fifoArtifact = path.join(tenantA, 'fifo.pdf');
    const fifoCreated = spawnSync('mkfifo', [fifoArtifact], { encoding: 'utf8' });
    assert.equal(fifoCreated.status, 0, fifoCreated.stderr || 'mkfifo failed');
    await storage.close();
    storage = null;

    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      PT_RUNTIME_DIR: runtimeDir,
      PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, 'logs'),
      PT_SHELL_PORT: String(port),
      PT_LISTEN_HOST: '127.0.0.1',
      PT_KEY_LIVE_VERIFY: '0',
      PT_CHAT_DRYRUN: '1',
    };
    child = spawn(process.execPath, ['shell/server.cjs', '--port', String(port)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    t.after(async () => {
      if (child && child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      if (storage) await storage.close();
      fs.rmSync(temp, { recursive: true, force: true });
    });

    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        const response = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookies[0] } });
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, output.slice(-2500));
    const unauthenticated = await fetch(`${origin}/api/artifact?p=valid-report.pdf`);
    assert.equal(unauthenticated.status, 401);
    const valid = await fetch(`${origin}/api/artifact?p=valid-report.pdf`, { headers: { Cookie: cookies[0] } });
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), 'tenant A report');
    const head = await fetch(`${origin}/api/artifact?p=valid-report.pdf`, { method: 'HEAD', headers: { Cookie: cookies[0] } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const rel of ['leak.pdf', 'linked-directory/private-report.pdf', 'hardlink.pdf']) {
      const response = await fetch(`${origin}/api/artifact?p=${encodeURIComponent(rel)}`, { headers: { Cookie: cookies[0] } });
      const body = await response.text();
      assert.ok([403, 404].includes(response.status),
        `expected a denied/not-found response for ${rel}; got ${response.status} with body=${body}`);
      assert.ok(!body.includes('tenant B private artifact'));
    }
    const fifoResponse = await fetch(`${origin}/api/artifact?p=fifo.pdf`, {
      headers: { Cookie: cookies[0] }, signal: AbortSignal.timeout(1500),
    });
    assert.equal(fifoResponse.status, 404, 'FIFO is not a regular artifact');
    const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1500) });
    assert.equal(health.status, 200, 'a rejected FIFO must not block the shell HTTP event loop');
    assert.equal((await health.json()).ok, true);
    assert.equal(users.length, 2);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    if (storage) await storage.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
