'use strict';
// Trusted host-only process boundary; this module is not registered as a DSH tool.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const WORKER = path.join(__dirname, 'ptvideo-worker.py');
const MAX_FRAME = 128 * 1024;
const MAX_STDERR = 64 * 1024;
const REQUEST_FIELDS = new Set(['model','kind','prompt','duration','resolution','ratio','aspect_ratio','n','seed','first_frame','last_frame','ref_images','no_audio','no_prompt_extend','watermark','poll_timeout','submit_timeout','poll_interval']);
const taskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
function failure(code, state = {}) {
  return Object.assign(new Error(code), { code, taskId: state.taskId || null, submissionMayHaveStarted: state.submissionMayHaveStarted === true });
}
function createPtVideoBridge({ pythonBinary = '/usr/bin/python3', spawnImpl = spawn, validateResult } = {}) {
  if (!path.isAbsolute(pythonBinary) || typeof spawnImpl !== 'function' || typeof validateResult !== 'function') throw failure('MEDIA_BRIDGE_CONFIGURATION_INVALID');
  return async function execute({ apiKey, request, baseUrl, onBeforeSubmit, onTaskId, onResult, signal, timeoutMs = 180000, killGraceMs = 250 } = {}) {
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(apiKey) ||
        !request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !REQUEST_FIELDS.has(key)) ||
        typeof request.model !== 'string' || !['image','video','seedance'].includes(request.kind) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 7200000 ||
        !Number.isSafeInteger(killGraceMs) || killGraceMs < 10 || killGraceMs > 2000 ||
        [onBeforeSubmit,onTaskId,onResult].some(callback => typeof callback !== 'function')) throw failure('MEDIA_BRIDGE_INPUT_INVALID');
    if (typeof baseUrl !== 'string' || /[\s\x00-\x1f\x7f]/.test(baseUrl) || baseUrl.split('/')[2]?.includes('@')) throw failure('MEDIA_BRIDGE_GATEWAY_INVALID');
    let gateway;
    try { gateway = new URL(baseUrl); } catch { throw failure('MEDIA_BRIDGE_GATEWAY_INVALID'); }
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || !['','/'].includes(gateway.pathname)) throw failure('MEDIA_BRIDGE_GATEWAY_INVALID');
    if (signal?.aborted) throw failure('MEDIA_ENGINE_CANCELLED');
    const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor/powertokens_video/UPSTREAM.json'), 'utf8'));
    const engineHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vendor/powertokens_video/pt_video.py'))).digest('hex');
    if (metadata.engineSha256 !== engineHash) throw failure('MEDIA_ENGINE_SOURCE_CHANGED');
    const snapshot = structuredClone(request);
    const expected = Object.freeze({ model: snapshot.model, kind: snapshot.kind, billingParams: Object.freeze({
      model: snapshot.model, kind: snapshot.kind, duration_s: snapshot.kind === 'image' ? null : (snapshot.duration ?? 5),
      resolution: snapshot.kind === 'image' ? null : (snapshot.resolution ?? '720p'),
      n_images: snapshot.kind === 'image' ? (snapshot.n ?? 1) : null,
      aspect_ratio: snapshot.kind === 'image' ? (snapshot.aspect_ratio ?? '1:1') : null,
    }) });
    const requestId = crypto.randomUUID();
    const input = JSON.stringify({ version:1, type:'generate', requestId, apiKey, baseUrl:gateway.origin, request:snapshot }) + '\n';
    if (Buffer.byteLength(input) > MAX_FRAME) throw failure('MEDIA_BRIDGE_INPUT_LIMIT');
    return new Promise((resolve, reject) => {
      const state = { taskId:null, submissionMayHaveStarted:false };
      let child, closed = false, settled = false, ready = false, done = false, before = false, resultSeen = false;
      let stdout = Buffer.alloc(0), stderrBytes = 0, stdoutBytes = 0, frames = 0, eventId = 0, normalized = null, resultIdentity = null, queue = Promise.resolve(), killTimer;
      const timer = setTimeout(() => stop('MEDIA_ENGINE_TIMEOUT'), timeoutMs);
      const abort = () => stop('MEDIA_ENGINE_CANCELLED');
      function cleanup() { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); }
      function stop(code) {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (child && !closed) {
          child.stdin.end(); child.kill('SIGTERM');
          killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, killGraceMs);
          killTimer.unref?.();
        }
        reject(failure(code, state));
      }
      function identity(raw) { return structuredClone({ model:raw.model, kind:raw.kind, task_id:raw.task_id, result_urls:raw.result_urls, billing_params:raw.billing_params }); }
      function write(frame) { if (!settled && !closed) child.stdin.write(JSON.stringify(frame) + '\n'); }
      async function receive(frame) {
        if (settled) return;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.version !== 1 || done) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
        if (frame.type === 'ready') {
          if (ready || Object.keys(frame).length !== 2) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
          ready = true; child.stdin.write(input); return;
        }
        if (!ready || frame.requestId !== requestId) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
        if (frame.type === 'error') return stop('MEDIA_ENGINE_FAILED');
        if (frame.type === 'done') {
          if ((!before && !['INVALID_REQUEST','BEFORE_SUBMIT_REJECTED','CANCELLED_BEFORE_SUBMIT'].includes(frame.result?.error_code)) || (frame.result?.ok === true && !resultSeen)) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
          if (resultIdentity && !isDeepStrictEqual(resultIdentity, identity(frame.result))) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
          normalized = validateResult(frame.result, { ...expected, taskId:state.taskId });
          if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return stop('MEDIA_ENGINE_RESULT_INVALID');
          done = true; child.stdin.end(); return;
        }
        if (frame.type !== 'event' || frame.eventId !== eventId + 1) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
        eventId = frame.eventId;
        const ack = {version:1,type:'ack',requestId,eventId,ok:true};
        try {
          if (frame.event === 'before_submit') {
            const value = frame.payload;
            if (before || resultSeen || !value || Object.keys(value).sort().join(',') !== 'billing_params,endpoint,kind,model' || value.model !== expected.model || value.kind !== expected.kind ||
                value.endpoint !== (expected.kind === 'image' ? '/v1/images/generations' : '/v1/videos') ||
                !isDeepStrictEqual(value.billing_params, expected.billingParams)) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
            before = true; await onBeforeSubmit(structuredClone(value));
            if (settled || signal?.aborted) return stop('MEDIA_ENGINE_CANCELLED');
            state.submissionMayHaveStarted = true;
          } else if (frame.event === 'task_id') {
            if (expected.kind === 'image' || !before || state.taskId || resultSeen || !taskId(frame.payload?.taskId) || frame.payload.taskId.includes(apiKey)) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
            state.taskId = frame.payload.taskId;
            await onTaskId({ taskId:state.taskId });
          } else if (frame.event === 'result') {
            if (!before || resultSeen) return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
            let value;
            try { value = validateResult(frame.payload, { ...expected, taskId:state.taskId }); }
            catch { return stop('MEDIA_ENGINE_RESULT_INVALID'); }
            resultSeen = true; resultIdentity = identity(frame.payload); await onResult(value);
          } else return stop('MEDIA_ENGINE_PROTOCOL_INVALID');
        } catch { ack.ok = false; }
        write(ack);
      }
      try {
        child = spawnImpl(pythonBinary, ['-I','-B',WORKER], { cwd:__dirname,
          env:{ PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', PT_VIDEO_CONFIG:'/nonexistent/northstar-media-config.json' },
          stdio:['pipe','pipe','pipe'], shell:false });
        child.stdin.on('error', () => { if (!done) stop('MEDIA_ENGINE_PIPE_FAILED'); });
        child.on('error', () => stop('MEDIA_ENGINE_START_FAILED'));
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_STDERR) stop('MEDIA_ENGINE_STDERR_LIMIT'); });
        child.stdout.on('data', chunk => {
          if (settled) return;
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_FRAME * 8 || stdout.length + chunk.length > MAX_FRAME * 2) return stop('MEDIA_ENGINE_STDOUT_LIMIT');
          stdout = Buffer.concat([stdout,chunk]);
          let end;
          while ((end = stdout.indexOf(10)) !== -1) {
            if (end + 1 > MAX_FRAME) return stop('MEDIA_ENGINE_STDOUT_LIMIT');
            if (++frames > 8) return stop('MEDIA_ENGINE_STDOUT_LIMIT');
            const line = stdout.subarray(0,end).toString('utf8'); stdout = stdout.subarray(end + 1);
            let frame; try { frame = JSON.parse(line); } catch { return stop('MEDIA_ENGINE_PROTOCOL_INVALID'); }
            queue = queue.then(() => receive(frame)).catch(() => stop('MEDIA_ENGINE_RESULT_INVALID'));
          }
          if (stdout.length > MAX_FRAME) stop('MEDIA_ENGINE_STDOUT_LIMIT');
        });
        child.once('close', code => {
          closed = true; clearTimeout(killTimer);
          queue.then(() => {
            if (settled) return;
            if (code !== 0 || !done || stdout.length) return stop('MEDIA_ENGINE_EXIT_WITHOUT_RESULT');
            settled = true; cleanup(); resolve(normalized);
          }).catch(() => stop('MEDIA_ENGINE_RESULT_INVALID'));
        });
        signal?.addEventListener('abort', abort, { once:true });
        if (signal?.aborted) abort();
      } catch { stop('MEDIA_ENGINE_START_FAILED'); }
    });
  };
}
module.exports = { createPtVideoBridge };
