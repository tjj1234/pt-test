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
      normalized.capabilities ??= ['task-v1', 'tool-rpc-v1', 'abort-v1', 'model-info-v1'];
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
  idleMs: 100,
  metadataTimeoutMs: 150,
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

test('metadata RPC is isolated, bounded, cancellable and never enters paid heartbeat targets', async (t) => {
  t.after(() => {
    runtime.close(); childProcess.spawn = originalSpawn;
    for (const child of children) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const input = { ...spec('unused', 'metadata-user'), provider: 'fixture', model: 'reasoner' };
  const pending = runtime.describeModel(input);
  const child = children.at(-1);
  await waitFor(() => child.messages.some(f => f.type === 'describe_model'), 'metadata dispatch');
  assert.deepEqual(runtime.activeTenants(), []);
  assert.equal((await runtime.pulse(input)).skipped, true);
  assert.equal((await runtime.describeModel(input)).code, 'MODEL_INFO_BUSY');
  const request = child.messages.find(f => f.type === 'describe_model');
  child.send({ type: 'model_info', requestId: 'wrong', ok: true });
  child.send({ type: 'model_info', requestId: request.requestId, ok: true,
    provider: 'fixture', model: 'reasoner', efforts: [{id:'high', name:'High'}], defaultEffort:'high', secret:'discard' });
  assert.deepEqual(await pending, {ok:true, provider:'fixture', model:'reasoner', efforts:[{id:'high', name:'High'}], defaultEffort:'high'});
  assert.equal(child.messages.some(f => f.type === 'task'), false);
  const controller = new AbortController();
  const canceled = runtime.describeModel({...input, signal:controller.signal});
  controller.abort(); assert.equal((await canceled).code, 'MODEL_INFO_CANCELED');
  const timeout = runtime.describeModel(input);
  assert.equal((await timeout).code, 'MODEL_INFO_TIMEOUT');
  const failed = runtime.describeModel(input);
  const latest = child.messages.filter(f => f.type === 'describe_model').at(-1);
  child.send({type:'model_info', requestId:latest.requestId, ok:false, code:'secret', error:'private credential'});
  assert.deepEqual(await failed, {ok:false, code:'MODEL_INFO_UNAVAILABLE'});
  await waitFor(() => child.messages.some(f => f.type === 'exit'), 'metadata-only idle reclamation');
  assert.deepEqual(runtime.activeTenants(), []);
  const preCanceled = new AbortController(); preCanceled.abort();
  const count = children.length;
  assert.equal((await runtime.describeModel({...input, tenantId:'never-spawn', signal:preCanceled.signal})).code, 'MODEL_INFO_CANCELED');
  assert.equal(children.length, count);
  assert.equal((await runtime.describeModel({...input, model:'a'.repeat(257)})).code, 'MODEL_INFO_INVALID');
  readyNextChild=false;
  const oldRun=runtime.run({...spec('old-run','old-runner'),model:'reasoner',reasoningEffort:'high'});
  const oldChild=children.at(-1);
  oldChild.send({type:'ready',capabilities:['task-v1','tool-rpc-v1','abort-v1']});
  assert.equal((await oldRun).code,'DSH_REASONING_UNSUPPORTED');
  assert.equal(oldChild.messages.some(frame=>frame.type==='task'),false,'old runner cannot silently ignore effort');
  readyNextChild=false;
  const oldMetadata=runtime.describeModel({...input,tenantId:'old-metadata'});
  const oldMetadataChild=children.at(-1);
  oldMetadataChild.send({type:'ready',capabilities:['task-v1','tool-rpc-v1','abort-v1']});
  assert.equal((await oldMetadata).code,'MODEL_INFO_UNSUPPORTED');
  assert.equal(oldMetadataChild.messages.some(frame=>frame.type==='describe_model'),false);

});
