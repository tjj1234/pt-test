import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

async function launch(t, source, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-runner-control-'));
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(profile);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const [from, to] of [
    ['shell/persistent-runner.mjs', 'persistent-runner.mjs'],
    ['shell/tasks/budget.cjs', 'budget.cjs'],
    ['shell/runtime/usage.cjs', 'usage.cjs'],
    ['shell/runtime/native-image-message.mjs', 'native-image-message.mjs'],
    ['business/media/presets.cjs', 'presets.cjs'],
    ['business/attribution/ga-connector/executor.js', 'ga-query-executor.cjs'],
  ]) fs.copyFileSync(path.join(repo, from), path.join(profile, to));
  fs.symlinkSync(path.join(repo, 'shell/node_modules'), path.join(profile, 'node_modules'), 'dir');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repo,
    env: { ...process.env, RUNNER_PATH: path.join(profile, 'persistent-runner.mjs'), DSH_HOME: path.join(tmp, 'dsh'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
  const frames = [];
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    let i;
    while ((i = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, i); output = output.slice(i + 1);
      try { frames.push(JSON.parse(line)); } catch { /* assert expected protocol frames below */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, frames, stderr: () => stderr };
}

const normalHarness = String.raw`
import { pathToFileURL } from 'node:url';
const { apply } = await import(pathToFileURL(process.env.RUNNER_PATH).href);
const ctx = {
  get(key) {
    if (key === 'loader') return { await: async () => {} };
    if (key === 'agents') return { create: async () => ({ agent: {} }) };
    if (key === 'agentDefaultModel') return {};
    if (key === 'sessions') return { flush: async () => {} };
    if (key === 'appExit') return () => {};
  },
  on() {},
};
apply(ctx);
`;

test('persistent runner control frames use stable safe errors', async (t) => {
  const { child, frames, stderr } = await launch(t, normalHarness);
  await waitFor(() => frames.some((frame) => frame.type === 'ready'), 'ready');
  child.stdin.write(JSON.stringify({ protocolVersion: 1, type: 'ping' }) + '\n');
  await waitFor(() => frames.some((frame) => frame.type === 'pong'), 'stdin ping');
  const sendLine = (line) => child.stdin.write(line + '\n');
  const expectError = async (line, code, message, count) => {
    sendLine(line);
    await waitFor(() => frames.filter((frame) => frame.type === 'error').length >= count, `error ${count}; frames=${JSON.stringify(frames)}; stderr=${stderr()}`);
    const frame = frames.filter((item) => item.type === 'error')[count - 1];
    assert.equal(frame.code, code);
    assert.equal(frame.message, message);
    return frame;
  };
  await expectError('{"type":"task","task":"secret-input-must-not-echo', 'PARENT_FRAME_INVALID', 'Parent frame is not valid JSON', 1);
  await expectError('null', 'PARENT_FRAME_INVALID', 'Parent frame is not valid JSON', 2);
  const unsupported = await expectError(JSON.stringify({ protocolVersion: 1, type: 'secret-command-name', sessionId: 'valid_session' }), 'PARENT_COMMAND_UNSUPPORTED', 'Parent command is not supported', 3);
  const invalidTask = await expectError(JSON.stringify({ protocolVersion: 1, type: 'task', sessionId: { secret: 'bad' }, tenantId: 'tenant-secret', task: 'x' }), 'TASK_FRAME_INVALID', 'Parent task frame is invalid', 4);
  const errors = frames.filter((frame) => frame.type === 'error');
  assert.equal(JSON.stringify(errors).includes('secret'), false);
  assert.equal(unsupported.sessionId, 'valid_session');
  assert.equal(Object.hasOwn(invalidTask, 'sessionId'), false, 'untrusted malformed session id is not echoed');
  child.stdin.end();
});

test('persistent runner setup exception is sanitized and classified', async (t) => {
  const setupHarness = String.raw`
import { pathToFileURL } from 'node:url';
const { apply } = await import(pathToFileURL(process.env.RUNNER_PATH).href);
apply({ get(key) { if (key === 'loader') return { await: async () => { throw new Error('setup-private-secret'); } }; } });
`;
  const { child, frames, stderr } = await launch(t, setupHarness);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  await waitFor(() => frames.some((frame) => frame.type === 'error'), 'setup error frame');
  const error = frames.find((frame) => frame.type === 'error');
  assert.equal(error.code, 'RUNNER_SETUP_FAILED');
  assert.equal(error.message, 'Persistent runner setup failed');
  assert.equal(JSON.stringify(error).includes('setup-private-secret'), false);
  assert.equal(await exited, 1);
  assert.equal(stderr().includes('setup-private-secret'), false);
});
