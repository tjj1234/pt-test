'use strict';
// Trusted host-only process boundary for product asset upload and recovery (R2 Candidate).
// Features:
// - Fixed vendored asset endpoints (no caller baseUrl, prevents URL hijacking).
// - Pre-spawn filesystem security checks (regular file, no symlink, not world-writable).
// - Strict state machine sequencing (before -> started -> task -> asset -> done).
// - Deep verification of done receipts against host-acknowledged state and hash.
// - Asynchronous teardown: Promise does NOT settle until child process actually closes.
// - Invariant mayResubmit: false across all outcomes.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WORKER_PATH = path.join(__dirname, 'pt-asset-upload-worker-r2-candidate.py');
const DEFAULT_ENGINE_PATH = path.join(__dirname, 'vendor/powertokens_video/pt_video_product.py');
const MAX_INITIAL_FRAME = 8 * 1024 * 1024; // 8 MiB (for <= 5 MiB base64 image + envelope)
const MAX_EVENT_FRAME = 128 * 1024;        // 128 KiB
const MAX_TOTAL_STDOUT = 1024 * 1024;      // 1 MiB
const MAX_TOTAL_STDERR = 64 * 1024;        // 64 KiB
const MAX_FRAMES = 16;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;   // 5 MiB

const ASSET_SAFE_FILENAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ASSET_TASK_ID_RE = /^[a-zA-Z0-9_.:-]{1,256}$/;
const ASSET_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;

const UPLOAD_ALLOWED_KEYS = new Set([
  'buffer',
  'content',
  'filename',
  'apiKey',
  'onBeforeSubmit',
  'onSubmissionStarted',
  'onTaskId',
  'onAssetId',
  'signal',
  'timeoutMs',
  'killGraceMs',
  'pollTimeout',
]);

const RECOVER_ALLOWED_KEYS = new Set([
  'taskId',
  'onAssetId',
  'signal',
  'timeoutMs',
  'killGraceMs',
  'pollTimeout',
]);

function failure(code, state = {}) {
  const err = new Error(code);
  err.code = code;
  err.taskId = state.taskId || null;
  err.assetId = state.assetId || null;
  err.submissionMayHaveStarted = state.submissionMayHaveStarted === true;
  err.mayResubmit = false;
  return err;
}

function validateTrustedExecutableFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw failure('ASSET_BRIDGE_CONFIGURATION_INVALID');
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw failure('ASSET_BRIDGE_CONFIGURATION_INVALID');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (uid !== null && stat.uid !== uid && stat.uid !== 0)) {
    throw failure('ASSET_BRIDGE_CONFIGURATION_INVALID');
  }
}

function createPtAssetUploadBridge({
  pythonBinary = '/usr/bin/python3',
  workerPath = DEFAULT_WORKER_PATH,
  enginePath = DEFAULT_ENGINE_PATH,
  spawnImpl = spawn,
} = {}) {
  if (typeof spawnImpl !== 'function') {
    throw failure('ASSET_BRIDGE_CONFIGURATION_INVALID');
  }
  validateTrustedExecutableFile(pythonBinary);
  validateTrustedExecutableFile(workerPath);
  if (enginePath !== null) {
    validateTrustedExecutableFile(enginePath);
  }

  function runSubprocess({ actionType, requestFrame, state, timeoutMs, killGraceMs, signal, hookHandlers }) {
    return new Promise((resolve, reject) => {
      let child;
      let closed = false;
      let settled = false;
      let stopping = false;
      let terminationError = null;
      let ready = false;
      let done = false;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let stdoutBytes = 0;
      let frames = 0;
      let eventId = 0;
      let normalizedReceipt = null;
      let queue = Promise.resolve();
      let killTimer = null;

      const timeoutTimer = setTimeout(() => stop('ASSET_ENGINE_TIMEOUT'), timeoutMs);
      const abortHandler = () => stop('ASSET_ENGINE_CANCELLED');

      function cleanup() {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abortHandler);
      }

      function stop(code) {
        if (stopping) return;
        stopping = true;
        terminationError = failure(code, state);
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', abortHandler);

        if (child && !closed) {
          try {
            child.stdin.end();
            child.kill('SIGTERM');
          } catch {}

          const grace = Math.min(2000, Math.max(10, killGraceMs));
          killTimer = setTimeout(() => {
            if (!closed) {
              try { child.kill('SIGKILL'); } catch {}
            }
          }, grace);
          killTimer.unref?.();
          // DO NOT reject here! We must wait for child.once('close')
        } else if (closed && !settled) {
          settled = true;
          cleanup();
          reject(terminationError);
        }
      }

      function write(frame) {
        if (!stopping && !settled && !closed) {
          child.stdin.write(JSON.stringify(frame) + '\n');
        }
      }

      async function receive(frame) {
        if (stopping || settled) return;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.version !== 1 || done) {
          return stop('ASSET_ENGINE_PROTOCOL_INVALID');
        }

        if (frame.type === 'ready') {
          if (ready || Object.keys(frame).length !== 2) {
            return stop('ASSET_ENGINE_PROTOCOL_INVALID');
          }
          ready = true;
          child.stdin.write(requestFrame);
          return;
        }

        if (!ready || frame.requestId !== state.requestId) {
          return stop('ASSET_ENGINE_PROTOCOL_INVALID');
        }

        if (frame.type === 'error') {
          return stop('ASSET_ENGINE_FAILED');
        }

        if (frame.type === 'done') {
          const res = frame.result;
          if (!res || typeof res !== 'object' || Array.isArray(res)) {
            return stop('ASSET_ENGINE_RESULT_INVALID');
          }

          if (res.ok === true) {
            if (actionType === 'upload') {
              if (
                !state.beforeSubmitDone ||
                !state.submissionStartedDone ||
                !state.taskId ||
                !state.assetId ||
                res.outcome !== 'succeeded' ||
                res.task_id !== state.taskId ||
                res.asset_id !== state.assetId ||
                res.byte_count !== state.byteCount ||
                res.sha256 !== state.sha256Hex ||
                res.may_resubmit !== false
              ) {
                return stop('ASSET_ENGINE_PROTOCOL_INVALID');
              }
            } else if (actionType === 'recover') {
              if (
                !state.assetId ||
                res.outcome !== 'succeeded' ||
                res.task_id !== state.taskId ||
                res.asset_id !== state.assetId ||
                res.may_resubmit !== false
              ) {
                return stop('ASSET_ENGINE_PROTOCOL_INVALID');
              }
            }
          } else {
            // Failure state
            if (res.outcome === 'succeeded' || res.may_resubmit !== false) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            if (state.taskId && res.task_id && res.task_id !== state.taskId) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
          }

          normalizedReceipt = Object.freeze({
            ok: Boolean(res.ok),
            outcome: String(res.outcome || 'unknown'),
            taskId: typeof res.task_id === 'string' && res.task_id ? res.task_id : (state.taskId || null),
            assetId: typeof res.asset_id === 'string' && res.asset_id ? res.asset_id : (state.assetId || null),
            byteCount: typeof res.byte_count === 'number' ? res.byte_count : state.byteCount,
            sha256Hex: typeof res.sha256 === 'string' ? res.sha256 : state.sha256Hex,
            submissionMayHaveStarted: Boolean(res.submission_may_have_started || state.submissionMayHaveStarted),
            mayResubmit: false, // Invariant across all outcomes
            errorCode: res.error_code || null,
          });
          done = true;
          child.stdin.end();
          return;
        }

        if (frame.type !== 'event' || frame.eventId !== eventId + 1) {
          return stop('ASSET_ENGINE_PROTOCOL_INVALID');
        }
        eventId = frame.eventId;
        const ack = { version: 1, type: 'ack', requestId: state.requestId, eventId, ok: true };

        try {
          if (frame.event === 'before_submit') {
            if (
              actionType !== 'upload' ||
              state.beforeSubmitDone ||
              state.submissionStartedDone ||
              state.submissionMayHaveStarted ||
              state.taskId !== null ||
              state.assetId !== null
            ) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            const p = frame.payload;
            if (
              !p ||
              p.byte_count !== state.byteCount ||
              p.sha256 !== state.sha256Hex ||
              p.filename !== state.filename
            ) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.beforeSubmitDone = true;
            await hookHandlers.onBeforeSubmit(structuredClone(p));
            if (stopping || settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'submission_started') {
            if (
              actionType !== 'upload' ||
              !state.beforeSubmitDone ||
              state.submissionStartedDone ||
              state.taskId !== null ||
              state.assetId !== null
            ) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            await hookHandlers.onSubmissionStarted();
            state.submissionStartedDone = true;
            state.submissionMayHaveStarted = true;
            if (stopping || settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'on_task_id') {
            if (
              actionType !== 'upload' ||
              !state.submissionStartedDone ||
              state.taskId !== null ||
              state.assetId !== null
            ) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            const tid = frame.payload?.taskId;
            if (!tid || typeof tid !== 'string' || !ASSET_TASK_ID_RE.test(tid) || tid.includes('..')) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            if (state.apiKey && tid.includes(state.apiKey)) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.taskId = tid;
            await hookHandlers.onTaskId({ taskId: state.taskId });
            if (stopping || settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'on_asset_id') {
            if (actionType === 'upload') {
              if (state.taskId === null || state.assetId !== null) {
                return stop('ASSET_ENGINE_PROTOCOL_INVALID');
              }
            } else if (actionType === 'recover') {
              if (state.assetId !== null) {
                return stop('ASSET_ENGINE_PROTOCOL_INVALID');
              }
            }
            const aid = frame.payload?.assetId;
            if (!aid || typeof aid !== 'string' || !ASSET_ID_RE.test(aid)) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.assetId = aid;
            await hookHandlers.onAssetId({ assetId: state.assetId, taskId: state.taskId });
            if (stopping || settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else {
            return stop('ASSET_ENGINE_PROTOCOL_INVALID');
          }
        } catch {
          ack.ok = false;
        }

        write(ack);
      }

      try {
        const env = {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
        };
        if (enginePath) {
          env.PT_ASSET_UPLOAD_ENGINE_PATH = enginePath;
        }

        child = spawnImpl(pythonBinary, ['-I', '-B', workerPath], {
          cwd: path.dirname(workerPath),
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });

        child.stdin.on('error', () => {
          if (!done) stop('ASSET_ENGINE_PIPE_FAILED');
        });

        child.on('error', () => stop('ASSET_ENGINE_START_FAILED'));

        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_TOTAL_STDERR) {
            stop('ASSET_ENGINE_STDERR_LIMIT');
          }
        });

        child.stdout.on('data', (chunk) => {
          if (stopping || settled) return;
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_TOTAL_STDOUT || stdout.length + chunk.length > MAX_EVENT_FRAME * 2) {
            return stop('ASSET_ENGINE_STDOUT_LIMIT');
          }
          stdout = Buffer.concat([stdout, chunk]);
          let newlineIdx;
          while ((newlineIdx = stdout.indexOf(10)) !== -1) {
            if (newlineIdx + 1 > MAX_EVENT_FRAME) {
              return stop('ASSET_ENGINE_STDOUT_LIMIT');
            }
            if (++frames > MAX_FRAMES) {
              return stop('ASSET_ENGINE_STDOUT_LIMIT');
            }
            const line = stdout.subarray(0, newlineIdx).toString('utf8');
            stdout = stdout.subarray(newlineIdx + 1);
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            queue = queue.then(() => receive(frame)).catch(() => stop('ASSET_ENGINE_RESULT_INVALID'));
          }
          if (stdout.length > MAX_EVENT_FRAME) {
            stop('ASSET_ENGINE_STDOUT_LIMIT');
          }
        });

        child.once('close', (code) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(timeoutTimer);
          signal?.removeEventListener('abort', abortHandler);

          queue.then(() => {
            if (settled) return;
            settled = true;
            cleanup();

            if (stopping || terminationError) {
              reject(terminationError);
              return;
            }

            if (code !== 0 || !done || stdout.length) {
              reject(failure('ASSET_ENGINE_EXIT_WITHOUT_RESULT', state));
              return;
            }

            resolve(normalizedReceipt);
          }).catch(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(failure('ASSET_ENGINE_RESULT_INVALID', state));
            }
          });
        });

        signal?.addEventListener('abort', abortHandler, { once: true });
        if (signal?.aborted) abortHandler();
      } catch {
        stop('ASSET_ENGINE_START_FAILED');
      }
    });
  }

  async function upload({
    buffer,
    content,
    filename = 'reference.png',
    apiKey,
    onBeforeSubmit = async () => {},
    onSubmissionStarted = async () => {},
    onTaskId = async () => {},
    onAssetId = async () => {},
    signal,
    timeoutMs = 120000,
    killGraceMs = 250,
    pollTimeout = 120,
    ...extra
  } = {}) {
    // R2 SECURITY: baseUrl is strictly FORBIDDEN in upload options!
    if (Object.keys(extra).length > 0 || extra.baseUrl !== undefined) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    const payloadBuffer = buffer || content;
    if (
      !payloadBuffer ||
      !(Buffer.isBuffer(payloadBuffer) || payloadBuffer instanceof Uint8Array) ||
      payloadBuffer.length < 1 ||
      payloadBuffer.length > MAX_ASSET_BYTES
    ) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (
      typeof filename !== 'string' ||
      !ASSET_SAFE_FILENAME_RE.test(filename) ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(apiKey)) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 3600000 ||
      !Number.isSafeInteger(killGraceMs) ||
      killGraceMs < 10 ||
      killGraceMs > 2000 ||
      typeof onBeforeSubmit !== 'function' ||
      typeof onSubmissionStarted !== 'function' ||
      typeof onTaskId !== 'function' ||
      typeof onAssetId !== 'function'
    ) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (signal?.aborted) {
      throw failure('ASSET_ENGINE_CANCELLED');
    }

    const sha256Hex = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
    const byteCount = payloadBuffer.length;
    const contentBase64 = Buffer.from(payloadBuffer).toString('base64');
    const requestId = crypto.randomUUID();

    const requestPayload = {
      version: 1,
      type: 'upload',
      requestId,
      apiKey,
      filename,
      contentBase64,
      pollTimeout: Math.min(120, Math.max(1, typeof pollTimeout === 'number' && Number.isFinite(pollTimeout) ? pollTimeout : timeoutMs / 1000)),
    };

    const requestFrame = JSON.stringify(requestPayload) + '\n';
    if (Buffer.byteLength(requestFrame) > MAX_INITIAL_FRAME) {
      throw failure('ASSET_BRIDGE_INPUT_LIMIT');
    }

    const state = {
      requestId,
      apiKey,
      taskId: null,
      assetId: null,
      byteCount,
      sha256Hex,
      filename,
      submissionMayHaveStarted: false,
      beforeSubmitDone: false,
      submissionStartedDone: false,
    };

    return runSubprocess({
      actionType: 'upload',
      requestFrame,
      state,
      timeoutMs,
      killGraceMs,
      signal,
      hookHandlers: { onBeforeSubmit, onSubmissionStarted, onTaskId, onAssetId },
    });
  }

  async function recover({
    taskId,
    onAssetId = async () => {},
    signal,
    timeoutMs = 120000,
    killGraceMs = 250,
    pollTimeout = 120,
    ...extra
  } = {}) {
    // R2 SECURITY: baseUrl, apiKey, buffer, content, filename are strictly FORBIDDEN!
    if (
      Object.keys(extra).length > 0 ||
      extra.baseUrl !== undefined ||
      extra.apiKey !== undefined ||
      extra.buffer !== undefined ||
      extra.content !== undefined ||
      extra.filename !== undefined
    ) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (typeof taskId !== 'string' || !ASSET_TASK_ID_RE.test(taskId) || taskId.includes('..')) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 3600000 ||
      !Number.isSafeInteger(killGraceMs) ||
      killGraceMs < 10 ||
      killGraceMs > 2000 ||
      typeof onAssetId !== 'function'
    ) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    if (signal?.aborted) {
      throw failure('ASSET_ENGINE_CANCELLED');
    }

    const requestId = crypto.randomUUID();
    const requestPayload = {
      version: 1,
      type: 'recover',
      requestId,
      taskId,
      pollTimeout: Math.min(120, Math.max(1, typeof pollTimeout === 'number' && Number.isFinite(pollTimeout) ? pollTimeout : timeoutMs / 1000)),
    };

    const requestFrame = JSON.stringify(requestPayload) + '\n';
    if (Buffer.byteLength(requestFrame) > MAX_EVENT_FRAME) {
      throw failure('ASSET_BRIDGE_INPUT_LIMIT');
    }

    const state = {
      requestId,
      apiKey: null,
      taskId,
      assetId: null,
      byteCount: 0,
      sha256Hex: '',
      filename: null,
      submissionMayHaveStarted: true, // Recovery operates on already submitted task
      beforeSubmitDone: true,
      submissionStartedDone: true,
    };

    return runSubprocess({
      actionType: 'recover',
      requestFrame,
      state,
      timeoutMs,
      killGraceMs,
      signal,
      hookHandlers: { onAssetId },
    });
  }

  const bridge = function (options) {
    if (options && options.action === 'recover') {
      return recover(options);
    }
    return upload(options);
  };

  bridge.upload = upload;
  bridge.recover = recover;
  bridge.execute = bridge;

  return bridge;
}

module.exports = {
  createPtAssetUploadBridge,
  ASSET_SAFE_FILENAME_RE,
  ASSET_TASK_ID_RE,
  ASSET_ID_RE,
  MAX_INITIAL_FRAME,
  MAX_EVENT_FRAME,
  MAX_TOTAL_STDOUT,
  MAX_TOTAL_STDERR,
  MAX_ASSET_BYTES,
};
