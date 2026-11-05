'use strict';

const crypto = require('node:crypto');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_DURATION_MS = 300000; // 5分钟

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验 Magic Bytes
 */
function verifyMagicBytes(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return false;
  }

  const mime = (mimeType || '').toLowerCase();

  // WAV: 0-4 'RIFF', 8-12 'WAVE'
  if (mime === 'audio/wav' || mime === 'audio/x-wav') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
           buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  }

  // MP3: ID3 tag or sync header (0xFF 0xFB/0xF3/0xF2)
  if (mime === 'audio/mp3' || mime === 'audio/mpeg') {
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true;
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;
    return false;
  }

  // MP4: box header at 4..8 is 'ftyp'
  if (mime === 'video/mp4') {
    return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }

  // WEBM: EBML magic 0x1A 0x45 0xDF 0xA3
  if (mime === 'video/webm') {
    return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  }

  return false;
}

function createAvProcessor(options = {}) {
  const allowedTenantId = options.tenantId || null;
  const asrBackend = options.asrBackend || null;
  const frameExtractor = options.frameExtractor || null;

  async function processMedia(params) {
    const {
      runId,
      tenantId,
      buffer,
      mimeType,
      durationHintMs = 0,
      maxDurationMs = DEFAULT_MAX_DURATION_MS,
      maxBytes = DEFAULT_MAX_BYTES,
      signal,
    } = params || {};

    if (!runId || typeof runId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', detail: 'runId is required' };
    }
    if (!tenantId || typeof tenantId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', detail: 'tenantId is required' };
    }

    if (allowedTenantId && tenantId !== allowedTenantId) {
      return { ok: false, code: 'CROSS_TENANT_REJECTED', detail: 'tenantId does not match processor tenant' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'RUN_CANCELLED' };
    }

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, code: 'INVALID_INPUT', detail: 'buffer must be a non-empty Buffer' };
    }

    if (buffer.length > maxBytes) {
      return { ok: false, code: 'BYTE_LIMIT_EXCEEDED', detail: `Buffer length ${buffer.length} exceeds limit ${maxBytes}` };
    }

    if (durationHintMs > maxDurationMs) {
      return { ok: false, code: 'DURATION_EXCEEDED', detail: `Duration ${durationHintMs}ms exceeds max ${maxDurationMs}ms` };
    }

    if (!verifyMagicBytes(buffer, mimeType)) {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', detail: `MIME ${mimeType} does not match magic bytes or unsupported` };
    }

    const inputSha256 = sha256(buffer);
    const mime = (mimeType || '').toLowerCase();

    // 音频处理
    if (mime.startsWith('audio/')) {
      if (!asrBackend) {
        return {
          ok: true,
          type: 'audio',
          blocked: true,
          blockedReason: 'BLOCKED_ASR_NATIVE',
          segments: [],
          inputSha256,
          tenantId,
          durationMs: durationHintMs,
        };
      }

      try {
        const segments = await asrBackend({ buffer, mimeType, signal });
        return {
          ok: true,
          type: 'audio',
          blocked: false,
          segments: segments || [],
          inputSha256,
          tenantId,
          durationMs: durationHintMs,
        };
      } catch (err) {
        if (err.code === 'TRANSCRIPTION_BLOCKED') {
          return { ok: false, code: 'TRANSCRIPTION_BLOCKED', detail: err.message };
        }
        return { ok: false, code: 'ASR_ERROR', detail: err.message };
      }
    }

    // 视频处理
    if (mime.startsWith('video/')) {
      if (!frameExtractor) {
        return {
          ok: true,
          type: 'video',
          blocked: true,
          blockedReason: 'BLOCKED_FFMPEG',
          frames: [],
          inputSha256,
          tenantId,
          durationMs: durationHintMs,
        };
      }

      try {
        const frames = await frameExtractor({ buffer, mimeType, signal });
        return {
          ok: true,
          type: 'video',
          blocked: false,
          frames: frames || [],
          inputSha256,
          tenantId,
          durationMs: durationHintMs,
        };
      } catch (err) {
        if (err.code === 'FRAME_EXTRACTION_BLOCKED') {
          return { ok: false, code: 'FRAME_EXTRACTION_BLOCKED', detail: err.message };
        }
        return { ok: false, code: 'EXTRACTION_ERROR', detail: err.message };
      }
    }

    return { ok: false, code: 'UNSUPPORTED_FORMAT' };
  }

  return {
    processMedia,
    verifyMagicBytes,
    sha256,
  };
}

module.exports = {
  createAvProcessor,
  verifyMagicBytes,
  sha256,
};
