import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-error-frame-'));
const children = [];
const originalSpawn = childProcess.spawn;
let readyNextChild = true;

class FakeChild extends EventEmitter {
  constructor(outputFd, sendReady) {
    super();
    this.outputFd = outputFd;
    this.exitCode = null;
    this.killed = false;
    this.messages = [];
    this.stdin = {
      write: (line) => {
        try { this.messages.push(JSON.parse(String(line))); } catch { /* tests inspect only valid adapter commands */ }
        return true;
      },
    };
    children.push(this);
    if (sendReady) queueMicrotask(() => this.send({ type: 'ready' }));
  }

  send(frame) {
    const normalized = { ...frame, protocolVersion: frame.protocolVersion ?? 1 };
    if (normalized.type === 'ready') {
      normalized.runner ??= 'persistent-runner';
      normalized.capabilities ??= ['task-v1', 'tool-rpc-v1', 'abort-v1'];
    }
    fs.writeSync(this.outputFd, JSON.stringify(normalized) + '\n');
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = 0;
    this.emit('close', 0, null);
  }
}

childProcess.spawn = (_command, _args, options) => {
  const sendReady = readyNextChild;
  readyNextChild = true;
  return new FakeChild(options.stdio[1], sendReady);
};
const { createDshRuntime } = require('../../shell/runtime/dsh-adapter.cjs');
const runtime = createDshRuntime({
  dshHome: path.join(temp, 'dsh-home'),
  settingsTemplate: path.resolve('shell/dsh-settings.yaml'),
  persistentRunner: path.resolve('shell/persistent-runner.mjs'),
  tmpDir: path.join(temp, 'logs'),
  idleMs: 60_000,
  taskTimeoutMs: 2_000,
});

const waitFor = async (predicate, label, timeoutMs = 2_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const spec = (sessionKey, tenantId) => ({
  sessionKey, tenantId, userId: 'error-frame-user', workspace: temp,
  apiKey: 'must-never-appear-in-runner-error', question: 'local adapter fixture',
});

test('adapter preserves safe runner control errors and observes uncorrelated errors', async (t) => {
  t.after(() => {
    runtime.close();
    childProcess.spawn = originalSpawn;
    for (const child of children) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  readyNextChild = false;
  const startupRun = runtime.run(spec('startup-session', 'startup-error-tenant'));
  const startupChild = children.at(-1);
  startupChild.send({ type: 'error', code: 'RUNNER_SETUP_FAILED', message: 'private startup secret' });
  const startupResult = await startupRun;
  assert.equal(startupResult.ok, false);
  assert.equal(startupResult.code, 'RUNNER_SETUP_FAILED');
  assert.equal(startupResult.error, 'Persistent runner setup failed');
  assert.equal(JSON.stringify(startupResult).includes('private startup secret'), false);
  assert.equal(startupChild.killed, true, 'startup error retires the child');

  const correlatedRun = runtime.run(spec('correlated-session', 'correlated-error-tenant'));
  const correlatedChild = children.at(-1);
  await waitFor(() => correlatedChild.messages.some((frame) => frame.type === 'task'), 'task dispatch after ready');
  const task = correlatedChild.messages.find((frame) => frame.type === 'task');
  correlatedChild.send({ type: 'error', sessionId: task.sessionId, code: 'RUNNER_QUEUE_FAILED', message: 'private queue secret' });
  const correlatedResult = await correlatedRun;
  assert.equal(correlatedResult.ok, false);
  assert.equal(correlatedResult.code, 'RUNNER_QUEUE_FAILED');
  assert.equal(correlatedResult.error, 'Parent command could not be processed');
  assert.equal(JSON.stringify(correlatedResult).includes('private queue secret'), false);

  const warn = console.warn;
  const diagnostics = [];
  console.warn = (...args) => diagnostics.push(args.map(String).join(' '));
  try {
    const uncorrelatedRun = runtime.run(spec('uncorrelated-session', 'uncorrelated-error-tenant'));
    const uncorrelatedChild = children.at(-1);
    await waitFor(() => uncorrelatedChild.messages.some((frame) => frame.type === 'task'), 'uncorrelated fixture task dispatch');
    const uncorrelatedTask = uncorrelatedChild.messages.find((frame) => frame.type === 'task');
    uncorrelatedChild.send({ type: 'error', code: 'PARENT_FRAME_INVALID', message: 'private malformed input' });
    await waitFor(() => diagnostics.length > 0, 'safe uncorrelated diagnostic');
    assert.match(diagnostics[0], /PARENT_FRAME_INVALID/);
    assert.match(diagnostics[0], /Parent frame is not valid JSON/);
    assert.equal(diagnostics[0].includes('private malformed input'), false);
    uncorrelatedChild.send({ type: 'done', sessionId: uncorrelatedTask.sessionId, ok: true, text: 'fixture complete' });
    const uncorrelatedResult = await uncorrelatedRun;
    assert.equal(uncorrelatedResult.ok, true, 'uncorrelated diagnostic does not fail an unrelated waiter');
    assert.equal(uncorrelatedResult.text, 'fixture complete');
  } finally {
    console.warn = warn;
  }
});
