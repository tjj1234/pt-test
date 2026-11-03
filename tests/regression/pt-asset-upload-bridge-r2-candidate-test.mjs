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
  ASSET_ID_RE,
  MAX_INITIAL_FRAME,
  MAX_EVENT_FRAME,
  MAX_TOTAL_STDOUT,
  MAX_TOTAL_STDERR,
  MAX_ASSET_BYTES,
} = require('../../shell/media/pt-asset-upload-bridge-r2-candidate.cjs');

const ROOT = path.resolve('.');
const VENDOR_ENGINE = path.join(ROOT, 'shell/media/vendor/powertokens_video/pt_video.py');
const PATCH_1 = path.join(ROOT, 'docs/refactor/candidates/pt-asset-upload-product-20261029.patch');
const PATCH_2 = path.join(ROOT, 'docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch');
const WORKER_PATH = path.join(ROOT, 'shell/media/pt-asset-upload-worker-r2-candidate.py');
const PYTHON_BIN = '/usr/bin/python3';

const EXPECTED_POST_URL = 'https://powertokens.ai/api/v1/asset/upload';
const EXPECTED_GET_PREFIX = 'https://powertokens.ai/api/v1/asset/jobs/get-asset-id?task_id=';

// Helper to prepare isolated patched engine in a temp dir
function setupPatchedEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-asset-r2-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const engineFile = path.join(dir, 'pt_video.py');
  fs.copyFileSync(VENDOR_ENGINE, engineFile);

  const baselineSha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(baselineSha, '91c2b0e63bbfe89e5ab821af17cf41f5e19e2cdccc9475a094f2b3b7d323d3a6');

  // Apply Patch 1
  const { execFileSync } = require('node:child_process');
  execFileSync('patch', ['-p1', '-i', PATCH_1], { cwd: dir, stdio: 'pipe' });
  const p1Sha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(p1Sha, 'b42d73c69ce20d9ffb9ce8ed83344db82662947b4cd1bc70ebfbaf74dc48d05c');

  // Apply Patch 2
  execFileSync('patch', ['-p1', '-i', PATCH_2], { cwd: dir, stdio: 'pipe' });
  const p2Sha = crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex');
  assert.equal(p2Sha, '978dddfbcee230f62a3945a2c8c9491669e694c0a829ab126ef5582c0a99cc4c');

  return engineFile;
}

// Python fixture script that intercepts network and asserts exact vendored URLs
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
    url = req.full_url
    with open(calls_log, 'a') as f:
        f.write(json.dumps({'method': method, 'url': url}) + '\\n')
    if method == 'POST':
        return MockHTTPResponse(b'{"code":200,"data":{"task_id":"task_fixture_r2_101"}}')
    return MockHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_fixture_r2_202"}}')

w.run(transport=transport, engine_path=engine_path)
`;

function setupIntegrationBridge(t) {
  const engineFile = setupPatchedEngine(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-asset-r2-calls-'));
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

  function readCalls() {
    if (!fs.existsSync(callsFile)) return [];
    return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  return {
    bridge,
    calls: readCalls,
    options: () => lastSpawnOptions,
  };
}

function rogueBridge(pythonCode) {
  return createPtAssetUploadBridge({
    pythonBinary: PYTHON_BIN,
    workerPath: WORKER_PATH,
    spawnImpl: (binary, args, options) => spawn(binary, ['-I', '-B', '-c', pythonCode], options),
  });
}

const sampleBuffer = () => Buffer.from('fake-png-image-binary-data-for-r2-testing');
const baseInput = () => ({
  buffer: sampleBuffer(),
  filename: 'reference.png',
  apiKey: 'offline-fixture-key-r2-1234',
  timeoutMs: 5000,
  onBeforeSubmit: async () => {},
  onSubmissionStarted: async () => {},
  onTaskId: async () => {},
  onAssetId: async () => {},
});

// --------------------------------------------------------------------------
// 1. Fixed Vendored URLs & R1 Regressions
// --------------------------------------------------------------------------

test('1. upload directly asserts fixed vendored full URLs (POST and GET)', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();

  const receipt = await f.bridge.upload(input);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.taskId, 'task_fixture_r2_101');
  assert.equal(receipt.assetId, 'asset_fixture_r2_202');
  assert.equal(receipt.mayResubmit, false);

  const calls = f.calls();
  assert.equal(calls.length, 2);

  // Exact vendored POST URL assertion
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, EXPECTED_POST_URL, 'POST endpoint must strictly match vendored ASSET_UPLOAD');

  // Exact vendored GET URL assertion
  assert.equal(calls[1].method, 'GET');
  assert.ok(
    calls[1].url.startsWith(EXPECTED_GET_PREFIX),
    `GET endpoint must strictly start with vendored ASSET_GET_ID: ${calls[1].url}`,
  );
  assert.ok(calls[1].url.includes('task_fixture_r2_101'));
});

test('2. recover directly asserts fixed vendored full URL and GET-only', async (t) => {
  const f = setupIntegrationBridge(t);

  const receipt = await f.bridge.recover({
    taskId: 'task_recovered_fixed_url_555',
    onAssetId: async () => {},
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.mayResubmit, false);

  const calls = f.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.ok(
    calls[0].url.startsWith(EXPECTED_GET_PREFIX),
    `Recovery GET endpoint must strictly start with vendored ASSET_GET_ID: ${calls[0].url}`,
  );
  assert.ok(calls[0].url.includes('task_recovered_fixed_url_555'));
});

test('3. baseUrl in upload or recover rejected before spawn with 0 POST and 0 Key sent', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  // Attacker URL in upload
  await assert.rejects(
    bridge.upload({ ...baseInput(), baseUrl: 'https://attacker.example.test' }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
    'baseUrl parameter in upload must be rejected immediately',
  );

  // Attacker URL in recover
  await assert.rejects(
    bridge.recover({ taskId: 't1', baseUrl: 'https://attacker.example.test' }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
    'baseUrl parameter in recover must be rejected immediately',
  );
});

// --------------------------------------------------------------------------
// 2. Strict State Machine Sequencing & Protocol Gate
// --------------------------------------------------------------------------

test('4. on_task_id without submission_started confirmed is rejected', async () => {
  const rogueCode = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
# Jump directly from before_submit to on_task_id without submission_started!
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{'byte_count':len('fake-png-image-binary-data-for-r2-testing'),'sha256':'` + crypto.createHash('sha256').update(sampleBuffer()).digest('hex') + `','filename':'reference.png'}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'on_task_id','payload':{'taskId':'t1'}}), flush=True)
`;
  const bridge = rogueBridge(rogueCode);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
  });
});

test('5. on_asset_id without on_task_id confirmed in upload is rejected', async () => {
  const rogueCode = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{'byte_count':len('fake-png-image-binary-data-for-r2-testing'),'sha256':'` + crypto.createHash('sha256').update(sampleBuffer()).digest('hex') + `','filename':'reference.png'}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'submission_started','payload':{}}), flush=True)
sys.stdin.readline()
# Emits on_asset_id without on_task_id!
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':3,'event':'on_asset_id','payload':{'assetId':'a1'}}), flush=True)
`;
  const bridge = rogueBridge(rogueCode);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
  });
});

test('6. malicious or invalid characters in assetId are rejected', async () => {
  const rogueBadAssetId = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'on_asset_id','payload':{'assetId':'malicious:id/with/slashes'}}), flush=True)
`;
  const bridge = rogueBridge(rogueBadAssetId);
  await assert.rejects(
    bridge.recover({ taskId: 'valid_task' }),
    { code: 'ASSET_ENGINE_PROTOCOL_INVALID' },
    'assetId with slashes or colons must be rejected',
  );
});

test('7. tampered byte_count or sha256 in before_submit rejected', async () => {
  const rogueTamperedMeta = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
# Tampered sha256
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{'byte_count':100,'sha256':'forged_hash','filename':'reference.png'}}), flush=True)
`;
  const bridge = rogueBridge(rogueTamperedMeta);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
  });
});

test('8. forged done receipt mismatching host confirmed state is rejected', async () => {
  const rogueForgedDone = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
sha = '` + crypto.createHash('sha256').update(sampleBuffer()).digest('hex') + `'
bcount = len('fake-png-image-binary-data-for-r2-testing')
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{'byte_count':bcount,'sha256':sha,'filename':'reference.png'}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'submission_started','payload':{}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':3,'event':'on_task_id','payload':{'taskId':'task_real'}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':4,'event':'on_asset_id','payload':{'assetId':'asset_real'}}), flush=True)
sys.stdin.readline()
# done frame forged with different asset_id and sha
print(json.dumps({'version':1,'type':'done','requestId':req['requestId'],'result':{'ok':True,'outcome':'succeeded','task_id':'task_real','asset_id':'asset_forged','byte_count':bcount,'sha256':'forged_sha','may_resubmit':False}}), flush=True)
`;
  const bridge = rogueBridge(rogueForgedDone);
  await assert.rejects(bridge.upload(baseInput()), {
    code: 'ASSET_ENGINE_PROTOCOL_INVALID',
  });
});

// --------------------------------------------------------------------------
// 3. Subprocess Lifecycle & Watchdog Timing (Promise does NOT settle before close)
// --------------------------------------------------------------------------

test('9. cancellation and timeout do NOT settle Promise before child close (SIGKILL <= 2s)', async () => {
  const slowExitCode = `
import time, json, signal, sys
def on_term(s, f):
    # Ignores SIGTERM, only dies on SIGKILL
    pass
signal.signal(signal.SIGTERM, on_term)
print(json.dumps({'version':1,'type':'ready'}), flush=True)
time.sleep(30)
`;
  const bridge = rogueBridge(slowExitCode);
  const input = baseInput();
  input.timeoutMs = 100;
  input.killGraceMs = 300; // 300ms grace before SIGKILL

  let promiseSettled = false;
  const start = Date.now();

  const promise = bridge.upload(input);
  promise.catch(() => {
    promiseSettled = true;
  });

  // Verify that at 150ms (before killGraceMs expires), promise has NOT settled yet!
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(promiseSettled, false, 'Promise must not settle while child process is still alive');

  // Await final rejection
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'ASSET_ENGINE_TIMEOUT');
    assert.equal(err.mayResubmit, false);
    return true;
  });

  const duration = Date.now() - start;
  assert.ok(duration >= 350, `Expected duration >= 350ms, got ${duration}ms`);
  assert.ok(duration <= 2500, `Expected duration <= 2500ms, got ${duration}ms`);
});

// --------------------------------------------------------------------------
// 4. Pre-spawn Filesystem Security Checks
// --------------------------------------------------------------------------

test('10. configuration checks: non-regular file or symlink worker rejected', () => {
  // Directory instead of file
  assert.throws(
    () => createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: ROOT }),
    { code: 'ASSET_BRIDGE_CONFIGURATION_INVALID' },
  );

  // Symlink check
  const tmpSymlink = path.join(os.tmpdir(), `symlink-worker-${Date.now()}.py`);
  try {
    fs.symlinkSync(WORKER_PATH, tmpSymlink);
    assert.throws(
      () => createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: tmpSymlink }),
      { code: 'ASSET_BRIDGE_CONFIGURATION_INVALID' },
      'Symlinked worker path must be strictly rejected',
    );
  } finally {
    try { fs.unlinkSync(tmpSymlink); } catch {}
  }
});

// --------------------------------------------------------------------------
// 5. Hook Refusals & Pre-send Failures (Zero POST)
// --------------------------------------------------------------------------

test('11. refusal at onBeforeSubmit yields 0 POST', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onBeforeSubmit = async () => {
    throw new Error('Refused at gate');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'not_submitted');
  assert.equal(receipt.submissionMayHaveStarted, false);
  assert.deepEqual(f.calls(), []);
});

test('12. refusal at onSubmissionStarted yields 0 POST', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onSubmissionStarted = async () => {
    throw new Error('Refused at intent');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'not_submitted');
  assert.deepEqual(f.calls(), []);
});

test('13. refusal at onTaskId retains taskId without GET', async (t) => {
  const f = setupIntegrationBridge(t);
  const input = baseInput();
  input.onTaskId = async () => {
    throw new Error('taskId write failed');
  };

  const receipt = await f.bridge.upload(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, 'task_id_persisting_failed');
  assert.equal(receipt.taskId, 'task_fixture_r2_101');
  assert.equal(receipt.submissionMayHaveStarted, true);
  assert.equal(receipt.mayResubmit, false);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0].method, 'POST');
});

test('14. crash after submission_started preserves submissionMayHaveStarted: true', async () => {
  const crashAfterSubmissionCode = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
sha = '` + crypto.createHash('sha256').update(sampleBuffer()).digest('hex') + `'
bcount = len('fake-png-image-binary-data-for-r2-testing')
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':1,'event':'before_submit','payload':{'byte_count':bcount,'sha256':sha,'filename':'reference.png'}}), flush=True)
sys.stdin.readline()
print(json.dumps({'version':1,'type':'event','requestId':req['requestId'],'eventId':2,'event':'submission_started','payload':{}}), flush=True)
sys.stdin.readline()
sys.exit(137)
`;
  const bridge = rogueBridge(crashAfterSubmissionCode);
  await assert.rejects(bridge.upload(baseInput()), (err) => {
    assert.equal(err.code, 'ASSET_ENGINE_EXIT_WITHOUT_RESULT');
    assert.equal(err.submissionMayHaveStarted, true, 'submissionMayHaveStarted must be preserved');
    assert.equal(err.mayResubmit, false);
    return true;
  });
});

test('15. buffer boundary limits: 0 bytes and > 5 MiB rejected before spawn', async () => {
  const bridge = createPtAssetUploadBridge({ pythonBinary: PYTHON_BIN, workerPath: WORKER_PATH });

  await assert.rejects(
    bridge.upload({ ...baseInput(), buffer: Buffer.alloc(0) }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );

  await assert.rejects(
    bridge.upload({ ...baseInput(), buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    { code: 'ASSET_BRIDGE_INPUT_INVALID' },
  );
});

test('16. stream bounding: oversized stdout line and oversized stderr rejected', async () => {
  const floodStdout = `
import sys
sys.stdout.write('x' * 300000 + '\\n')
sys.stdout.flush()
`;
  const bridge1 = rogueBridge(floodStdout);
  await assert.rejects(bridge1.upload(baseInput()), {
    code: 'ASSET_ENGINE_STDOUT_LIMIT',
  });

  const floodStderr = `
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
sys.stderr.write('e' * 100000)
sys.stderr.flush()
`;
  const bridge2 = rogueBridge(floodStderr);
  await assert.rejects(bridge2.upload(baseInput()), {
    code: 'ASSET_ENGINE_STDERR_LIMIT',
  });
});

test('17. PRIVATE_SENTINEL in credentials or errors never leaked', async () => {
  const SENTINEL = 'PRIVATE_SENTINEL_TOKEN_R2_SECRET_998877';
  const bridge = rogueBridge(`
import sys, json
print(json.dumps({'version':1,'type':'ready'}), flush=True)
req = json.loads(sys.stdin.readline())
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
