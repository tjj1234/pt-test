/**
 * Offline local HTTP smoke for the real Northstar shell server.
 * Uses the existing browser harness fixtures for identity, model catalog, and DSH;
 * stages the source checkout so the harness cannot touch the caller's runtime.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const owned = fs.mkdtempSync('/private/tmp/northstar-local-http-smoke-');
const stage = path.join(owned, 'checkout');
const temp = path.join(owned, 'tmp');
const evidence = [];
let harness;
let harnessTempDir;
let runtimeDir;

const excludedDirectoryNames = new Set(['backup', 'backups', 'credentials', 'logs', 'secrets', 'uploads']);
function isSensitiveInputName(name) {
  if (/^\.env(?:\..*)?$/i.test(name) || name === '.npmrc') return true;
  if (excludedDirectoryNames.has(name.toLowerCase())) return true;
  if (/(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-]|$)/i.test(name)) return true;
  if (/(?:^|[._-])service[-_.]?account(?:[._-]|$)/i.test(name) || /(?:^|[._-])id_(?:rsa|ed25519|ecdsa|dsa)(?:[._-]|$)/i.test(name)) return true;
  if (/(?:^|[._-])private[-_.]?key(?:[._-]|$)/i.test(name)) return true;
  if (/(?:^|[._-])(?:access[_-]?token|refresh[_-]?token|token)\.json$/i.test(name)) return true;
  if (/\.log(?:\.\d+|[-.]\d{4}(?:[-.]?\d{2}){0,2})?(?:\.gz)?$/i.test(name)) return true;
  if (/\.(?:sql|dump)(?:\.(?:gz|bz2|xz|zst))$/i.test(name)) return true;
  if (/(?:^|[._-])backup(?:s)?(?:[-_.]?\d{4}(?:[-_.]?\d{2}){0,2})?(?:\.[^.]+)?$/i.test(name)) return true;
  return /\.(?:sqlite3?|db)(?:-(?:wal|shm))?$|\.(?:log|pem|key|p8|ppk|der|p12|pfx|jks|keystore|dump|bak|backup|old|orig)$/i.test(name) || /~$/.test(name);
}

function assertSensitiveInputFilter() {
  for (const name of [
    '.env', '.env.local', '.npmrc', 'state.sqlite', 'cache.db-wal', 'server.log', 'server.log.1',
    'server.log.2026-10-20.gz', 'client.pem', 'id_rsa', 'id_ed25519', 'service-account.json',
    'google_service_account_key.json', 'server-private-key.json', 'private_key.p8', 'token.json', 'access_token.json', 'auth-credentials.json',
    'snapshot.dump', 'snapshot.sql.gz', 'config.bak', 'database.backup-2026-10-20',
  ]) {
    assert.equal(isSensitiveInputName(name), true, `sensitive staging input must be excluded: ${name}`);
  }
  for (const name of ['server.cjs', 'index.js', 'token.js', 'package-lock.json', '001_auth.sql', 'auth-client.js']) {
    assert.equal(isSensitiveInputName(name), false, `ordinary source input must remain eligible: ${name}`);
  }
}

function copyTree(from, to, relativeRoot) {
  const stat = fs.lstatSync(from);
  assert.ok(!stat.isSymbolicLink(), `refusing to stage symlink: ${relativeRoot}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git' || isSensitiveInputName(entry.name)) continue;
      copyTree(path.join(from, entry.name), path.join(to, entry.name), path.posix.join(relativeRoot, entry.name));
    }
  } else if (stat.isFile()) {
    if (isSensitiveInputName(path.basename(from))) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

function installDependencyLink(relative) {
  const src = path.join(source, relative);
  const dst = path.join(stage, relative);
  const sourceStat = fs.lstatSync(src);
  assert.ok(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), `installed dependency root must be a real directory: ${relative}`);
  const resolvedSource = fs.realpathSync(src);
  const expectedSource = path.join(fs.realpathSync(source), relative);
  assert.equal(resolvedSource, expectedSource, `dependency source escaped approved checkout node_modules: ${relative}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.symlinkSync(resolvedSource, dst, 'dir');
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timer = setTimeout(() => reject(new Error('harness did not exit before timeout')), timeoutMs);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function request(origin, route, options = {}) {
  const response = await fetch(origin + route, { ...options, signal: AbortSignal.timeout(5000) });
  evidence.push({ method: options.method || 'GET', route, status: response.status });
  return response;
}

async function main() {
  assertSensitiveInputFilter();
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const root of ['shell', 'business', 'analytics']) copyTree(path.join(source, root), path.join(stage, root), root);
  copyTree(path.join(source, 'tests/probes/northstar-browser-harness.mjs'), path.join(stage, 'tests/probes/northstar-browser-harness.mjs'), 'tests/probes/northstar-browser-harness.mjs');
  for (const dep of ['shell/node_modules', 'business/attribution/node_modules', 'analytics/node_modules']) installDependencyLink(dep);

  const harnessPath = path.join(stage, 'tests/probes/northstar-browser-harness.mjs');
  harness = spawn(process.execPath, [harnessPath], {
    cwd: stage,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(owned, 'home'), TMPDIR: temp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  fs.mkdirSync(path.join(owned, 'home'), { recursive: true });
  let stdout = '';
  let stderr = '';
  harness.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  harness.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const startupDeadline = Date.now() + 30000;
  let ready;
  while (Date.now() < startupDeadline) {
    const line = stdout.split('\n').find(value => value.includes('"status":"ready"'));
    if (line) { ready = JSON.parse(line); break; }
    if (harness.exitCode !== null || harness.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, `controlled real server did not become ready; exit=${harness.exitCode}; stderr=${stderr.slice(-2000)}`);
  assert.ok(ready.controlDir.startsWith(temp + path.sep), `harness temp escaped owned TMPDIR: ${ready.controlDir}`);
  harnessTempDir = ready.controlDir;
  runtimeDir = ready.runtimeDir;
  assert.ok(runtimeDir.startsWith(owned + path.sep), 'mutable runtime state must stay in the owned persistent-state fixture');
  assert.ok(!runtimeDir.startsWith(stage + path.sep), 'runtime state must not be written into the release tree');
  const origin = new URL(ready.origin);
  assert.equal(origin.hostname, '127.0.0.1', 'server must bind loopback');

  const health = await request(origin.origin, '/healthz');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const unauth = await request(origin.origin, '/', { redirect: 'manual' });
  assert.equal(unauth.status, 302);
  assert.equal(unauth.headers.get('location'), '/login');

  const login = await request(origin.origin, '/login');
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /PowerTokens Agent/);
  const assetRefs = [...html.matchAll(/(?:src|href)\s*=\s*(["'])(\/assets\/[^"']+)\1/gi)].map(match => match[2]);
  assert.ok(assetRefs.length >= 2, 'login page should expose its stylesheet and login script assets');
  for (const ref of [...new Set(assetRefs)]) {
    const asset = await request(origin.origin, ref);
    assert.equal(asset.status, 200, `login asset must resolve: ${ref}`);
  }

  const statePath = ready.statePath;
  assert.ok(statePath.startsWith(harnessTempDir + path.sep), 'fixture browser state must stay in owned harness temp');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const session = state.cookies.find(cookie => cookie.name === 'pt_session');
  assert.ok(session?.value, 'fixture login must provide a session cookie');
  const headers = { Cookie: `pt_session=${session.value}`, Origin: origin.origin };
  for (const route of ['/api/me', '/api/conversations']) {
    const response = await request(origin.origin, route, { headers });
    assert.equal(response.status, 200, `authenticated same-origin API must succeed: ${route}`);
    const body = await response.json();
    assert.equal(body.ok, true, `API response must be successful: ${route}`);
    if (route === '/api/conversations') assert.ok(Array.isArray(body.conversations), 'conversations response must contain an array');
    if (route === '/api/me') assert.ok(body.user && body.tenant, 'identity response must contain fixture user and tenant');
  }

  console.log(JSON.stringify({ result: 'PASS', scope: 'real local shell HTTP server and PGlite storage; fixture identity/model/DSH; same-origin static page/assets and authenticated APIs; no external model or paid calls', origin: origin.origin, assetCount: [...new Set(assetRefs)].length, requests: evidence }));
}

try {
  await main();
} finally {
  if (harness && harness.exitCode === null && harness.signalCode === null) {
    harness.stdin.write('shutdown\n');
    try { await waitForClose(harness, 8000); }
    catch { harness.kill('SIGTERM'); await waitForClose(harness, 6000).catch(() => {}); }
  }
  const processStopped = !harness || harness.exitCode !== null || harness.signalCode !== null;
  if (!processStopped) throw new Error('refusing to remove owned staging while harness process may still be active');
  if (harnessTempDir) assert.ok(!fs.existsSync(harnessTempDir), 'browser harness must clean its own temp directory before stage removal');
  const fixtureWorkspaces = path.join(runtimeDir, 'workspaces');
  assert.ok(!fs.existsSync(fixtureWorkspaces) || fs.readdirSync(fixtureWorkspaces).length === 0,
    'browser harness must remove fixture tenant workspaces before stage removal');
  fs.rmSync(owned, { recursive: true, force: true });
  console.log(`CLEANUP ${fs.existsSync(owned) ? 'FAIL' : 'PASS'} removed owned staging after harness exit (${processStopped ? 'process stopped' : 'process active'})`);
}
