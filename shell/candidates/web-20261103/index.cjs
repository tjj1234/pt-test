'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const url = require('node:url');
const zlib = require('node:zlib');

const DEFAULT_MAX_BYTES = 128 * 1024; // 128KB
const HARD_MAX_BYTES = 10 * 1024 * 1024; // 10MB hard ceiling
const DEFAULT_TIMEOUT_MS = 10000;
const HARD_MAX_TIMEOUT_MS = 60000; // 60s hard ceiling
const MAX_QUERY_LEN = 512;
const MAX_SNIPPET_LEN = 1000;
const MAX_REDIRECTS = 3;
const MAX_RESULTS_LIMIT = 10;

function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

/**
 * Sanitize error messages and URLs: remove credentials, tokens, sensitive paths and cookies.
 */
function sanitizeError(msg) {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/https?:\/\/[^/:]+:[^/@]+@/gi, (m) => m.split('://')[0] + '://')
    .replace(/(?:set-cookie|cookie|authorization)\s*:[^\r\n]+/gi, (m) => {
      const headerName = m.split(':')[0].trim();
      return `${headerName}: [REDACTED]`;
    })
    .replace(/\b(?:session|token|key|secret|password|bearer|auth|sid|preference)[=:\s]+[^\s,;&]+/gi, '[REDACTED]')
    .replace(/[?&](?:token|key|secret|password|auth|api_key|access_token|session|sid|preference)=[^&\s]+/gi, (m) => `${m[0]}[REDACTED_PARAM]`)
    .replace(/(?:\/(?:private|Users|home|root|var|etc|tmp|opt|app))\/[^\s:;,()]+/g, '[REDACTED_PATH]');
}

/**
 * Shared finite integer validator for byte limits (constructor & per-request).
 */
function validateBoundedMaxBytes(val) {
  if (val === undefined || val === null) {
    return { valid: true, value: DEFAULT_MAX_BYTES };
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 1) {
    return { valid: false, error: 'maxBytes must be a positive finite integer' };
  }
  if (val > HARD_MAX_BYTES) {
    return { valid: false, error: `maxBytes cannot exceed hard ceiling of ${HARD_MAX_BYTES} bytes (10MB)` };
  }
  return { valid: true, value: val };
}

/**
 * Shared validator for timeouts (constructor & per-request).
 */
function validateBoundedTimeout(val) {
  if (val === undefined || val === null) {
    return { valid: true, value: DEFAULT_TIMEOUT_MS };
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 1) {
    return { valid: false, error: 'timeoutMs must be a positive finite number' };
  }
  return { valid: true, value: Math.min(val, HARD_MAX_TIMEOUT_MS) };
}

/**
 * Robust IPv4 and IPv6 parser.
 * Returns { type: 4, octets: [...] } or { type: 6, words: [...] } or null.
 */
function parseIp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let ip = raw.trim().replace(/^\[|\]$/g, '');

  // IPv4
  const v4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4Match) {
    const parts = [Number(v4Match[1]), Number(v4Match[2]), Number(v4Match[3]), Number(v4Match[4])];
    if (parts.some((p) => p < 0 || p > 255)) return null;
    return { type: 4, octets: parts };
  }

  // IPv6: check for embedded IPv4 at the end, e.g. ::ffff:192.168.1.1
  let embeddedV4 = null;
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = ip.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4Parsed = parseIp(tail);
      if (!v4Parsed || v4Parsed.type !== 4) return null;
      embeddedV4 = v4Parsed.octets;
      ip =
        ip.slice(0, lastColon) +
        ':' +
        ((embeddedV4[0] << 8) | embeddedV4[1]).toString(16) +
        ':' +
        ((embeddedV4[2] << 8) | embeddedV4[3]).toString(16);
    }
  }

  if (ip === '::') {
    return { type: 6, words: [0, 0, 0, 0, 0, 0, 0, 0] };
  }

  let words = [];
  if (ip.includes('::')) {
    const halves = ip.split('::');
    if (halves.length !== 2) return null;
    const left = halves[0] ? halves[0].split(':').map((h) => parseInt(h, 16)) : [];
    const right = halves[1] ? halves[1].split(':').map((h) => parseInt(h, 16)) : [];
    if (left.some(isNaN) || right.some(isNaN)) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    words = [...left, ...Array(missing).fill(0), ...right];
  } else {
    words = ip.split(':').map((h) => parseInt(h, 16));
    if (words.length !== 8 || words.some(isNaN)) return null;
  }

  if (words.some((w) => w < 0 || w > 0xffff)) return null;
  return { type: 6, words };
}

/**
 * Complete CIDR and private/loopback/multicast address classification.
 */
function isPrivateIp(raw) {
  const parsed = parseIp(raw);
  if (!parsed) return false;

  if (parsed.type === 4) {
    const [a, b, c, d] = parsed.octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 Loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 Carrier-grade NAT
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 Documentation
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 Documentation
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 Documentation
    if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved
    return false;
  }

  // IPv6
  const w = parsed.words;
  // ::1 Loopback
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 1) {
    return true;
  }
  // :: Unspecified
  if (w.every((x) => x === 0)) return true;

  // IPv4-mapped IPv6 ::ffff:a.b.c.d or ::ffff:xxxx:xxxx
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
    const oct1 = (w[6] >> 8) & 0xff;
    const oct2 = w[6] & 0xff;
    const oct3 = (w[7] >> 8) & 0xff;
    const oct4 = w[7] & 0xff;
    return isPrivateIp(`${oct1}.${oct2}.${oct3}.${oct4}`);
  }

  // IPv4-compatible IPv6 ::a.b.c.d
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && (w[6] !== 0 || w[7] > 1)) {
    const oct1 = (w[6] >> 8) & 0xff;
    const oct2 = w[6] & 0xff;
    const oct3 = (w[7] >> 8) & 0xff;
    const oct4 = w[7] & 0xff;
    return isPrivateIp(`${oct1}.${oct2}.${oct3}.${oct4}`);
  }

  // 6to4 2002::/16 check embedded IPv4
  if (w[0] === 0x2002) {
    const oct1 = (w[1] >> 8) & 0xff;
    const oct2 = w[1] & 0xff;
    const oct3 = (w[2] >> 8) & 0xff;
    const oct4 = w[2] & 0xff;
    if (isPrivateIp(`${oct1}.${oct2}.${oct3}.${oct4}`)) return true;
  }

  // Unique Local Address (ULA) fc00::/7 (0xfc00 - 0xfdff)
  if ((w[0] & 0xfe00) === 0xfc00) return true;
  // Link-Local fe80::/10 (0xfe80 - 0xfebf)
  if ((w[0] & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((w[0] & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;
  // Discard prefix 100::/64
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;

  return false;
}

function normalizeDomain(d) {
  if (!d || typeof d !== 'string') return '';
  return d.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^\./, '').replace(/:\d+$/, '');
}

function isDomainMatching(hostname, domain) {
  const normHost = normalizeDomain(hostname);
  const normDomain = normalizeDomain(domain);
  if (!normHost || !normDomain) return false;
  return normHost === normDomain || normHost.endsWith('.' + normDomain);
}

function computeEffectiveTrustedDomains(globalTrustedDomains = [], requestedDomains) {
  const normalizedGlobal = (globalTrustedDomains || [])
    .map(normalizeDomain)
    .filter((d) => d && !isPrivateIp(d));

  if (requestedDomains === undefined || requestedDomains === null) {
    return normalizedGlobal;
  }
  if (!Array.isArray(requestedDomains)) {
    return [];
  }
  const normalizedRequested = requestedDomains
    .map(normalizeDomain)
    .filter((d) => d && !isPrivateIp(d));

  if (normalizedGlobal.length === 0) {
    return [];
  }
  // Integration boundary: per-request trustedDomains must only narrow, never expand server allowlist
  return normalizedRequested.filter((req) =>
    normalizedGlobal.some((glob) => isDomainMatching(req, glob))
  );
}

function validateUrl(rawUrl, trustedDomains = []) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { ok: false, code: 'INVALID_URL', detail: sanitizeError(err.message) };
  }

  // 1. 强制 HTTPS
  if (parsed.protocol !== 'https:') {
    return { ok: false, code: 'HTTP_REJECTED', detail: 'Only https:// URLs are allowed' };
  }

  // 2. 检查凭据
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'CREDENTIAL_IN_URL', detail: 'URL contains username or password' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // 3. 直接 IP 检查 (SSRF) - 白名单不能授予私网权限，私网/回环地址一律绝对拒绝
  if (isPrivateIp(cleanHost)) {
    return { ok: false, code: 'PRIVATE_IP_REJECTED', detail: `Private IP access rejected: ${hostname}` };
  }

  // 4. 域名白名单匹配
  if (!trustedDomains || trustedDomains.length === 0) {
    return { ok: false, code: 'DOMAIN_NOT_TRUSTED', detail: 'No trusted domains configured' };
  }

  const safeTrustedDomains = trustedDomains.filter((d) => !isPrivateIp(normalizeDomain(d)));
  if (safeTrustedDomains.length === 0) {
    return { ok: false, code: 'DOMAIN_NOT_TRUSTED', detail: 'No valid public trusted domains configured' };
  }

  const isTrusted = safeTrustedDomains.some((d) => isDomainMatching(cleanHost, d));
  if (!isTrusted) {
    return { ok: false, code: 'DOMAIN_NOT_TRUSTED', detail: `Domain ${hostname} is not in trusted domains` };
  }

  return { ok: true, parsed };
}

/**
 * Creates an internal execution context linking caller's signal and deadline timeout
 * directly to an internal AbortController.
 * Actively aborts underlying network, DNS, and fetch sockets upon timeout or cancellation.
 */
function createLinkedAbortContext(callerSignal, timeoutMs) {
  const ac = new AbortController();
  const signal = ac.signal;
  let timer = null;
  let callerAbortHandler = null;
  let isTimeout = false;

  if (callerSignal) {
    if (callerSignal.aborted) {
      ac.abort(callerSignal.reason || new Error('Run cancelled'));
    } else {
      callerAbortHandler = () => {
        ac.abort(callerSignal.reason || new Error('Run cancelled'));
      };
      callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
    }
  }

  if (typeof timeoutMs === 'number' && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      isTimeout = true;
      const err = new Error('Operation timed out');
      err.code = 'FETCH_TIMEOUT';
      ac.abort(err);
    }, timeoutMs);
  }

  function cleanup() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (callerSignal && callerAbortHandler) {
      callerSignal.removeEventListener('abort', callerAbortHandler);
      callerAbortHandler = null;
    }
  }

  return {
    ac,
    signal,
    cleanup,
    isTimeout: () => isTimeout,
  };
}

function createWebResearcher(options = {}) {
  // Validate constructor options with shared bounded check
  const maxBytesValidation = validateBoundedMaxBytes(options.maxBytes);
  if (!maxBytesValidation.valid) {
    throw Object.assign(new Error(maxBytesValidation.error), { code: 'INVALID_INPUT' });
  }
  const defaultMaxBytes = maxBytesValidation.value;

  const timeoutValidation = validateBoundedTimeout(options.timeoutMs);
  if (!timeoutValidation.valid) {
    throw Object.assign(new Error(timeoutValidation.error), { code: 'INVALID_INPUT' });
  }
  const defaultTimeoutMs = timeoutValidation.value;

  const globalTrustedDomains = options.trustedDomains || [];
  const provider = options.provider || 'local-stub';
  // Support both customFetcher and fetchBackend
  const customFetcher = options.customFetcher || options.fetchBackend || null;
  const customDnsResolver = options.customDnsResolver || null;

  async function resolveHostnameIps(hostname, linkedSignal) {
    if (!customDnsResolver) return [];
    if (linkedSignal && linkedSignal.aborted) {
      throw Object.assign(new Error('DNS resolution aborted'), { code: 'RUN_CANCELLED' });
    }

    // DNS waiting is actively bounded by linkedSignal
    return await new Promise((resolve, reject) => {
      let settled = false;
      let abortHandler = null;

      if (linkedSignal) {
        abortHandler = () => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error('DNS resolution aborted'), { code: 'RUN_CANCELLED' }));
        };
        linkedSignal.addEventListener('abort', abortHandler, { once: true });
      }

      Promise.resolve()
        .then(() => customDnsResolver(hostname, { signal: linkedSignal }))
        .then(
          (res) => {
            if (settled) return;
            settled = true;
            if (linkedSignal && abortHandler) linkedSignal.removeEventListener('abort', abortHandler);
            const arr = Array.isArray(res) ? res : res ? [res] : [];
            resolve(arr);
          },
          (err) => {
            if (settled) return;
            settled = true;
            if (linkedSignal && abortHandler) linkedSignal.removeEventListener('abort', abortHandler);
            reject(err);
          }
        );
    });
  }

  async function fetchPage(input) {
    const {
      runId,
      tenantId,
      url: targetUrl,
      maxBytes: rawMaxBytes,
      timeoutMs: rawTimeoutMs,
      signal: callerSignal,
      trustedDomains: requestTrustedDomains,
    } = input || {};

    if (!runId || typeof runId !== 'string' || !tenantId || typeof tenantId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', detail: 'runId and tenantId must be non-empty strings' };
    }

    if (!targetUrl || typeof targetUrl !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', detail: 'url must be a non-empty string' };
    }

    // Validate per-request maxBytes
    let maxBytes = defaultMaxBytes;
    if (rawMaxBytes !== undefined) {
      const v = validateBoundedMaxBytes(rawMaxBytes);
      if (!v.valid) {
        return { ok: false, code: 'INVALID_INPUT', detail: v.error };
      }
      maxBytes = v.value;
    }

    // Validate per-request timeoutMs
    let timeoutMs = defaultTimeoutMs;
    if (rawTimeoutMs !== undefined) {
      const v = validateBoundedTimeout(rawTimeoutMs);
      if (!v.valid) {
        return { ok: false, code: 'INVALID_INPUT', detail: v.error };
      }
      timeoutMs = v.value;
    }

    if (callerSignal && callerSignal.aborted) {
      return { ok: false, code: 'RUN_CANCELLED' };
    }

    const effectiveDomains = computeEffectiveTrustedDomains(globalTrustedDomains, requestTrustedDomains);
    const initialValidation = validateUrl(targetUrl, effectiveDomains);
    if (!initialValidation.ok) {
      return initialValidation;
    }

    // Full lifecycle linked abort context: terminates connections & reading on abort/timeout
    const { ac, signal: linkedSignal, cleanup, isTimeout } = createLinkedAbortContext(callerSignal, timeoutMs);

    try {
      if(options.transport||options.allowNetwork===true){
        const transport=options.transport||createTrustedHttpTransport(options);
        const result=await transport(targetUrl,{maxBytes,timeoutMs,signal:linkedSignal,trustedDomains:effectiveDomains});
        if(linkedSignal.aborted)throw Object.assign(new Error('Cancelled'),{code:isTimeout()?'FETCH_TIMEOUT':'RUN_CANCELLED'});
        return {ok:true,url:result.url||targetUrl,title:'',snippet:(result.content||'').slice(0,200),content:result.content||'',contentSha256:sha256(result.content||''),evidenceType:'page_content',byteLength:result.byteLength,fetchedAt:Date.now()};
      }
      // 1. Pre-connection DNS check with active cancellation & binding
      const initialHost = initialValidation.parsed.hostname.replace(/^\[|\]$/g, '');
      let initialIps = [];
      try {
        initialIps = await resolveHostnameIps(initialHost, linkedSignal);
      } catch (err) {
        if (isTimeout()) {
          return { ok: false, code: 'FETCH_TIMEOUT', detail: 'DNS resolution timed out' };
        }
        if (linkedSignal.aborted) {
          return { ok: false, code: 'RUN_CANCELLED' };
        }
        return { ok: false, code: 'FETCH_ERROR', detail: sanitizeError(err.message) };
      }

      // If custom DNS resolver is configured, empty resolution means host is unreachable
      if (customDnsResolver) {
        if (!Array.isArray(initialIps) || initialIps.length === 0) {
          return {
            ok: false,
            code: 'DNS_UNAVAILABLE',
            detail: `DNS resolution returned no valid address records for ${initialHost}`,
          };
        }
      }

      if (initialIps.some((ip) => isPrivateIp(ip))) {
        return {
          ok: false,
          code: 'PRIVATE_IP_REJECTED',
          detail: `DNS resolved to private IP: ${initialIps.join(', ')}`,
        };
      }

      // 2. DSH ctx.web seam delegation if available
      if (options.ctx && options.ctx.web && typeof options.ctx.web.fetch === 'function') {
        const fetchRes = await new Promise((resolve, reject) => {
          let done = false;
          const abortHandler = () => {
            if (done) return;
            done = true;
            resolve({ aborted: true });
          };

          linkedSignal.addEventListener('abort', abortHandler, { once: true });
          if (linkedSignal.aborted) {
            done = true;
            linkedSignal.removeEventListener('abort', abortHandler);
            return resolve({ aborted: true });
          }

          options.ctx.web
            .fetch({ url: targetUrl }, linkedSignal)
            .then((res) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              resolve(res);
            })
            .catch((err) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              reject(err);
            });
        });

        if (isTimeout()) {
          return { ok: false, code: 'FETCH_TIMEOUT', detail: 'Operation timed out' };
        }
        if (linkedSignal.aborted || fetchRes.aborted) {
          return { ok: false, code: 'RUN_CANCELLED' };
        }

        // Validate final URL (redirect / destination check)
        const finalUrl = fetchRes.url || targetUrl;
        const finalValidation = validateUrl(finalUrl, effectiveDomains);
        if (!finalValidation.ok) {
          return finalValidation;
        }

        const finalHost = finalValidation.parsed.hostname.replace(/^\[|\]$/g, '');
        const finalResolved = await resolveHostnameIps(finalHost, linkedSignal);
        if (finalResolved.some((ip) => isPrivateIp(ip))) {
          return { ok: false, code: 'PRIVATE_IP_REJECTED', detail: 'Final URL resolved to private IP' };
        }

        // Validate status code strictly
        const rawStatus = fetchRes.statusCode !== undefined ? fetchRes.statusCode : fetchRes.status;
        let statusCode = 200;
        if (rawStatus !== undefined) {
          if (typeof rawStatus !== 'number' || !Number.isFinite(rawStatus) || !Number.isInteger(rawStatus)) {
            return {
              ok: false,
              code: 'FETCH_ERROR',
              status: 502,
              detail: 'Invalid non-integer HTTP status code received',
            };
          }
          statusCode = rawStatus;
        }

        if (statusCode < 200 || statusCode >= 300) {
          return {
            ok: false,
            code: 'FETCH_ERROR',
            status: statusCode,
            detail: sanitizeError(`HTTP ${statusCode}: ${fetchRes.statusText || 'Fetch failed'}`),
          };
        }

        const content = fetchRes.body ? fetchRes.body.content || '' : '';
        const actualBytes = Buffer.byteLength(content, 'utf8');
        if (actualBytes > maxBytes) {
          return { ok: false, code: 'CONTENT_TOO_LARGE' };
        }

        return {
          ok: true,
          url: finalUrl,
          title: '',
          snippet: content.slice(0, 200),
          content,
          contentSha256: sha256(content),
          evidenceType: 'page_content',
          byteLength: actualBytes,
          fetchedAt: Date.now(),
        };
      }

      // 3. Custom fetcher / fetchBackend
      if (customFetcher) {
        // Install abort listener and check already-aborted BEFORE initiating backend fetch
        const fetchRes = await new Promise((resolve, reject) => {
          let done = false;
          const abortHandler = () => {
            if (done) return;
            done = true;
            resolve({ aborted: true });
          };

          linkedSignal.addEventListener('abort', abortHandler, { once: true });
          if (linkedSignal.aborted) {
            done = true;
            linkedSignal.removeEventListener('abort', abortHandler);
            return resolve({ aborted: true });
          }

          Promise.resolve()
            .then(() =>
              customFetcher({
                url: targetUrl,
                timeoutMs,
                maxBytes,
                signal: linkedSignal,
                resolvedIps: initialIps,
              })
            )
            .then((res) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              resolve(res);
            })
            .catch((err) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              reject(err);
            });
        });

        if (isTimeout()) {
          return { ok: false, code: 'FETCH_TIMEOUT', detail: 'Operation timed out' };
        }
        if (linkedSignal.aborted || fetchRes.aborted) {
          return { ok: false, code: 'RUN_CANCELLED' };
        }
        if (fetchRes.timeout) {
          return { ok: false, code: 'FETCH_TIMEOUT' };
        }
        if (fetchRes.redirectCount > MAX_REDIRECTS) {
          return { ok: false, code: 'REDIRECT_LIMIT' };
        }

        // Validate HTTP response status: HTTP 4xx/5xx or NaN must NEVER return ok: true
        const rawStatus = fetchRes.statusCode !== undefined ? fetchRes.statusCode : fetchRes.status;
        let statusCode = 200;
        if (rawStatus !== undefined) {
          if (typeof rawStatus !== 'number' || !Number.isFinite(rawStatus) || !Number.isInteger(rawStatus)) {
            return {
              ok: false,
              code: 'FETCH_ERROR',
              status: 502,
              detail: 'Invalid non-integer HTTP status code received from fetcher',
            };
          }
          statusCode = rawStatus;
        }

        if (statusCode < 200 || statusCode >= 300) {
          return {
            ok: false,
            code: 'FETCH_ERROR',
            status: statusCode,
            detail: sanitizeError(`HTTP ${statusCode}: ${fetchRes.statusText || 'Fetch failed'}`),
          };
        }

        // Hop-by-hop egress & redirect validation
        if (fetchRes.hops && Array.isArray(fetchRes.hops)) {
          for (const hopUrl of fetchRes.hops) {
            const hopValidation = validateUrl(hopUrl, effectiveDomains);
            if (!hopValidation.ok) {
              return hopValidation;
            }
          }
        }

        // Final URL destination check
        const finalUrl = fetchRes.url || targetUrl;
        const finalValidation = validateUrl(finalUrl, effectiveDomains);
        if (!finalValidation.ok) {
          return finalValidation;
        }

        const finalHost = finalValidation.parsed.hostname.replace(/^\[|\]$/g, '');
        const finalResolved = await resolveHostnameIps(finalHost, linkedSignal);
        if (finalResolved.some((ip) => isPrivateIp(ip))) {
          return { ok: false, code: 'PRIVATE_IP_REJECTED', detail: 'Final URL resolved to private IP' };
        }

        // Streaming & content byte limit enforcement
        const content = fetchRes.content || '';
        const actualBytes = Buffer.isBuffer(content)
          ? content.length
          : Buffer.byteLength(typeof content === 'string' ? content : String(content), 'utf8');
        const reportedBytes =
          typeof fetchRes.byteLength === 'number' && Number.isFinite(fetchRes.byteLength)
            ? fetchRes.byteLength
            : 0;
        const effectiveBytes = Math.max(actualBytes, reportedBytes);

        if (effectiveBytes > maxBytes) {
          return { ok: false, code: 'CONTENT_TOO_LARGE' };
        }

        const contentStr = typeof content === 'string' ? content : content.toString('utf8');
        return {
          ok: true,
          url: finalUrl,
          title: fetchRes.title || '',
          snippet: contentStr.slice(0, 200),
          content: contentStr,
          contentSha256: sha256(contentStr),
          evidenceType: 'page_content',
          byteLength: actualBytes,
          fetchedAt: Date.now(),
        };
      }

      // 4. Built-in or configured Trusted HTTP Transport
      if (options.transport || options.allowNetwork === true) {
        const transport = options.transport || createTrustedHttpTransport(options);
        const fetchRes = await transport(targetUrl, {
          maxBytes,
          timeoutMs,
          signal: linkedSignal,
          trustedDomains: effectiveDomains,
        });
        return {
          ok: true,
          url: fetchRes.url || targetUrl,
          title: '',
          snippet: (fetchRes.content || '').slice(0, 200),
          content: fetchRes.content || '',
          contentSha256: sha256(fetchRes.content || ''),
          evidenceType: 'page_content',
          byteLength: fetchRes.byteLength || Buffer.byteLength(fetchRes.content || '', 'utf8'),
          fetchedAt: Date.now(),
        };
      }

      return {
        ok: false,
        code: 'NETWORK_BLOCKED',
        detail: 'Live network access is blocked in this environment',
      };
    } catch (err) {
      if (isTimeout() || err.code === 'FETCH_TIMEOUT') {
        return { ok: false, code: 'FETCH_TIMEOUT', detail: 'Operation timed out' };
      }
      if (err.name === 'AbortError' || err.code === 'RUN_CANCELLED' || (callerSignal && callerSignal.aborted)) {
        return { ok: false, code: 'RUN_CANCELLED' };
      }
      if (
        [
          'CONTENT_TOO_LARGE',
          'REDIRECT_LIMIT',
          'PRIVATE_IP_REJECTED',
          'DOMAIN_NOT_TRUSTED',
          'DNS_UNAVAILABLE',
          'INVALID_INPUT',
          'INVALID_URL',
          'HTTP_REJECTED',
          'CREDENTIAL_IN_URL',
        ].includes(err.code)
      ) {
        return { ok: false, code: err.code, detail: sanitizeError(err.message) };
      }
      return { ok: false, code: 'FETCH_ERROR', status: err.status, detail: sanitizeError(err.message) };
    } finally {
      cleanup();
    }
  }

  async function search(query, searchOptions = {}) {
    const {
      runId,
      tenantId,
      maxResults: rawMaxResults,
      trustedDomains: requestTrustedDomains,
      timeoutMs: rawTimeoutMs,
      signal: callerSignal,
    } = searchOptions || {};

    if (!runId || typeof runId !== 'string' || !tenantId || typeof tenantId !== 'string') {
      throw Object.assign(new Error('runId and tenantId must be non-empty strings'), { code: 'INVALID_INPUT' });
    }

    if (!query || typeof query !== 'string' || query.length > MAX_QUERY_LEN) {
      throw Object.assign(new Error(`query must be non-empty and <= ${MAX_QUERY_LEN} chars`), { code: 'INVALID_INPUT' });
    }

    let maxResults = 5;
    if (rawMaxResults !== undefined) {
      if (
        typeof rawMaxResults !== 'number' ||
        !Number.isFinite(rawMaxResults) ||
        !Number.isInteger(rawMaxResults) ||
        rawMaxResults < 1
      ) {
        throw Object.assign(new Error('maxResults must be a positive integer'), { code: 'INVALID_INPUT' });
      }
      maxResults = Math.min(Math.max(1, rawMaxResults), MAX_RESULTS_LIMIT);
    }

    let timeoutMs = defaultTimeoutMs;
    if (rawTimeoutMs !== undefined) {
      const v = validateBoundedTimeout(rawTimeoutMs);
      if (!v.valid) {
        throw Object.assign(new Error(v.error), { code: 'INVALID_INPUT' });
      }
      timeoutMs = v.value;
    }

    const effectiveTrustedDomains = computeEffectiveTrustedDomains(globalTrustedDomains, requestTrustedDomains);
    const queryAt = Date.now();

    if (callerSignal && callerSignal.aborted) {
      return {
        results: [],
        queryAt,
        provider,
        blocked: true,
        code: 'RUN_CANCELLED',
      };
    }

    // Full lifecycle linked abort context
    const { ac, signal: linkedSignal, cleanup, isTimeout } = createLinkedAbortContext(callerSignal, timeoutMs);

    try {
      // 1. DSH ctx.web seam delegation if available
      if (options.ctx && options.ctx.web && typeof options.ctx.web.search === 'function') {
        const dshRes = await new Promise((resolve, reject) => {
          let done = false;
          const abortHandler = () => {
            if (done) return;
            done = true;
            resolve({ aborted: true });
          };

          linkedSignal.addEventListener('abort', abortHandler, { once: true });
          if (linkedSignal.aborted) {
            done = true;
            linkedSignal.removeEventListener('abort', abortHandler);
            return resolve({ aborted: true });
          }

          options.ctx.web
            .search({ query, maxResults }, linkedSignal)
            .then((res) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              resolve(res);
            })
            .catch((err) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              reject(err);
            });
        });

        if (isTimeout()) {
          return {
            results: [],
            queryAt,
            provider: 'dsh-ctx-web',
            blocked: true,
            code: 'FETCH_TIMEOUT',
          };
        }

        if (linkedSignal.aborted || dshRes.aborted) {
          return {
            results: [],
            queryAt,
            provider: 'dsh-ctx-web',
            blocked: true,
            code: 'RUN_CANCELLED',
          };
        }

        const validatedHits = [];
        let citationIndex = 1;
        for (const s of dshRes.sources || []) {
          const v = validateUrl(s.url, effectiveTrustedDomains);
          if (v.ok) {
            const snippet = (s.snippet || '').slice(0, MAX_SNIPPET_LEN);
            validatedHits.push({
              url: s.url,
              title: (s.title || '').slice(0, 200),
              snippet,
              fetchedAt: queryAt,
              snippetSha256: sha256(snippet),
              contentSha256: sha256(snippet),
              evidenceType: 'search_snippet',
              citation: {
                index: citationIndex++,
                url: s.url,
                title: (s.title || '').slice(0, 200),
              },
            });
          }
        }
        return {
          results: validatedHits.slice(0, maxResults),
          queryAt,
          provider: 'dsh-ctx-web',
          blocked: false,
        };
      }

      // 2. Local stub
      if (provider === 'local-stub' && !options.searchBackend) {
        return {
          results: [],
          queryAt,
          provider: 'local-stub',
          blocked: true,
        };
      }

      // 3. Search backend
      if (options.searchBackend) {
        const rawHits = await new Promise((resolve, reject) => {
          let done = false;
          const abortHandler = () => {
            if (done) return;
            done = true;
            resolve({ aborted: true });
          };

          linkedSignal.addEventListener('abort', abortHandler, { once: true });
          if (linkedSignal.aborted) {
            done = true;
            linkedSignal.removeEventListener('abort', abortHandler);
            return resolve({ aborted: true });
          }

          Promise.resolve()
            .then(() =>
              options.searchBackend({
                query,
                maxResults,
                trustedDomains: effectiveTrustedDomains,
                signal: linkedSignal,
              })
            )
            .then((res) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              resolve(res);
            })
            .catch((err) => {
              if (done) return;
              done = true;
              linkedSignal.removeEventListener('abort', abortHandler);
              reject(err);
            });
        });

        if (isTimeout()) {
          return {
            results: [],
            queryAt,
            provider,
            blocked: true,
            code: 'FETCH_TIMEOUT',
          };
        }

        if (linkedSignal.aborted || rawHits.aborted) {
          return {
            results: [],
            queryAt,
            provider,
            blocked: true,
            code: 'RUN_CANCELLED',
          };
        }

        const validatedHits = [];
        let citationIndex = 1;

        for (const hit of (rawHits || []).slice(0, maxResults * 2)) {
          const v = validateUrl(hit.url, effectiveTrustedDomains);
          if (v.ok) {
            const snippet = (hit.snippet || '').slice(0, MAX_SNIPPET_LEN);
            validatedHits.push({
              url: hit.url,
              title: (hit.title || '').slice(0, 200),
              snippet,
              fetchedAt: hit.fetchedAt || queryAt,
              snippetSha256: sha256(snippet),
              contentSha256: sha256(snippet),
              evidenceType: 'search_snippet',
              citation: {
                index: citationIndex++,
                url: hit.url,
                title: (hit.title || '').slice(0, 200),
              },
            });
            if (validatedHits.length >= maxResults) break;
          }
        }

        return {
          results: validatedHits,
          queryAt,
          provider,
          blocked: false,
        };
      }

      return {
        results: [],
        queryAt,
        provider,
        blocked: true,
      };
    } catch (err) {
      if (isTimeout()) {
        return {
          results: [],
          queryAt,
          provider,
          blocked: true,
          code: 'FETCH_TIMEOUT',
        };
      }
      if (err.name === 'AbortError' || err.code === 'RUN_CANCELLED' || (callerSignal && callerSignal.aborted)) {
        return {
          results: [],
          queryAt,
          provider,
          blocked: true,
          code: 'RUN_CANCELLED',
        };
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  return {
    search,
    fetchPage,
    validateUrl: (u) => validateUrl(u, globalTrustedDomains),
    computeEffectiveTrustedDomains: (req) => computeEffectiveTrustedDomains(globalTrustedDomains, req),
    sha256,
  };
}

/**
 * Built-in trusted HTTP transport factory with pre-connection DNS validation,
 * socket lookup pinning, manual redirect hop-by-hop verification,
 * and streaming read/decompression byte cut-off.
 */
function createTrustedHttpTransport(options = {}) {
  const globalTrustedDomains = options.trustedDomains || [];
  const byteLimit=validateBoundedMaxBytes(options.maxBytes),timeLimit=validateBoundedTimeout(options.timeoutMs);
  if(!byteLimit.valid||!timeLimit.valid)throw Object.assign(new Error('Invalid trusted transport limits'),{code:'INVALID_INPUT'});
  const defaultMaxBytes=byteLimit.value,defaultTimeoutMs=timeLimit.value;
  const dnsLookup = options.dnsLookup || (async(host,{signal}={})=>{
    if(net.isIP(host))return [{address:host,family:net.isIP(host)}];
    const resolver=new dns.promises.Resolver(),cancel=()=>resolver.cancel();
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      if(signal?.aborted)throw Object.assign(new Error('DNS cancelled'),{code:'RUN_CANCELLED'});
      const records=await Promise.allSettled([resolver.resolve4(host),resolver.resolve6(host)]);
      if(signal?.aborted)throw Object.assign(new Error('DNS cancelled'),{code:'RUN_CANCELLED'});
      return records.flatMap((record,index)=>record.status==='fulfilled'?record.value.map(address=>({address,family:index===0?4:6})):[]);
    }finally{signal?.removeEventListener('abort',cancel);}
  });
  const dnsTimeoutMs=options.dnsTimeoutMs??5000,maxRedirects=options.maxRedirects??MAX_REDIRECTS;
  if(!Number.isSafeInteger(dnsTimeoutMs)||dnsTimeoutMs<1||dnsTimeoutMs>5000||!Number.isSafeInteger(maxRedirects)||maxRedirects<0||maxRedirects>MAX_REDIRECTS)throw Object.assign(new Error('Invalid transport bounds'),{code:'INVALID_INPUT'});
  const requestFn = options.request || https.request;
  const zlibModule = options.zlib || zlib;

  return async function trustedFetch(rawUrl, fetchOptions = {}) {
    const {
      signal: callerSignal,
      maxBytes: rawMaxBytes,
      timeoutMs: rawTimeoutMs,
      trustedDomains: reqTrustedDomains,
      headers: reqHeaders,
    } = fetchOptions;

    if(fetchOptions.method!==undefined&&fetchOptions.method!=='GET')throw Object.assign(new Error('Only public GET retrieval is supported'),{code:'INVALID_INPUT'});
    if(reqHeaders&&Object.keys(reqHeaders).some(name=>/^(authorization|proxy-authorization|cookie|set-cookie|host|connection|transfer-encoding)$/i.test(name)))throw Object.assign(new Error('Credential headers are not permitted'),{code:'INVALID_INPUT'});
    let maxBytes = defaultMaxBytes;
    if (rawMaxBytes !== undefined) {
      const v = validateBoundedMaxBytes(rawMaxBytes);
      if (!v.valid) throw Object.assign(new Error(v.error), { code: 'INVALID_INPUT' });
      maxBytes = v.value;
    }

    let timeoutMs = defaultTimeoutMs;
    if (rawTimeoutMs !== undefined) {
      const v = validateBoundedTimeout(rawTimeoutMs);
      if (!v.valid) throw Object.assign(new Error(v.error), { code: 'INVALID_INPUT' });
      timeoutMs = v.value;
    }

    if (callerSignal && callerSignal.aborted) {
      const err = new Error('Fetch aborted');
      err.name = 'AbortError';
      err.code = 'RUN_CANCELLED';
      throw err;
    }

    const effectiveDomains = computeEffectiveTrustedDomains(globalTrustedDomains, reqTrustedDomains);
    const { ac, signal: linkedSignal, cleanup, isTimeout } = createLinkedAbortContext(callerSignal, timeoutMs);

    let currentUrl = rawUrl;
    let hopCount = 0;
    const hops = [];

    try {
      while (true) {
        if (linkedSignal.aborted) {
          const err = new Error(isTimeout() ? 'Fetch timed out' : 'Fetch cancelled');
          err.name = isTimeout() ? 'TimeoutError' : 'AbortError';
          err.code = isTimeout() ? 'FETCH_TIMEOUT' : 'RUN_CANCELLED';
          throw err;
        }

        // 1. Pre-hop URL validation (must be HTTPS, in domain allowlist, no credentials)
        const urlValidation = validateUrl(currentUrl, effectiveDomains);
        if (!urlValidation.ok) {
          const err = new Error(urlValidation.detail || urlValidation.code);
          err.code = urlValidation.code;
          throw err;
        }

        const parsedUrl = urlValidation.parsed;
        const currentHost = parsedUrl.hostname.replace(/^\[|\]$/g, '');

        // 2. Pre-connection DNS resolution with active timeout & abort race
        const dnsController=new AbortController();
        let dnsTimer = null,dnsAbort=null;
        let records = null;
        try {
          const dnsInterrupted = new Promise((_, reject) => {
            dnsTimer = setTimeout(() => {
              dnsController.abort();
              const err = new Error('DNS resolution timed out');
              err.code = 'FETCH_TIMEOUT';
              reject(err);
            }, dnsTimeoutMs);

            const onAbort = () => {
              dnsController.abort();
              const err = new Error(isTimeout() ? 'DNS resolution timed out' : 'DNS resolution cancelled');
              err.code = isTimeout() ? 'FETCH_TIMEOUT' : 'RUN_CANCELLED';
              reject(err);
            };
            dnsAbort=onAbort;linkedSignal.addEventListener('abort', onAbort, { once: true });
          });

          const dnsLookupPromise = Promise.resolve().then(() =>
            dnsLookup(currentHost, { all: true, verbatim: true,signal:dnsController.signal })
          );

          records = await Promise.race([dnsLookupPromise, dnsInterrupted]);
        } catch (err) {
          if (dnsTimer) clearTimeout(dnsTimer);
          if (err.code === 'FETCH_TIMEOUT' || err.code === 'RUN_CANCELLED') throw err;
          const dnsErr = new Error(sanitizeError(`DNS resolution failed for ${currentHost}: ${err.message}`));
          dnsErr.code = 'DNS_UNAVAILABLE';
          throw dnsErr;
        } finally {
          if (dnsTimer) clearTimeout(dnsTimer);if(dnsAbort)linkedSignal.removeEventListener('abort',dnsAbort);
        }

        if (linkedSignal.aborted) {
          const err = new Error(isTimeout() ? 'Fetch timed out' : 'Fetch cancelled');
          err.code = isTimeout() ? 'FETCH_TIMEOUT' : 'RUN_CANCELLED';
          throw err;
        }

        // Validate DNS records: reject empty records or private IP addresses
        let normRecords = [];
        if (Array.isArray(records)) {
          normRecords = records.map((r) =>
            typeof r === 'string' ? { address: r, family: r.includes(':') ? 6 : 4 } : r
          );
        } else if (records && typeof records === 'object') {
          normRecords = [{ address: records.address || String(records), family: records.family || 4 }];
        } else if (typeof records === 'string') {
          normRecords = [{ address: records, family: records.includes(':') ? 6 : 4 }];
        }

        if (normRecords.length === 0) {
          const err = new Error(`DNS resolution returned no valid records for ${currentHost}`);
          err.code = 'DNS_UNAVAILABLE';
          throw err;
        }

        for (const rec of normRecords) {
          if (!net.isIP(rec.address)||isPrivateIp(rec.address)) {
            const err = new Error(`DNS resolved to private IP: ${rec.address}`);
            err.code = 'PRIVATE_IP_REJECTED';
            throw err;
          }
        }

        const boundAddress = normRecords[0].address;
        const boundFamily = normRecords[0].family || (boundAddress.includes(':') ? 6 : 4);

        // 3. Initiate request with socket lookup pinning
        const hopResult = await new Promise((resolve, reject) => {
          let req = null,response=null,decoder=null;
          let settled = false;

          function finish(err, res) {
            if (settled) return;
            settled = true;
            linkedSignal.removeEventListener('abort',onAbort);
            decoder?.destroy();response?.destroy();
            if (req) {
              try {
                req.destroy();
              } catch (_) {}
            }
            if (err) reject(err);
            else resolve(res);
          }

          const onAbort = () => {
            finish(
              Object.assign(new Error(isTimeout() ? 'Fetch timed out' : 'Fetch cancelled'), {
                code: isTimeout() ? 'FETCH_TIMEOUT' : 'RUN_CANCELLED',
              })
            );
          };
          linkedSignal.addEventListener('abort', onAbort, { once: true });

          try {
            req = requestFn(
              parsedUrl,
              {
                method: fetchOptions.method || 'GET',
                headers: {
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                  'Accept-Encoding': 'gzip, deflate, br',
                  'User-Agent': 'PowerTokens-TrustedWeb/1.0',
                  ...(reqHeaders || {}),
                },
                agent: false,
                servername: parsedUrl.hostname,
                family: boundFamily,
                signal: linkedSignal,
                lookup: (lookupHost, lookupOpts, cb) => {
                  if (lookupHost !== parsedUrl.hostname || linkedSignal.aborted) {
                    return cb(
                      Object.assign(new Error('Address denied or aborted'), { code: 'PRIVATE_IP_REJECTED' })
                    );
                  }
                  if (lookupOpts?.all) {
                    return cb(null, [{ address: boundAddress, family: boundFamily }]);
                  }
                  cb(null, boundAddress, boundFamily);
                },
              },
              (res) => {
                response=res;
                const statusCode = res.statusCode;
                if(!Number.isInteger(statusCode)||statusCode<100||statusCode>599)return finish(Object.assign(new Error('Invalid HTTP status'),{code:'FETCH_ERROR'}));

                // Handle Redirects
                if ([301, 302, 303, 307, 308].includes(statusCode)) {
                  const location = res.headers['location'];
                  res.destroy();
                  if (!location) {
                    return finish(
                      Object.assign(new Error('Redirect missing Location header'), { code: 'FETCH_ERROR' })
                    );
                  }
                  let nextUrl;
                  try {
                    nextUrl = new URL(location, currentUrl).href;
                  } catch {
                    return finish(
                      Object.assign(new Error('Invalid redirect Location'), { code: 'INVALID_URL' })
                    );
                  }
                  return finish(null, { isRedirect: true, nextUrl });
                }

                // Check Content-Length before reading
                const cl = parseInt(res.headers['content-length'], 10);
                if (Number.isFinite(cl) && cl > maxBytes) {
                  res.destroy();
                  return finish(
                    Object.assign(
                      new Error(`Content-Length ${cl} exceeds maxBytes limit of ${maxBytes}`),
                      { code: 'CONTENT_TOO_LARGE' }
                    )
                  );
                }

                let wireBytes=0;
                res.on('data',chunk=>{wireBytes+=chunk.length;if(wireBytes>maxBytes)finish(Object.assign(new Error('Wire body exceeds limit'),{code:'CONTENT_TOO_LARGE'}));});
                // Setup decompression
                let stream = res;
                const encoding = (res.headers['content-encoding'] || '').toLowerCase().trim();
                let decompressor = null;
                if (encoding === 'gzip' || encoding === 'x-gzip') {
                  decompressor = zlibModule.createGunzip();
                } else if (encoding === 'deflate') {
                  decompressor = zlibModule.createInflate();
                } else if (encoding === 'br') {
                  decompressor = zlibModule.createBrotliDecompress();
                }

                decoder=decompressor;
                if (decompressor) {
                  decompressor.on('error', (err) => {
                    res.destroy();
                    finish(
                      Object.assign(
                        new Error(sanitizeError(`Decompression error: ${err.message}`)),
                        { code: 'FETCH_ERROR' }
                      )
                    );
                  });
                  stream = res.pipe(decompressor);
                }

                const chunks = [];
                let bytesRead = 0;

                stream.on('data', (chunk) => {
                  if(settled)return;
                  bytesRead += chunk.length;
                  if (bytesRead > maxBytes) {
                    // STREAMING EARLY CUT-OFF: actively destroy stream, response and socket immediately
                    if (decompressor) {
                      try {
                        decompressor.destroy();
                      } catch (_) {}
                    }
                    try {
                      res.destroy();
                    } catch (_) {}
                    return finish(
                      Object.assign(
                        new Error(`Response body exceeded maxBytes limit of ${maxBytes}`),
                        { code: 'CONTENT_TOO_LARGE' }
                      )
                    );
                  }
                  chunks.push(chunk);
                });

                stream.on('end', () => {
                  const bodyBuffer = Buffer.concat(chunks);
                  finish(null, {
                    isRedirect: false,
                    statusCode,
                    statusText: res.statusMessage || (statusCode === 200 ? 'OK' : 'Error'),
                    content: bodyBuffer.toString('utf8'),
                    byteLength: bodyBuffer.length,
                    headers: res.headers,
                  });
                });

                stream.on('error', (err) => {
                  res.destroy();
                  finish(
                    Object.assign(
                      new Error(sanitizeError(`Stream read failed: ${err.message}`)),
                      { code: 'FETCH_ERROR' }
                    )
                  );
                });
              }
            );

            req.on('error', (err) => {
              if (linkedSignal.aborted) {
                finish(
                  Object.assign(new Error(isTimeout() ? 'Fetch timed out' : 'Fetch cancelled'), {
                    code: isTimeout() ? 'FETCH_TIMEOUT' : 'RUN_CANCELLED',
                  })
                );
              } else {
                finish(
                  Object.assign(new Error(sanitizeError(`Network request failed: ${err.message}`)), {
                    code: 'FETCH_ERROR',
                  })
                );
              }
            });

            req.end();
          } catch (err) {
            finish(
              Object.assign(new Error(sanitizeError(`Failed to dispatch request: ${err.message}`)), {
                code: 'FETCH_ERROR',
              })
            );
          }
        });

        if (hopResult.isRedirect) {
          hopCount++;
          if (hopCount > maxRedirects) {
            const err = new Error(`Exceeded max redirects limit of ${maxRedirects}`);
            err.code = 'REDIRECT_LIMIT';
            throw err;
          }
          hops.push(hopResult.nextUrl);
          currentUrl = hopResult.nextUrl;
          continue;
        }

        // Non-redirect response: validate status
        if (hopResult.statusCode < 200 || hopResult.statusCode >= 300) {
          const err = new Error(
            sanitizeError(`HTTP ${hopResult.statusCode}: ${hopResult.statusText || 'Fetch failed'}`)
          );
          err.code = 'FETCH_ERROR';
          err.status = hopResult.statusCode;
          err.statusText = hopResult.statusText;
          err.content = hopResult.content;
          err.hops = hops;
          throw err;
        }

        return {
          statusCode: 200,
          statusText: 'OK',
          url: currentUrl,
          hops,
          content: hopResult.content,
          byteLength: hopResult.byteLength,
          headers: hopResult.headers,
        };
      }
    } finally {
      cleanup();
    }
  };
}

/**
 * Adapter implementing DSH WebSearchProvider for registration into ctx.web
 */
function createDshSearchProvider(options = {}) {
  const researcher = createWebResearcher(options);
  const id = options.id || 'trusted-web-search';
  const resolveContext =
    options.resolveContext ||
    ((req) => ({
      runId: req?.runId || options.runId || 'dsh-run',
      tenantId: req?.tenantId || options.tenantId || 'dsh-tenant',
    }));

  return {
    id,
    available() {
      if (typeof options.isAvailable === 'function') return options.isAvailable();
      return typeof options.searchBackend === 'function';
    },
    async search(request, signal) {
      if (signal && signal.aborted) {
        const err = new Error('Search was aborted');
        err.name = 'AbortError';
        err.code = 'WEB_ABORTED';
        throw err;
      }
      try {
        const ctx = resolveContext(request);
        const outcome = await researcher.search(request.query, {
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          maxResults: request.maxResults,
          signal,
        });

        if (outcome.blocked) {
          if (outcome.code === 'FETCH_TIMEOUT') {
            const timeoutErr = new Error('Search operation timed out');
            timeoutErr.code = 'FETCH_TIMEOUT';
            throw timeoutErr;
          }
          if (outcome.code === 'RUN_CANCELLED') {
            const abortErr = new Error('Search was aborted');
            abortErr.name = 'AbortError';
            abortErr.code = 'WEB_ABORTED';
            throw abortErr;
          }
        }

        return {
          content: outcome.answer || undefined,
          sources: (outcome.results || []).map((r) => ({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
          })),
          truncated: false,
        };
      } catch (err) {
        if (err.code === 'FETCH_TIMEOUT') {
          throw err;
        }
        if (err.code === 'RUN_CANCELLED' || (signal && signal.aborted)) {
          const abortErr = new Error('Search was aborted');
          abortErr.name = 'AbortError';
          abortErr.code = 'WEB_ABORTED';
          if (err) {
            abortErr.cause = new Error(sanitizeError(err.cause?.message || err.message || 'Operation aborted'));
          }
          throw abortErr;
        }
        const providerErr = new Error(sanitizeError(err.message));
        providerErr.code = 'WEB_PROVIDER_ERROR';
        if (err) {
          providerErr.cause = new Error(sanitizeError(err.cause?.message || err.message || 'Provider failure'));
        }
        throw providerErr;
      }
    },
  };
}

/**
 * Adapter implementing DSH WebFetchProvider for registration into ctx.web
 */
function createDshFetchProvider(options = {}) {
  const researcher = createWebResearcher(options);
  const id = options.id || 'trusted-web-fetch';
  const resolveContext =
    options.resolveContext ||
    ((req) => ({
      runId: req?.runId || options.runId || 'dsh-run',
      tenantId: req?.tenantId || options.tenantId || 'dsh-tenant',
    }));

  return {
    id,
    available() {
      if (typeof options.isAvailable === 'function') return options.isAvailable();
      return (
        typeof options.customFetcher === 'function' ||
        typeof options.fetchBackend === 'function' ||
        typeof options.transport === 'function'
      );
    },
    async fetch(request, signal) {
      if (signal && signal.aborted) {
        const err = new Error('Fetch was aborted');
        err.name = 'AbortError';
        err.code = 'WEB_ABORTED';
        throw err;
      }
      const ctx = resolveContext(request);
      const page = await researcher.fetchPage({
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        url: request.url,
        maxBytes: options.maxBytes,
        signal,
      });

      if (!page.ok) {
        if (page.code === 'RUN_CANCELLED' || (signal && signal.aborted)) {
          const abortErr = new Error('Fetch was aborted');
          abortErr.name = 'AbortError';
          abortErr.code = 'WEB_ABORTED';
          if (page.detail) {
            abortErr.cause = new Error(sanitizeError(page.detail));
          }
          throw abortErr;
        }
        const statusCode = page.code === 'FETCH_TIMEOUT' ? 408 : page.status || 403;
        const errorContent = sanitizeError(page.detail || page.code || `HTTP ${statusCode}`);
        return {
          url: request.url,
          statusCode,
          statusText: sanitizeError(page.detail || page.code),
          body: {
            kind: 'text',
            type: 'text',
            content: errorContent,
          },
          truncated: page.code === 'CONTENT_TOO_LARGE',
        };
      }

      return {
        url: page.url,
        statusCode: 200,
        statusText: 'OK',
        body: {
          kind: 'text',
          type: 'text',
          content: page.content,
        },
        truncated: false,
      };
    },
  };
}

/**
 * Register trusted providers into DSH Cordis context (ctx.web)
 */
function registerToDsh(ctx, options = {}) {
  if (!ctx || !ctx.web) {
    throw new Error('registerToDsh requires a valid Cordis context with ctx.web registered');
  }
  const disposers = [];
  if (typeof ctx.web.registerSearchProvider === 'function') {
    disposers.push(ctx.web.registerSearchProvider(createDshSearchProvider(options)));
  }
  if (typeof ctx.web.registerFetchProvider === 'function') {
    disposers.push(ctx.web.registerFetchProvider(createDshFetchProvider(options)));
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (_) {}
    }
  };
}

const name = 'trusted-web';
const inject = ['web'];
function apply(ctx, config) {
  registerToDsh(ctx, config);
}

module.exports = {
  createWebResearcher,
  createTrustedHttpTransport,
  validateUrl,
  isPrivateIp,
  sha256,
  sanitizeError,
  validateBoundedMaxBytes,
  validateBoundedTimeout,
  computeEffectiveTrustedDomains,
  createDshSearchProvider,
  createDshFetchProvider,
  registerToDsh,
  apply,
  inject,
  name,
};
