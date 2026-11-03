import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPtAssetUploadBridge,
  ASSET_SAFE_FILENAME_RE,
  ASSET_TASK_ID_RE,
  MAX_INITIAL_FRAME,
  MAX_EVENT_FRAME,
  MAX_TOTAL_STDOUT,
  MAX_TOTAL_STDERR,
  MAX_ASSET_BYTES,
} = require('../../shell/media/pt-asset-upload-bridge-candidate.cjs');

const ROOT = path.resolve('.');
const VENDOR_ENGINE = path.join(ROOT, 'shell/media/vendor/powertokens_video/pt_video.py');
const PATCH_1 = path.join(ROOT, 'docs/refactor/candidates/pt-asset-upload-product-20261029.patch');
const PATCH_2 = path.join(ROOT, 'docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch');
const WORKER_PATH = path.join(ROOT, 'shell/media/pt-asset-upload-worker-candidate.py');
const PYTHON_BIN = '/usr/bin/python3';

// Helper to prepare isolated patched engine in a temp dir
function setupPatchedEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-asset-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const engineFile = path.join(dir, 'pt_video.py');
  fs.copyFileSync(VENDOR_ENGINE, engineFile);

  const baselineSha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(baselineSha, 'da3f863404e9bf877e315bf9ac0180c05b6d0365f5c1dcc7e268d15b2cd4476d');

  // Apply Patch 1
  const { execFileSync } = require('node:child_process');
  execFileSync('patch', ['-p1', '-i', PATCH_1], { cwd: dir, stdio: 'pipe' });
  const p1Sha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(p1Sha, 'dd9a4b6a57fde2578dd07b41c96c5745af42978b3092b201cd75b75594d1dd8a');

  // Apply Patch 2
  execFileSync('patch', ['-p1', '-i', PATCH_2], { cwd: dir, stdio: 'pipe' });
  const p2Sha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(p2Sha, '79f3af2c15eaa97eae2bda621dbd5a6772b837c821d97bd611ad042253764529');

  return engineFile;
}

// Python fixture script that intercepts network with offline mock responses
const OFFLINE_WORKER_FIXTURE = `
import importlib.util, sys, socket, json
from pathlib import Path

def blocked(*a, **k):
    raise RuntimeError('NETWORK_ACCESS_FORBIDDEN')

socket.socket.connect = blocked
socket.getaddrinfo = blocked

worker_path = sys.argv[1]
engine_path = sys.argv[2]
calls_log = sys.argv[3]

spec = importlib.util.spec_from_file_location('worker', worker_path)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class MockHTTPResponse:
    def __init__(self, data, code=200):
        self._data = data
        self.code = code
        self.status = code
        self.headers = {'Content-Type': 'application/json'}
    def read(self, amt=None):
        return self._data
    def getcode(self):
        return self.code
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass

def transport(req, timeout=None):
    method = req.get_method()
    with open(calls_log, 'a') as f:
        f.write(method + '\\n')
    if method == 'POST':
        return MockHTTPResponse(b'{"code":200,"data":{"task_id":"task_fixture_101"}}')
    return MockHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_fixture_202"}}')

w.run(transport=transport, engine_path=engine_path)
`;

function setupIntegrationBridge(t) {
  const engineFile = setupPatchedEngine(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-asset-bridge-calls-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const callsFile = path.join(tempDir, 'calls.log');
  let lastSpawnOptions;

  const bridge = createPtAssetUploadBridge({
    pythonBinary: PYTHON_BIN,
    workerPath: WORKER_PATH,
    enginePath: engineFile,
    spawnImpl: (binary, args, options) => {
      lastSpawnOptions = { binary, args, options };
      return spawn(
        binary,
        ['-I', '-B', '-c', OFFLINE_WORKER_FIXTURE, WORKER_PATH, engineFile, callsFile],
        options,
      );
    },
  });

  return {
    bridge,
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : []),
    options: () => lastSpawnOptions,
  };
}

// Rogue worker builder for protocol failure tests
function rogueBridge(pythonCode) {
  return createPtAssetUploadBridge({
    pythonBinary: PYTHON_BIN,
    workerPath: WORKER_PATH,
    spawnImpl: (binary, args, options) => spawn(binary, ['-I', '-B', '-c', pythonCode], options),
  });
}

const sampleBuffer = () => Buffer.from('fake-png-image-binary-data-for-testing');
const baseInput = () => ({
  buffer: sampleBuffer(),
  filename: 'reference.png',
  apiKey: 'offline-fixture-key-1234',
  baseUrl: 'https://api.powertokens.ai',
  timeoutMs: 5000,
  onBeforeSubmit: async () => {},
  onSubmissionStarted: async () => {},
  onTaskId: async () => {},
  onAssetId: async () => {},
});

// --------------------------------------------------------------------------
// 1. Integration Tests: Upload, Recovery, and Hooks Acknowledgments
// --------------------------------------------------------------------------

test('1. successful upload: orders 4 hooks, records POST/GET, returns frozen receipt', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  const order = [];

  input.onBeforeSubmit = async (meta) => {
    assert.equal(meta.byte_count, input.buffer.length);
    assert.deepEqual(f.calls(), []);
    order.push('before_submit');
  };
  input.onSubmissionStarted = async () => {
    assert.deepEqual(f.calls(), []);
    order.push('submission_started');
  };
  input.onTaskId = async ({ taskId }) => {
    assert.equal(taskId, 'task_fixture_101');
    assert.deepEqual(f.calls(), ['POST']);
    order.push('on_task_id');
  };
  input.onAssetId = async ({ assetId, taskId }) => {
    assert.equal(assetId, 'asset_fixture_202');
    assert.equal(taskId, 'task_fixture_101');
    assert.deepEqual(f.calls(), ['POST', 'GET']);
    order.push('on_asset_id');
  };

  const receipt = await f.bridge.upload(input);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.taskId, 'task_fixture_101');
  assert.equal(receipt.assetId, 'asset_fixture_202');
  assert.equal(receipt.byteCount, input.buffer.length);
  assert.equal(receipt.mayResubmit, false);
  assert.equal(receipt.submissionMayHaveStarted, true);
  assert.equal(Object.isFrozen(receipt), true);

  assert.deepEqual(order, ['before_submit', 'submission_started', 'on_task_id', 'on_asset_id']);
  assert.deepEqual(f.calls(), ['POST', 'GET']);

  // Ensure apiKey was NOT leaked into spawn argv or environment
  assert.ok(!JSON.stringify(f.options()).includes(input.apiKey));
});

test('2. successful GET-only recovery: exactly 1 GET, zero POST, no key/bytes', async (t) => {
  const f = setupIntegrationBridge(t);
  const assetIds = [];

  const receipt = await f.bridge.recover({
    taskId: 'task_fixture_recovered_777',
    baseUrl: 'https://api.powertokens.ai',
    onAssetId: async ({ assetId }) => {
      assetIds.push(assetId);
    },
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.taskId, 'task_fixture_recovered_777');
  assert.equal(receipt.mayResubmit, false);
  assert.deepEqual(f.calls(), ['GET'], 'Recovery must make exactly GET and 0 POST');
});

// --------------------------------------------------------------------------
// 2. Hook Refusal & Early Failure Tests (Zero POST Guarantees)
// --------------------------------------------------------------------------

test('3. refusal at onBeforeSubmit yields 0 POST', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onBeforeSubmit = async () => {
    throw new Error('Refused by persistent gate');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'not_submitted');
  assert.equal(receipt.errorCode, 'HOOK_BEFORE_SUBMIT_FAILED');
  assert.equal(receipt.submissionMayHaveStarted, false);
  assert.deepEqual(f.calls(), [], '0 POST on before_submit failure');
});

test('4. refusal at onSubmissionStarted yields 0 POST', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onSubmissionStarted = async () => {
    throw new Error('Refused by intent persistence');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'not_submitted');
  assert.equal(receipt.errorCode, 'HOOK_SUBMISSION_STARTED_FAILED');
  assert.deepEqual(f.calls(), [], '0 POST on submission_started failure');
});

test('5. refusal at onTaskId retains taskId and stops polling', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onTaskId = async () => {
    throw new Error('Local task_id save failed');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'task_id_persisting_failed');
  assert.equal(receipt.taskId, 'task_fixture_101');
  assert.equal(receipt.submissionMayHaveStarted, true);
  assert.equal(receipt.mayResubmit, false);
  assert.deepEqual(f.calls(), ['POST'], 'POST made, but 0 GET because polling was aborted');
});

test('6. refusal at onAssetId retains both taskId and assetId without second POST', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onAssetId = async () => {
    throw new Error('Asset ID save failed');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'asset_id_persisting_failed');
  assert.equal(receipt.taskId, 'task_fixture_101');
  assert.equal(receipt.assetId, 'asset_fixture_202');
  assert.equal(receipt.submissionMayHaveStarted, true);
  assert.equal(receipt.mayResubmit, false);
  assert.deepEqual(f.calls(), ['POST', 'GET']);
});

// --------------------------------------------------------------------------
// 3. Pre-spawn Input Validation & Injection Rejection (0 POST)
// --------------------------------------------------------------------------

test('7. input validation: rejects 0-byte or oversized buffers (> 5 MiB)', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  // 0 bytes
  await assert.rejects(
    bridge.upload({ ...baseInput(), buffer: Buffer.alloc(0) }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );

  // > 5 MiB
  await assert.rejects(
    bridge.upload({ ...baseInput(), buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );
});

test('8. input validation: rejects unsafe filenames (path traversal, slashes, control chars)', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  for (const fn of ['../secret.png', 'dir/ref.png', 'a\\b.jpg', 'ref\n.png', 'x'.repeat(65)]) {
    await assert.rejects(
      bridge.upload({ ...baseInput(), filename: fn }),
      { code: 'ASSET_BRIDGE_INPUT_INVALID' },
    );
  }
});

test('9. input validation: rejects invalid API keys (empty, control chars, > 4096)', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  for (const key of ['', 'key\x00null', 'key\r\nleak', 'x'.repeat(4097)]) {
    await assert.rejects(
      bridge.upload({ ...baseInput(), apiKey: key }),
      { code: 'ASSET_BRIDGE_INPUT_INVALID' },
    );
  }
});

test('10. input validation: rejects invalid gateway URLs', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  for (const url of ['http://insecure.test', 'https://user:pass@api.test', 'https://api.test/path', 'https://api.test?query=1', 'bad-url']) {
    await assert.rejects(
      bridge.upload({ ...baseInput(), baseUrl: url }),
      { code: 'ASSET_BRIDGE_GATEWAY_INVALID' },
    );
  }
});

test('11. input validation: rejects arbitrary untrusted fields in upload options', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  await assert.rejects(
    bridge.upload({ ...baseInput(), untrusted_field: '/bin/sh', shell_cmd: 'whoami' }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );
});

test('12. recovery validation: rejects apiKey, buffer, or invalid taskId', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  // apiKey passed to recovery
  await assert.rejects(
    bridge.recover({ taskId: 'valid_id', baseUrl: 'https://api.powertokens.ai', apiKey: 'leaked_key' }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );

  // buffer passed to recovery
  await assert.rejects(
    bridge.recover({ taskId: 'valid_id', baseUrl: 'https://api.powertokens.ai', buffer: sampleBuffer() }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );

  // invalid taskId format (path traversal)
  await assert.rejects(
    bridge.recover({ taskId: '../malicious_task', baseUrl: 'https://api.powertokens.ai' }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );
});

test('13. pre-spawn configuration checks: non-existent paths fail before spawn', () => {
  assert.throws(
    () => createPtAssetUploadBridge({ pythonBinary: '/nonexistent/python3', workerPath: WORKER_PATH }),
    { code: 'ASSET_BRIDGE_CONFIGURATION_INVALID' },
  );

  assert.throws(
    () => createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: '/nonexistent/worker.py' }),
    { code: 'ASSET_BRIDGE_CONFIGURATION_INVALID' },
  );
});

// --------------------------------------------------------------------------
// 4. Watchdog, Cancellation & Crash Recovery
// --------------------------------------------------------------------------

test('14. watchdog timeout forcibly terminates hung worker via SIGTERM/SIGKILL', async () => {
  const hungCode = `
import time, json, signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(json.dumps({'version':1,'type':'ready'}), flush=True)
time.sleep(30)
`;
  const bridge = rogueBridge(hungCode);
  const input = baseInput();
  input.timeoutMs = 150;
  input.killGraceMs = 50;

  const start = Date.now();
  await assert.rejects(bridge.upload(input), (err) => {
    assert.equal(err.code, 'ASSET_ENGINE_TIMEOUT');
    assert.equal(err.mayResubmit, false);
    return true;
  });
  assert.ok(Date.now() - start < 1500, 'Teardown must be swift');
});

test('15. cancellation before spawn fails closed immediately', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });
  const input = baseInput();
  input.signal = AbortSignal.abort();

  await assert.rejects(bridge.upload(input), { code: 'ASSET_ENGINE_CANCELLED' });
});

test('16. worker crash after submission_started preserves submissionMayHaveStarted: true', async () => {
  const crashAfterSubmissionCode = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'submission_started','payload':{}}), flush=True)
sys.stdin.readline()
sys.exit(137)  # SIGKILL simulation
`;
  const bridge = rogueBridge(crashAfterSubmissionCode);
  await assert.rejects(bridge.upload(baseInput()), (err) => {
    assert.equal(err.code, 'ASSET_ENGINE_EXIT_WITHOUT_RESULT');
    assert.equal(err.submissionMayHaveStarted, true, 'Must preserve possible submission on crash');
    assert.equal(err.mayResubmit, false);
    return true;
  });
});

test('17. worker crash after on_task_id preserves known taskId and submission status', async () => {
  const crashAfterTaskIdCode = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'submission_started','payload':{}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':3,'event':'on_task_id','payload':{'taskId':'task_retained_999'}}), flush=True)
sys.stdin.readline()
sys.exit(1)
`;
  const bridge = rogueBridge(crashAfterTaskIdCode);
  await assert.rejects(bridge.upload(baseInput()), (err) => {
    assert.equal(err.taskId, 'task_retained_999');
    assert.equal(err.submissionMayHaveStarted, true);
    assert.equal(err.mayResubmit, false);
    return true;
  });
});

// --------------------------------------------------------------------------
// 5. Rogue Worker Protocol Violations & Stream Bounding
// --------------------------------------------------------------------------

test('18. unsolicited success done frame rejected without required hooks', async () => {
  const rogueSuccess = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'done','requestId':req['requestId'],'result':{'ok':True,'outcome':'succeeded'}}), flush=True)
`;
  const bridge = rogueBridge(rogueSuccess);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
    submissionMayHaveStarted: false,
  });
});

test('19. out-of-order event sequence rejected', async () => {
  const outOfOrder = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
# Jump eventId from 1 directly to 3
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':3,'event':'on_task_id','payload':{'taskId':'t1'}}), flush=True)
`;
  const bridge = rogueBridge(outOfOrder);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
  });
});

test('20. oversized worker stdout line rejected before unbounded JSON.parse', async () => {
  const floodStdout = `
import sys
sys.stdout.write('x' * 300000 + '\\n')
sys.stdout.flush()
`;
  const bridge = rogueBridge(floodStdout);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_STDOUT_LIMIT',
  });
});

test('21. oversized worker stderr stream rejected', async () => {
  const floodStderr = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
sys.stderr.write('e' * 100000)
sys.stderr.flush()
`;
  const bridge = rogueBridge(floodStderr);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_STDERR_LIMIT',
  });
});

test('22. PRIVATE_SENTINEL in credentials or errors never leaked', async () => {
  const SENTINEL = 'PRIVATE_SENTINEL_TOKEN_44556677';
  const bridge = rogueBridge(`
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
# Echo sentinel back as error
print(json.dumps({'version':1,'type':'error','requestId':req['requestId'],'code':'ERR_' + req['apiKey']}), flush=True)
`);

  const input = baseInput();
  input.apiKey = SENTINEL;

  try {
    await bridge.upload(input);
    assert.fail('Should have failed');
  } catch (err) {
    assert.equal(err.code, 'ASSET_ENGINE_FAILED');
    assert.ok(!err.message.includes(SENTINEL), 'Error message must not leak sentinel');
    assert.ok(!JSON.stringify(err).includes(SENTINEL), 'Error object must not leak sentinel');
  }
});
