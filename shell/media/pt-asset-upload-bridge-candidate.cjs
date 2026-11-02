'use strict';
// Trusted host-only process boundary for product asset upload and recovery.
// This module manages subprocess isolation, one-shot stdin credentials,
// durable hook acknowledgments, bounded IO buffers, and watchdog teardowns.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WORKER_PATH = path.join(__dirname, 'pt-asset-upload-worker-candidate.py');
const MAX_INITIAL_FRAME = 8 * 1024 * 1024; // 8 MiB (for <= 5 MiB base64 image + envelope)
const MAX_EVENT_FRAME = 128 * 1024;        // 128 KiB
const MAX_TOTAL_STDOUT = 1024 * 1024;      // 1 MiB
const MAX_TOTAL_STDERR = 64 * 1024;        // 64 KiB
const MAX_FRAMES = 16;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;   // 5 MiB

const ASSET_SAFE_FILENAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ASSET_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

const UPLOAD_ALLOWED_KEYS = new Set([
  'buffer',
  'content',
  'filename',
  'apiKey',
  'baseUrl',
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
  'baseUrl',
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

function parseAndValidateBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || /[\s\x00-\x1f\x7f]/.test(baseUrl) || baseUrl.split('/')[2]?.includes('@')) {
    throw failure('ASSET_BRIDGE_GATEWAY_INVALID');
  }
  let gateway;
  try {
    gateway = new URL(baseUrl);
  } catch {
    throw failure('ASSET_BRIDGE_GATEWAY_INVALID');
  }
  if (
    gateway.protocol !== 'https:' ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    !['', '/'].includes(gateway.pathname)
  ) {
    throw failure('ASSET_BRIDGE_GATEWAY_INVALID');
  }
  return gateway;
}

function createPtAssetUploadBridge({
  pythonBinary = '/usr/bin/python3',
  workerPath = DEFAULT_WORKER_PATH,
  enginePath = null,
  spawnImpl = spawn,
} = {}) {
  if (
    typeof spawnImpl !== 'function' ||
    typeof pythonBinary !== 'string' ||
    !path.isAbsolute(pythonBinary) ||
    !fs.existsSync(pythonBinary) ||
    typeof workerPath !== 'string' ||
    !path.isAbsolute(workerPath) ||
    !fs.existsSync(workerPath) ||
    (enginePath !== null && (typeof enginePath !== 'string' || !path.isAbsolute(enginePath) || !fs.existsSync(enginePath)))
  ) {
    throw failure('ASSET_BRIDGE_CONFIGURATION_INVALID');
  }

  function runSubprocess({ actionType, requestFrame, state, timeoutMs, killGraceMs, signal, hookHandlers }) {
    return new Promise((resolve, reject) => {
      let child;
      let closed = false;
      let settled = false;
      let ready = false;
      let done = false;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let stdoutBytes = 0;
      let frames = 0;
      let eventId = 0;
      let normalizedReceipt = null;
      let queue = Promise.resolve();
      let killTimer;

      const timeoutTimer = setTimeout(() => stop('ASSET_ENGINE_TIMEOUT'), timeoutMs);
      const abortHandler = () => stop('ASSET_ENGINE_CANCELLED');

      function cleanup() {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abortHandler);
      }

      function stop(code) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', abortHandler);
        if (child && !closed) {
          child.stdin.end();
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (!closed) child.kill('SIGKILL');
          }, killGraceMs);
          killTimer.unref?.();
        }
        reject(failure(code, state));
      }

      function write(frame) {
        if (!settled && !closed) {
          child.stdin.write(JSON.stringify(frame) + '\n');
        }
      }

      async function receive(frame) {
        if (settled) return;
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
          if (actionType === 'upload' && res.ok === true && (!state.beforeSubmitDone || !state.submissionMayHaveStarted)) {
            return stop('ASSET_ENGINE_PROTOCOL_INVALID');
          }
          if (actionType === 'recover' && res.ok === true && !state.assetId) {
            return stop('ASSET_ENGINE_PROTOCOL_INVALID');
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
            if (actionType !== 'upload' || state.beforeSubmitDone || state.submissionMayHaveStarted) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.beforeSubmitDone = true;
            await hookHandlers.onBeforeSubmit(structuredClone(frame.payload));
            if (settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'submission_started') {
            if (actionType !== 'upload' || !state.beforeSubmitDone || state.submissionMayHaveStarted) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            await hookHandlers.onSubmissionStarted();
            state.submissionMayHaveStarted = true;
            if (settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'on_task_id') {
            const tid = frame.payload?.taskId;
            if (!tid || typeof tid !== 'string' || !ASSET_TASK_ID_RE.test(tid)) {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.taskId = tid;
            await hookHandlers.onTaskId({ taskId: state.taskId });
            if (settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
          } else if (frame.event === 'on_asset_id') {
            const aid = frame.payload?.assetId;
            if (!aid || typeof aid !== 'string') {
              return stop('ASSET_ENGINE_PROTOCOL_INVALID');
            }
            state.assetId = aid;
            await hookHandlers.onAssetId({ assetId: state.assetId, taskId: state.taskId });
            if (settled || signal?.aborted) return stop('ASSET_ENGINE_CANCELLED');
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
          if (settled) return;
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
          queue.then(() => {
            if (settled) return;
            if (code !== 0 || !done || stdout.length) {
              return stop('ASSET_ENGINE_EXIT_WITHOUT_RESULT');
            }
            settled = true;
            cleanup();
            resolve(normalizedReceipt);
          }).catch(() => stop('ASSET_ENGINE_RESULT_INVALID'));
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
    baseUrl,
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
    if (Object.keys(extra).length > 0) {
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

    const gateway = parseAndValidateBaseUrl(baseUrl);
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
      baseUrl: gateway.origin,
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
      taskId: null,
      assetId: null,
      byteCount,
      sha256Hex,
      submissionMayHaveStarted: false,
      beforeSubmitDone: false,
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
    baseUrl,
    onAssetId = async () => {},
    signal,
    timeoutMs = 120000,
    killGraceMs = 250,
    pollTimeout = 120,
    ...extra
  } = {}) {
    if (Object.keys(extra).length > 0) {
      throw failure('ASSET_BRIDGE_INPUT_INVALID');
    }

    // Strict security check: recover must NOT receive apiKey, buffer, content, or filename
    if (
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

    const gateway = parseAndValidateBaseUrl(baseUrl);
    if (signal?.aborted) {
      throw failure('ASSET_ENGINE_CANCELLED');
    }

    const requestId = crypto.randomUUID();
    const requestPayload = {
      version: 1,
      type: 'recover',
      requestId,
      baseUrl: gateway.origin,
      taskId,
      pollTimeout: Math.min(120, Math.max(1, typeof pollTimeout === 'number' && Number.isFinite(pollTimeout) ? pollTimeout : timeoutMs / 1000)),
    };

    const requestFrame = JSON.stringify(requestPayload) + '\n';
    if (Buffer.byteLength(requestFrame) > MAX_EVENT_FRAME) {
      throw failure('ASSET_BRIDGE_INPUT_LIMIT');
    }

    const state = {
      requestId,
      taskId,
      assetId: null,
      byteCount: 0,
      sha256Hex: '',
      submissionMayHaveStarted: true, // recovery operates on an already submitted task
      beforeSubmitDone: true,
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
  MAX_INITIAL_FRAME,
  MAX_EVENT_FRAME,
  MAX_TOTAL_STDOUT,
  MAX_TOTAL_STDERR,
  MAX_ASSET_BYTES,
};
