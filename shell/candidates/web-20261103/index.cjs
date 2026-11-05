'use strict';

const crypto = require('node:crypto');
const url = require('node:url');

const DEFAULT_MAX_BYTES = 128 * 1024; // 128KB
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const MAX_QUERY_LEN = 512;
const MAX_REDIRECTS = 3;

function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // IPv6 loopback & private
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) {
    return true;
  }
  // IPv4 mapping or standard
  const v4 = ip.replace(/^::ffff:/, '');
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;

  // 127.0.0.0/8 (Loopback)
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 (Private)
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 – 172.31.255.255)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (Link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8
  if (parts[0] === 0) return true;

  return false;
}

function validateUrl(rawUrl, trustedDomains = []) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { ok: false, code: 'INVALID_URL', detail: err.message };
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

  // 3. 直接 IP 检查 (SSRF)
  if (isPrivateIp(hostname)) {
    return { ok: false, code: 'PRIVATE_IP_REJECTED', detail: `Private IP access rejected: ${hostname}` };
  }

  // 4. 域名白名单匹配
  if (!trustedDomains || trustedDomains.length === 0) {
    return { ok: false, code: 'DOMAIN_NOT_TRUSTED', detail: 'No trusted domains configured' };
  }

  const isTrusted = trustedDomains.some((d) => {
    const domain = d.toLowerCase();
    return hostname === domain || hostname.endsWith('.' + domain);
  });

  if (!isTrusted) {
    return { ok: false, code: 'DOMAIN_NOT_TRUSTED', detail: `Domain ${hostname} is not in trusted domains` };
  }

  return { ok: true, parsed };
}

function createWebResearcher(options = {}) {
  const globalTrustedDomains = options.trustedDomains || [];
  const defaultMaxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const provider = options.provider || 'local-stub';
  const customFetcher = options.customFetcher || null;
  const customDnsResolver = options.customDnsResolver || null;

  async function resolveHostnameIp(hostname) {
    if (customDnsResolver) {
      return await customDnsResolver(hostname);
    }
    return null;
  }

  async function fetchPage(input) {
    const { runId, tenantId, url: targetUrl, maxBytes = defaultMaxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = input || {};

    if (!runId || !tenantId) {
      return { ok: false, code: 'INVALID_INPUT', detail: 'runId and tenantId are required' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'RUN_CANCELLED' };
    }

    const validation = validateUrl(targetUrl, globalTrustedDomains);
    if (!validation.ok) {
      return validation;
    }

    const hostname = validation.parsed.hostname;
    const resolvedIp = await resolveHostnameIp(hostname);
    if (resolvedIp && isPrivateIp(resolvedIp)) {
      return { ok: false, code: 'PRIVATE_IP_REJECTED', detail: `DNS resolved to private IP: ${resolvedIp}` };
    }

    if (customFetcher) {
      try {
        const fetchRes = await customFetcher({
          url: targetUrl,
          timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
          maxBytes,
          signal,
        });

        if (fetchRes.aborted) {
          return { ok: false, code: 'RUN_CANCELLED' };
        }
        if (fetchRes.timeout) {
          return { ok: false, code: 'FETCH_TIMEOUT' };
        }
        if (fetchRes.redirectCount > MAX_REDIRECTS) {
          return { ok: false, code: 'REDIRECT_LIMIT' };
        }
        if (fetchRes.byteLength > maxBytes) {
          return { ok: false, code: 'CONTENT_TOO_LARGE' };
        }

        const content = fetchRes.content || '';
        return {
          ok: true,
          url: targetUrl,
          title: fetchRes.title || '',
          snippet: content.slice(0, 200),
          content,
          contentSha256: sha256(content),
          fetchedAt: Date.now(),
        };
      } catch (err) {
        if (err.name === 'AbortError' || (signal && signal.aborted)) {
          return { ok: false, code: 'RUN_CANCELLED' };
        }
        return { ok: false, code: 'FETCH_ERROR', detail: err.message };
      }
    }

    // 默认无 fetcher 情况下（离线或未接入在线客户端）
    return {
      ok: false,
      code: 'NETWORK_BLOCKED',
      detail: 'Live network access is blocked in this environment',
    };
  }

  async function search(query, searchOptions = {}) {
    const { runId, tenantId, maxResults = 5, trustedDomains = globalTrustedDomains, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = searchOptions || {};

    if (!runId || !tenantId) {
      throw Object.assign(new Error('runId and tenantId are required'), { code: 'INVALID_INPUT' });
    }

    if (!query || typeof query !== 'string' || query.length > MAX_QUERY_LEN) {
      throw Object.assign(new Error(`query must be non-empty and <= ${MAX_QUERY_LEN} chars`), { code: 'INVALID_INPUT' });
    }

    if (signal && signal.aborted) {
      throw Object.assign(new Error('Search was aborted by signal'), { code: 'RUN_CANCELLED' });
    }

    const clampedResults = Math.min(Math.max(1, maxResults), 10);
    const queryAt = Date.now();

    // 如果是 local-stub 或未配置在线 provider
    if (provider === 'local-stub' && !options.searchBackend) {
      return {
        results: [],
        queryAt,
        provider: 'local-stub',
        blocked: true,
      };
    }

    if (options.searchBackend) {
      const rawHits = await options.searchBackend({
        query,
        maxResults: clampedResults,
        trustedDomains,
        signal,
      });

      const validatedHits = [];
      let citationIndex = 1;

      for (const hit of rawHits) {
        const v = validateUrl(hit.url, trustedDomains);
        if (v.ok) {
          validatedHits.push({
            url: hit.url,
            title: hit.title || '',
            snippet: hit.snippet || '',
            fetchedAt: hit.fetchedAt || queryAt,
            contentSha256: hit.contentSha256 || sha256(hit.snippet || ''),
            citation: {
              index: citationIndex++,
              url: hit.url,
              title: hit.title || '',
            },
          });
        }
      }

      return {
        results: validatedHits.slice(0, clampedResults),
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
  }

  return {
    search,
    fetchPage,
    validateUrl: (u) => validateUrl(u, globalTrustedDomains),
    sha256,
  };
}

module.exports = {
  createWebResearcher,
  validateUrl,
  isPrivateIp,
  sha256,
};
