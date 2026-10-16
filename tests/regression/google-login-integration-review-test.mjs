import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createStorage } = require('../../shell/storage/index.cjs');
async function freePort() { const server = createServer(); await new Promise((r, j) => server.once('error', j).listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }

test('independent integration: upgrade denies legacy password sessions/routes; callback provisions before cookie', { timeout: 30000 }, async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith('PT_PG_') && process.env[key]), false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-google-integration-review-'));
  let storage, child, tenantId;
  const runtimeDirs = [];
  try {
    const oldMigrations = path.join(tmp, 'old-migrations'); fs.mkdirSync(oldMigrations);
    for (const name of fs.readdirSync(path.join(root, 'shell/db-migrations'))) if (name.endsWith('.sql') && name < '012') fs.copyFileSync(path.join(root, 'shell/db-migrations', name), path.join(oldMigrations, name));
    const dbDir = path.join(tmp, 'db');
    storage = await createStorage({ dataDir: dbDir, masterKeyFile: path.join(tmp, 'key'), migrationsDir: oldMigrations });
    const registered = await storage.repositories.auth.register({ username: 'legacy-review', email: 'review@example.test', password: 'LegacyReview123' });
    assert.equal(registered.ok, true);
    tenantId = registered.user.tenant_id;
    const legacy = await storage.repositories.auth.login({ username: 'legacy-review', password: 'LegacyReview123' });
    assert.equal(legacy.ok, true);
    await storage.close(); storage = null;
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    const stopToken = 'review-stop-token';
    // Mock only the external verified identity exchange. Real routes, product composition,
    // PGlite sessions, migration, workspace initialization and Cookie responses remain real.
    const preload = path.join(tmp, 'verified-identity-fixture.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module'); const load=Module._load; const crypto=require('node:crypto');
Module._load=function(name,parent,isMain){ const loaded=load.apply(this,arguments); if(parent?.filename.endsWith('auth-google-routes.cjs') && name==='./auth-google.cjs') return {...loaded,createGoogleAuth:async({db})=>({begin:async()=>({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state'}),callback:async()=>{const user=(await db.query("SELECT id,username,email,role,tenant_id FROM users WHERE username=$1",['legacy-review'])).rows[0]; const token=crypto.randomBytes(32).toString('base64url');const expiresAt=new Date(Date.now()+60000).toISOString();await db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,crypto.createHash('sha256').update(token).digest('hex'),expiresAt]);return {ok:true,user,token,expiresAt};}})}; return loaded;};`);
    const env = { PATH: process.env.PATH, HOME: tmp, PT_DB_DIR: dbDir, PT_MASTER_KEY_FILE: path.join(tmp, 'key'), PT_LOG_DIR: path.join(tmp, 'logs'), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: '127.0.0.1', PT_TEST_SHUTDOWN_TOKEN: stopToken, GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_REDIRECT_URI: origin + '/api/auth/google/callback' };
    child = spawn(process.execPath, ['--require', preload, 'shell/server.cjs', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
    let ready = false;
    for (let i = 0; i < 200; i++) { if (child.exitCode !== null) break; try { if ((await fetch(origin + '/healthz')).ok) { ready = true; break; } } catch {} await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(ready, output.slice(-3000));
    const oldMe = await fetch(origin + '/api/auth/me', { headers: { Cookie: 'pt_session=' + legacy.token } });
    assert.equal(oldMe.status, 401, 'pre-upgrade password session is revoked by product migration');
    for (const route of ['/api/login', '/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/change-password']) for (const method of ['GET', 'POST', 'PUT']) {
      const response = await fetch(origin + route, { method, headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ username: 'legacy-review', password: 'LegacyReview123' }) }) });
      assert.equal(response.status, 410, method + ' ' + route);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal((await fetch(origin + '/api/auth/google/start', { headers: { Origin: 'https://attacker.example' }, redirect: 'manual' })).status, 403);
    const begin = await fetch(origin + '/api/auth/google/start', { redirect: 'manual' });
    assert.equal(begin.status, 303);
    const binding = begin.headers.get('set-cookie'); assert.match(binding, /HttpOnly/); assert.match(binding, /SameSite=Lax/);
    const missingBinding = await fetch(origin + '/api/auth/google/callback?state=x&code=x', { headers: { Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(missingBinding.headers.get('location'), '/login?error=google_auth');
    assert.equal(missingBinding.headers.get('set-cookie'), null);
    const fixtureDirs = [path.join(root, 'runtime/workspaces', tenantId), path.join(root, 'runtime/workspaces', 'ws_' + tenantId)];
    for (const dir of fixtureDirs) assert.equal(fs.existsSync(dir), false, 'synthetic workspace must not preexist');
    runtimeDirs.push(...fixtureDirs);
    const callback = await fetch(origin + '/api/auth/google/callback?state=fixture-state&code=fixture-code', { headers: { Cookie: binding.split(';')[0], Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
    const session = callback.headers.get('set-cookie'); assert.match(session, /^pt_session=/); assert.match(session, /HttpOnly/);
    assert.equal(fs.existsSync(path.join(runtimeDirs[0], '.dsh/skills')), true, 'DSH workspace exists before client receives session');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDirs[1], 'metadata.json'))).tenantId, tenantId);
    const me = await fetch(origin + '/api/auth/me', { headers: { Cookie: session.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, registered.user.id);
    fs.writeFileSync(path.join(runtimeDirs[1], 'metadata.json'), 'broken-fixture-json');
    const failedProvision = await fetch(origin + '/api/auth/google/callback?state=fixture-state&code=fixture-code', { headers: { Cookie: binding.split(';')[0], Origin: 'https://accounts.google.com' }, redirect: 'manual' });
    assert.equal(failedProvision.headers.get('location'), '/login?error=google_auth');
    assert.equal(failedProvision.headers.get('set-cookie'), null, 'workspace provisioning failure must not expose a session cookie');
    const crossLogout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: session.split(';')[0], Origin: 'https://attacker.example' } });
    assert.equal(crossLogout.status, 403);
    assert.equal(crossLogout.headers.get('set-cookie'), null);
    await fetch(origin + '/__test_shutdown', { method: 'POST', headers: { 'x-shutdown-token': stopToken } });
    await new Promise((r) => child.once('exit', r));
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
    if (storage) await storage.close();
    for (const dir of runtimeDirs) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
