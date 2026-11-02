/**
 * T08 no-paid-call protocol probe. Runs the production persistent-runner.mjs
 * JSONL protocol with an in-process fake LlmAdapter. The task contains only a
 * synthetic text marker standing in for imageNote; it is not image data.
 * No Shell Server, HTTP listener, provider network request, or paid model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runnerSource = path.join(root, 'shell/persistent-runner.mjs');
let tempRoot;
let runnerDir;
let child;
let spawned = false;
let stdoutBuffer = '';
let stderrBuffer = '';
const stdoutFrames = [];
let providerCapture = null;

function waitFor(predicate, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) { clearTimeout(timer); resolve(value); return true; }
      return false;
    };
    const onData = () => { check(); };
    child.stdout.on('data', onData);
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`${label} timeout; stdout=${stdoutBuffer}; stderr=${stderrBuffer}`));
    }, timeoutMs);
    if (check()) child.stdout.off('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      if (!check()) reject(new Error(`${label}: child exited (${code ?? signal}); stderr=${stderrBuffer}`));
    });
  });
}

async function waitForExit(timeoutMs = null) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !spawned) return true;
  return new Promise((resolve) => {
    let timer;
    const onClose = () => { if (timer) clearTimeout(timer); resolve(true); };
    child.once('close', onClose);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => { child.off('close', onClose); resolve(false); }, timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) onClose();
  });
}

try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-t08-runner-'));
  runnerDir = fs.mkdtempSync(path.join(root, 'shell/.t08-runner-probe-'));
  const runner = path.join(runnerDir, 'persistent-runner.mjs');
  for (const [source, target] of [
    [runnerSource, runner],
    [path.join(root, 'shell/tasks/budget.cjs'), path.join(runnerDir, 'budget.cjs')],
    [path.join(root, 'shell/runtime/usage.cjs'), path.join(runnerDir, 'usage.cjs')],
    [path.join(root, 'business/media/presets.cjs'), path.join(runnerDir, 'presets.cjs')],
  ]) fs.copyFileSync(source, target);

  const childSource = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const allowedEnv = new Set(['PATH', 'HOME', 'DSH_HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', '__CF_USER_TEXT_ENCODING']);
const unexpectedEnv = Object.keys(process.env).filter((key) => !allowedEnv.has(key));
if (unexpectedEnv.length) throw new Error('unexpected inherited environment keys: ' + unexpectedEnv.join(','));
const isolatedRoot = path.resolve(${JSON.stringify(tempRoot)});
for (const key of ['HOME', 'DSH_HOME', 'TMPDIR']) if (!path.resolve(process.env[key]).startsWith(isolatedRoot + path.sep)) throw new Error('environment path escaped isolated temp root');
const root = process.cwd();
const req = createRequire(path.join(root, 'shell/package.json'));
const load = async (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)));
const [cordis, agentsPkg, sessionsPkg, llmPkg, promptPkg, toolsPkg, loopPkg, defaultsPkg] = await Promise.all([
  'cordis', 'dsh-agent', 'dsh-session', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop', 'dsh-agent-default-model',
].map(load));
const ctx = new cordis.Context();
for (const [plugin, config] of [
  [agentsPkg.default], [sessionsPkg.default], [llmPkg.default], [promptPkg.default, {}], [toolsPkg.default, {}],
  [loopPkg.default, { agents: [] }], [defaultsPkg.default, { provider: 't08-capture', model: 'fixture-text-only' }],
]) { const fiber = ctx.plugin(plugin, ...(config === undefined ? [] : [config])); await fiber; }
class Capture extends llmPkg.LlmAdapter {
  async *stream(options) {
    process.stderr.write('T08_PROVIDER_CAPTURE=' + JSON.stringify(options.messages) + '\n');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
ctx.llm.registerAdapter(['t08-capture'], new Capture());
const { apply } = await import(pathToFileURL(${JSON.stringify(path.join(root, 'shell/.t08-runner-placeholder'))}));
apply(ctx);
`;
  // Point the import at the prepared, unmodified runner source copy.
  const wiredChildSource = childSource.replace(
    JSON.stringify(path.join(root, 'shell/.t08-runner-placeholder')),
    JSON.stringify(runner),
  );
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: path.join(tempRoot, 'home'),
    DSH_HOME: path.join(tempRoot, 'dsh-home'),
    TMPDIR: path.join(tempRoot, 'tmp'),
    TEMP: path.join(tempRoot, 'tmp'),
    TMP: path.join(tempRoot, 'tmp'),
    LANG: 'C',
  };
  for (const key of ['HOME', 'DSH_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const budgetDir = path.join(env.DSH_HOME, 'profiles', 'run-persistent');
  fs.mkdirSync(budgetDir, { recursive: true });
  fs.writeFileSync(path.join(budgetDir, 'run-budget.json'), JSON.stringify({ maxDurationMs: 15000, maxModelCalls: 2, maxToolCalls: 1, maxToolCallsPerKey: 1, maxRetries: 0 }), { mode: 0o600 });

  child = spawn(process.execPath, ['--input-type=module', '-e', wiredChildSource], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.once('spawn', () => { spawned = true; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try { stdoutFrames.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
    for (const line of stderrBuffer.split('\n')) if (line.startsWith('T08_PROVIDER_CAPTURE=')) {
      try { providerCapture = JSON.parse(line.slice('T08_PROVIDER_CAPTURE='.length)); } catch {}
    }
  });
  child.once('error', (error) => { stderrBuffer += `\nSPAWN_ERROR=${error.message}`; });

  const ready = await waitFor(() => stdoutFrames.find((frame) => frame.type === 'ready'), 'runner ready');
  assert.equal(ready.runner, 'persistent-runner');
  const marker = 'T08_SYNTHETIC_IMAGE_MARKER_NOT_IMAGE_DATA';
  child.stdin.write(JSON.stringify({
    type: 'task', protocolVersion: 1, sessionId: 't08-image', tenantId: 'tenant-t08',
    provider: 't08-capture', model: 'fixture-text-only',
    task: '用户问题：请处理上传图片。\n图片说明：' + marker,
  }) + '\n');

  const done = await waitFor(
    () => stdoutFrames.find((frame) => frame.type === 'done' && frame.sessionId === 't08-image'),
    'runner done',
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.ok(Array.isArray(providerCapture), `fake adapter did not capture DSH request: ${stderrBuffer}`);
  const user = [...providerCapture].reverse().find((message) => message.role === 'user');
  assert.ok(user, 'captured DSH request includes user message');
  assert.deepEqual(user.content.map((block) => block.type), ['text']);
  assert.match(user.content[0].text, new RegExp(marker));
  assert.equal(user.content.some((block) => block.type === 'image'), false);
  console.log(JSON.stringify({
    status: 'PASS', paidCalls: 0, networkAccess: 'none-by-design (in-process fake adapter; no PT adapter)', childEnvIsolated: true,
    protocol: 'production persistent-runner JSONL task/done',
    requestContentTypes: user.content.map((block) => block.type),
    syntheticMarkerPresentAsText: true, imageModalityPresent: false,
    boundary: 'captures the real runner to in-process fake-adapter handoff; marker is synthetic text, and upload decoding plus PowerTokens network serialization are not exercised',
  }, null, 2));
} finally {
  if (child && spawned && child.exitCode === null && child.signalCode === null) {
    try { child.stdin.write(JSON.stringify({ type: 'exit' }) + '\n'); child.stdin.end(); } catch {}
    let exited = await waitForExit(3000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch (error) { throw new Error(`could not send SIGTERM; preserving temp dirs: ${error.message}`); }
      exited = await waitForExit(3000);
    }
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch (error) { throw new Error(`could not send SIGKILL; preserving temp dirs: ${error.message}`); }
      await waitForExit();
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('child exit was not confirmed; preserving temp dirs');
  }
  if (runnerDir && fs.existsSync(runnerDir)) fs.rmSync(runnerDir, { recursive: true, force: true });
  if (tempRoot && fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
}
