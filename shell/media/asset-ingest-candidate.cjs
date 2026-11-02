"use strict";
/**
 * shell/media/asset-ingest-candidate.cjs
 * ============================================================================
 * F1 媒体结果耐久性候选模块（隔离候选 · 2026-10-26 加固版）
 * 契约规范：
 *   - docs/refactor/GEMINI-F1-MEDIA-ASSET-PACKAGE-20261025.md
 *   - docs/refactor/GEMINI-F1-ASSET-INGEST-HARDENING-20261026.md
 * 
 * 职责：
 *   由可信宿主显式提供输入，安全抓取远端生成的图片/视频资产，验证合法性
 *   （HTTPS、严格主机白名单、无重定向、MIME 响应头、有限正整数及受控上界限制），
 *   并流式累积计算 SHA-256 哈希与 Buffer 资产供宿主保存。
 * 
 * 加固防护（Fail-Closed）：
 *   1. 错误消息、可枚举属性及原因对象绝不携带原 URL、Query（Token）、凭据或不受控响应头。
 *   2. 对 maxBytes、timeoutMs 做有限正整数校验并限制硬上界；若宿主指定更小上限则严格保留。
 *   3. 强制要求受限的流式响应体（ReadableStream），禁止不受限的 arrayBuffer() 整块缓冲。
 *   4. 超时与外部取消通过 Promise.race 覆盖 fetch 等待及 reader.read() 阶段，即使注入的
 *      fetch/reader 不响应 AbortSignal，调用也在有界时间内拒绝，且释放 reader 时不遮盖原始错误码。
 *   5. 精确主机白名单比对拦截域名伪造，但不能证明 DNS 解析目标安全（需宿主保障网络策略）。
 *   6. MIME 校验仅核对 HTTP 响应头，不作文件魔数/容器解码（在报告中显式声明内容真实性边界）。
 * ============================================================================
 */

const crypto = require("crypto");
const net = require("net");

const HARD_CEILING_IMAGE_MAX_BYTES = 50 * 1024 * 1024;   // 50 MB
const HARD_CEILING_VIDEO_MAX_BYTES = 200 * 1024 * 1024;  // 200 MB
const HARD_CEILING_TIMEOUT_MS = 10 * 60 * 1000;          // 10 minutes
const DEFAULT_TIMEOUT_MS = 60 * 1000;                    // 60 seconds

const ALLOWED_MIME_TYPES = {
  image: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
  ]),
  video: new Set([
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ]),
};

/**
 * 构造统一脱敏的错误对象
 * 绝不拼接任何外部不受控参数（如 Query、Token、未经验证的响应头内容）
 */
function createIngestError(code, message) {
  const err = new Error(`[ASSET_INGEST] ${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * 校验 URL 安全性（Fail-Closed）
 * 仅返回规范化校验通过的 host 与安全用于请求的 URL 对象
 */
function validateSafeUrl(rawUrl, allowedHosts) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw createIngestError("INVALID_URL", "Target URL must be a non-empty string");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createIngestError("INVALID_URL", "Failed to parse target URL");
  }

  // 1. 协议必须为 https
  if (parsed.protocol !== "https:") {
    throw createIngestError("DISALLOWED_PROTOCOL", "Only HTTPS protocol is permitted");
  }

  // 2. 禁止用户认证信息
  if (parsed.username || parsed.password) {
    throw createIngestError("URL_CREDENTIALS_DISALLOWED", "User credentials in URL are forbidden");
  }

  const hostname = parsed.hostname.toLowerCase();

  // 3. 禁止 IP 字面量（IPv4, IPv6）
  if (net.isIP(hostname) !== 0 || hostname.startsWith("[") || hostname.endsWith("]")) {
    throw createIngestError("IP_LITERAL_DISALLOWED", "IP literal hostnames are forbidden");
  }

  // 4. 禁止本地主机名
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localdomain")
  ) {
    throw createIngestError("LOCAL_HOST_DISALLOWED", "Local domain names are forbidden");
  }

  // 5. 校验 allowedHosts 白名单（精确全量比对，杜绝前缀/后缀欺骗）
  const allowedSet = new Set(
    Array.from(allowedHosts || []).map((h) => String(h).trim().toLowerCase())
  );
  if (!allowedSet.has(hostname)) {
    throw createIngestError("HOST_NOT_ALLOWED", "Hostname is not in allowed hosts whitelist");
  }

  return { parsed, hostname };
}

/**
 * 校验 Content-Type 响应头与 MIME
 * 注意：仅做响应头字符串比对，不代表底层文件魔数通过
 */
function validateMimeType(contentTypeHeader, expectedKind) {
  const allowedSet = ALLOWED_MIME_TYPES[expectedKind];
  if (!allowedSet) {
    throw createIngestError("INVALID_KIND", "Unsupported expectedKind");
  }

  if (!contentTypeHeader || typeof contentTypeHeader !== "string") {
    throw createIngestError("MISSING_CONTENT_TYPE", "Content-Type response header is missing");
  }

  // 解析 Content-Type 前置 media-type 部分（分号前截断）
  const rawMime = contentTypeHeader.split(";")[0].trim().toLowerCase();

  // 严格比对：若不匹配白名单，绝不在错误信息中回显 rawMime（防止在上游伪造带 query 的 Content-Type 时泄露）
  if (!allowedSet.has(rawMime)) {
    throw createIngestError("MIME_TYPE_MISMATCH", "Response MIME type does not match expected kind");
  }

  return rawMime;
}

/**
 * 校验 maxBytes 参数边界（有限正整数且不超过硬上限）
 */
function resolveMaxBytes(userMaxBytes, expectedKind) {
  const ceiling = expectedKind === "image" ? HARD_CEILING_IMAGE_MAX_BYTES : HARD_CEILING_VIDEO_MAX_BYTES;
  if (userMaxBytes === undefined) {
    return ceiling;
  }
  if (
    typeof userMaxBytes !== "number" ||
    !Number.isFinite(userMaxBytes) ||
    !Number.isSafeInteger(userMaxBytes) ||
    userMaxBytes <= 0
  ) {
    throw createIngestError("INVALID_MAX_BYTES", "maxBytes must be a positive finite safe integer");
  }
  if (userMaxBytes > ceiling) {
    throw createIngestError("MAX_BYTES_EXCEEDS_CEILING", "maxBytes exceeds hard ceiling limit");
  }
  return userMaxBytes;
}

/**
 * 校验 timeoutMs 参数边界（有限正整数且不超过硬上限）
 */
function resolveTimeoutMs(userTimeoutMs) {
  if (userTimeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (
    typeof userTimeoutMs !== "number" ||
    !Number.isFinite(userTimeoutMs) ||
    !Number.isSafeInteger(userTimeoutMs) ||
    userTimeoutMs <= 0
  ) {
    throw createIngestError("INVALID_TIMEOUT", "timeoutMs must be a positive finite safe integer");
  }
  if (userTimeoutMs > HARD_CEILING_TIMEOUT_MS) {
    throw createIngestError("TIMEOUT_EXCEEDS_CEILING", "timeoutMs exceeds hard ceiling limit");
  }
  return userTimeoutMs;
}

/**
 * 主函数：安全抓取并校验媒体资产
 *
 * @param {Object} params
 * @param {string} params.resultUrl - 上游返回的媒体资源 URL
 * @param {"image"|"video"} params.expectedKind - 期望的媒体类型
 * @param {string[]|Set<string>} params.allowedHosts - 允许的主机白名单集合（精确匹配）
 * @param {Function} [params.fetchImpl=globalThis.fetch] - 可注入的 fetch 实现
 * @param {number} [params.maxBytes] - 最大字节上限（有限正整数且 <= 硬上限）
 * @param {number} [params.timeoutMs=60000] - 抓取超时时间（毫秒，有限正整数且 <= 10分钟）
 * @param {AbortSignal} [params.signal] - 外部中止信号
 *
 * @returns {Promise<{ mime: string, byteCount: number, sha256: string, buffer: Buffer }>}
 */
async function ingestMediaAssetCandidate(params) {
  if (!params || typeof params !== "object") {
    throw createIngestError("INVALID_ARGUMENT", "Parameters object is required");
  }

  const {
    resultUrl,
    expectedKind,
    allowedHosts,
    fetchImpl = globalThis.fetch,
    maxBytes: userMaxBytes,
    timeoutMs: userTimeoutMs,
    signal: externalSignal,
  } = params;

  if (expectedKind !== "image" && expectedKind !== "video") {
    throw createIngestError("INVALID_KIND", "expectedKind must be 'image' or 'video'");
  }

  if (
    !allowedHosts ||
    (Array.isArray(allowedHosts) && allowedHosts.length === 0) ||
    (allowedHosts instanceof Set && allowedHosts.size === 0)
  ) {
    throw createIngestError("EMPTY_ALLOWED_HOSTS", "allowedHosts whitelist must not be empty");
  }

  // 1. 严格参数边界校验
  const maxBytes = resolveMaxBytes(userMaxBytes, expectedKind);
  const timeoutMs = resolveTimeoutMs(userTimeoutMs);

  // 2. URL 格式与安全审查（异常消息中不暴露原 URL 或 Query 参数）
  const { parsed: safeUrlObj } = validateSafeUrl(resultUrl, allowedHosts);

  // 3. 超时与信号控制：确保即使外部 fetch 或 stream reader 不配合 AbortSignal，也在有限时间内拒绝
  let timer = null;
  let abortListener = null;
  const timeoutFailure = createIngestError("INGEST_TIMEOUT", "Operation timed out");
  const abortFailure = createIngestError("INGEST_ABORTED", "Operation was aborted");

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutFailure);
    }, timeoutMs);
  });

  let externalAbortPromise = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw abortFailure;
    }
    externalAbortPromise = new Promise((_, reject) => {
      abortListener = () => {
        reject(abortFailure);
      };
      externalSignal.addEventListener("abort", abortListener, { once: true });
    });
  }

  const timeoutOrAbortRacer = externalAbortPromise
    ? Promise.race([timeoutPromise, externalAbortPromise])
    : timeoutPromise;

  const fetchAbortController = new AbortController();
  let completed = false;
  const fetchSignal = externalSignal
    ? AbortSignal.any([fetchAbortController.signal, externalSignal])
    : fetchAbortController.signal;

  try {
    // 4. 发起请求：禁用重定向（redirect: 'manual'），并与超时竞速
    let response;
    try {
      const fetchCall = Promise.resolve().then(() =>
        fetchImpl(safeUrlObj.toString(), {
          method: "GET",
          redirect: "manual",
          signal: fetchSignal,
        })
      );
      response = await Promise.race([fetchCall, timeoutOrAbortRacer]);
    } catch (fetchErr) {
      fetchAbortController.abort();
      if (fetchErr === timeoutFailure || fetchErr === abortFailure) throw fetchErr;
      // 绝不把原生 fetchErr 暴露或原样当作 cause（避免 message 携带 URL）
      throw createIngestError("FETCH_NETWORK_ERROR", "Network failure while fetching media asset");
    }

    if (!response || typeof response !== "object") {
      throw createIngestError("INVALID_RESPONSE", "Invalid response received from fetch implementation");
    }

    // 5. 重定向防御（Fail-Closed：任何 3xx 均视为非法）
    let status;
    try {
      status = response.status;
    } catch {
      throw createIngestError("INVALID_RESPONSE", "Failed to read HTTP response status");
    }
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw createIngestError("INVALID_RESPONSE", "Invalid HTTP response status");
    }
    if (status >= 300 && status < 400) {
      throw createIngestError("REDIRECT_NOT_ALLOWED", "Unexpected redirect response status");
    }

    // 6. 校验 HTTP 2xx
    if (status < 200 || status >= 300) {
      throw createIngestError("HTTP_ERROR", "HTTP request failed");
    }

    // 7. 校验 Content-Type 与 MIME
    let contentTypeHeader;
    let contentLengthHeader;
    try {
      contentTypeHeader = response.headers?.get?.("content-type");
      contentLengthHeader = response.headers?.get?.("content-length");
    } catch {
      throw createIngestError("INVALID_RESPONSE_HEADERS", "Failed to read response headers");
    }
    const mime = validateMimeType(contentTypeHeader, expectedKind);

    // 8. 头部 Content-Length 预检查
    if (contentLengthHeader) {
      const declaredLength = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
        throw createIngestError("CONTENT_LENGTH_OVERSIZE", "Declared Content-Length exceeds maxBytes limit");
      }
    }

    // 9. 强制流式读取：禁止不受限的 arrayBuffer() 整块缓冲
    let body;
    let getReader;
    try {
      body = response.body;
      getReader = body?.getReader;
    } catch {
      throw createIngestError("UNSUPPORTED_RESPONSE_BODY", "Failed to read response body");
    }
    if (!body || typeof getReader !== "function") {
      throw createIngestError("UNSUPPORTED_RESPONSE_BODY", "Response body must be a readable stream");
    }

    let reader;
    try {
      reader = getReader.call(body);
    } catch {
      throw createIngestError("UNSUPPORTED_RESPONSE_BODY", "Failed to acquire response stream reader");
    }
    const chunks = [];
    let receivedBytes = 0;
    const hasher = crypto.createHash("sha256");

    try {
      while (true) {
        let chunkResult;
        try {
          chunkResult = await Promise.race([reader.read(), timeoutOrAbortRacer]);
        } catch (streamErr) {
          if (streamErr === timeoutFailure || streamErr === abortFailure) throw streamErr;
          throw createIngestError("STREAM_READ_ERROR", "Error encountered while reading response stream");
        }

        const { done, value } = chunkResult;
        if (done) break;
        if (value) {
          if (!(value instanceof Uint8Array)) {
            throw createIngestError("INVALID_STREAM_CHUNK", "Response stream chunk must be binary");
          }
          receivedBytes += value.byteLength;
          if (receivedBytes > maxBytes) {
            throw createIngestError("ASSET_OVERSIZE", "Accumulated stream bytes exceeded maxBytes limit");
          }
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
          chunks.push(buf);
          hasher.update(buf);
        }
      }
    } finally {
      // 释放 reader/响应体时绝不得遮盖原始固定错误码
      // Cancellation is best effort. An injected reader can ignore it forever;
      // awaiting that promise would defeat the bounded timeout above.
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try {
        reader.releaseLock();
      } catch {}
    }

    if (receivedBytes === 0) {
      throw createIngestError("EMPTY_RESPONSE_BODY", "Response body was empty (0 bytes)");
    }

    const finalBuffer = Buffer.concat(chunks, receivedBytes);
    const sha256 = hasher.digest("hex");

    completed = true;
    return {
      mime,
      byteCount: receivedBytes,
      sha256,
      buffer: finalBuffer,
    };
  } finally {
    if (!completed) fetchAbortController.abort();
    if (timer) clearTimeout(timer);
    if (abortListener && externalSignal) {
      externalSignal.removeEventListener("abort", abortListener);
    }
  }
}

module.exports = {
  ingestMediaAssetCandidate,
  validateSafeUrl,
  validateMimeType,
  resolveMaxBytes,
  resolveTimeoutMs,
  ALLOWED_MIME_TYPES,
  HARD_CEILING_IMAGE_MAX_BYTES,
  HARD_CEILING_VIDEO_MAX_BYTES,
  HARD_CEILING_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
