/** Offline clean-install/idle-boot probe. No host node_modules or runtime state copied. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync('/private/tmp/northstar-clean-release-');
const release = path.join(temp, 'release');
const runtimeFiles = ['dsh-adapter.cjs', 'contract.cjs', 'artifacts.cjs', 'dsh-installation.cjs', 'dsh-release-manifest.json', 'profile-dependencies.cjs', 'profile-lifecycle.cjs', 'profile-paths.cjs', 'usage.cjs', 'run-budget.json', 'bootstrap-policy.cjs', 'settings-version.cjs', 'settings-upgrade.cjs'];
const files = [
  'scripts/northstar-profile.cjs',
  'shell/package.json', 'shell/package-lock.json', 'shell/.npmrc',
  'shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz',
  'shell/persistent-runner.mjs', 'shell/dsh-settings.yaml', 'shell/tasks/budget.cjs',
  'business/media/powertokens.cjs', 'business/media/presets.cjs',
  'business/attribution/ga-connector/executor.js',
  ...runtimeFiles.map(name => `shell/runtime/${name}`),
];
const env = {
  PATH: process.env.PATH,
  HOME: path.join(temp, 'home'),
  TMPDIR: temp,
  npm_config_cache: process.env.npm_config_cache || path.join(os.homedir(), '.npm'),
  npm_config_logs_dir: path.join(temp, 'npm-logs'),
  npm_config_update_notifier: 'false',
};
fs.mkdirSync(env.HOME);
let child;
async function install() {
  const online = process.argv.includes('--online');
  const args = ['ci', ...(online ? [] : ['--offline']), '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=15000'];
  const npm = spawn('npm', args, { cwd: path.join(release, 'shell'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [npm.stdout, npm.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000); });
  const timer = setTimeout(() => npm.kill('SIGKILL'), 120000);
  let code;
  try { code = await new Promise((resolve, reject) => { npm.once('error', () => reject(new Error('npm process failed to start'))); npm.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  if (code !== 0) throw Object.assign(new Error(`${online ? "Online" : "Offline"} npm ci failed (${code}); category=${output.includes("ENOTCACHED") ? "ENOTCACHED" : output.includes("ENOTFOUND") ? "ENOTFOUND" : "INSTALL_FAILED"}; raw npm output withheld`), { code: 'CLEAN_INSTALL_FAILED' });
  console.log(`PASS ${online ? 'online' : 'offline'} npm ci; lifecycle scripts disabled; host npm cache reused and may gain entries`);
}
try {
  for (const file of files) {
    const source = path.join(root, file), destination = path.join(release, file);
    assert.ok(fs.lstatSync(source).isFile(), `copy source must be regular: ${file}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  assert.equal(fs.existsSync(path.join(release, 'shell/node_modules')), false);
  await install();
  const require = createRequire(path.join(release, 'shell/package.json'));
  const { resolveDshInstallation } = require(path.join(release, 'shell/runtime/dsh-installation.cjs'));
  const verified = resolveDshInstallation();
  console.log(`PASS DSH release integrity: ${verified.packageFileCount} package files; dependency closure integrity not independently verified`);
  const { makeProfile } = require(path.join(release, 'shell/runtime/dsh-adapter.cjs'));
  const dshHome = path.join(temp, 'dsh-home');
  makeProfile(dshHome, path.join(release, 'shell/dsh-settings.yaml'), path.join(release, 'shell/persistent-runner.mjs'));
  assert.equal(fs.existsSync(path.join(dshHome, 'profiles/run-persistent/node_modules')), false);
  require(path.join(release, 'shell/runtime/bootstrap-policy.cjs')).assertBootstrapPolicy({ home: dshHome, workspace: release, profileDir: path.join(dshHome, 'profiles/run-persistent') });
  child = spawn(process.execPath, [verified.entry, '--profile', 'run-persistent'], {
    cwd: release, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: temp, DSH_HOME: dshHome, PT_DASH_INTERNAL_KEY: '', DASH_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffered = '', frames = [], invalid, spawnError;
  child.once('error', () => { spawnError = new Error('Clean CLI process failed to start'); });
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const frame = JSON.parse(line); if (frame?.type) frames.push(frame); } catch {}
    }
  });
  child.stderr.resume();
  const started = Date.now();
  while (!frames.some(frame => frame.type === 'ready' && frame.runner === 'persistent-runner')) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null || Date.now() - started > 20000) throw new Error('Clean CLI failed to reach ready; raw startup logs withheld');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  invalid = frames.filter(frame => ['tool_request', 'done'].includes(frame.type));
  assert.deepEqual(invalid, []);
  const ready = frames.find(frame => frame.type === 'ready');
  assert.equal(ready.protocolVersion, 1);
  for (const capability of ['task-v1', 'tool-rpc-v1', 'abort-v1']) assert.ok(ready.capabilities?.includes(capability), `missing capability ${capability}`);
  console.log('PASS clean-installed real DSH CLI ready and idle; no task or model/tool request sent');
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  }
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('CLEANUP removed isolated release, HOME, profile and npm logs');
}
