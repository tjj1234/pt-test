import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.env.WEB04_REVIEW_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const candidate = require(path.join(root, 'shell/candidates/web-20261103/index.cjs'));

const identity = { runId: 'fixture-run', tenantId: 'fixture-tenant' };
const url = 'https://safe.example/page';

console.log('=== WEB04 R4 Transport, Streaming Ceilings & Error Sanitization Verification ===\n');

async function testTrustedTransportDnsAndSocketPinning() {
  console.log('[1] Trusted Transport: Pre-connection DNS validation & Socket lookup binding');

  let socketLookupCalled = false;
  let socketLookupFamily = null;
  let socketLookupAddress = null;
  let servernameObserved = null;

  // Mock request function simulating https.request
  const mockRequest = (parsedUrl, opts, callback) => {
    servernameObserved = opts.servername;
    assert.equal(opts.agent, false);
    assert.equal(opts.servername, 'safe.example');

    // Simulate Node.js net/tls lookup binding
    opts.lookup('safe.example', { all: false }, (err, address, family) => {
      socketLookupCalled = true;
      socketLookupAddress = address;
      socketLookupFamily = family;
    });

    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = { 'content-type': 'text/plain' };
      res.destroy = () => {};
      callback(res);
      queueMicrotask(() => {
        res.emit('data', Buffer.from('verified-safe-content'));
        res.emit('end');
      });
    };
    return req;
  };

  const transport = candidate.createTrustedHttpTransport({
    trustedDomains: ['safe.example'],
    dnsLookup: async (host) => [{ address: '93.184.216.34', family: 4 }],
    request: mockRequest,
  });

  const res = await transport('https://safe.example/page');
  assert.equal(res.statusCode, 200);
  assert.equal(res.content, 'verified-safe-content');
  assert.equal(socketLookupCalled, true, 'Socket lookup pinning must be actively invoked');
  assert.equal(socketLookupAddress, '93.184.216.34', 'Socket lookup must be pinned to pre-validated IP');
  assert.equal(socketLookupFamily, 4);
  assert.equal(servernameObserved, 'safe.example', 'TLS SNI servername must match target host');
  console.log('  ✔ [PASS] Socket lookup pinned to validated IP and TLS SNI servername preserved');

  // Verify empty DNS rejection
  const emptyDnsResearcher = candidate.createWebResearcher({
    trustedDomains: ['safe.example'],
    customDnsResolver: async () => [],
    customFetcher: async () => {
      assert.fail('Backend must NOT be started when DNS resolution returns empty');
    },
  });
  const emptyDnsResult = await emptyDnsResearcher.fetchPage({ ...identity, url });
  assert.equal(emptyDnsResult.ok, false);
  assert.equal(emptyDnsResult.code, 'DNS_UNAVAILABLE');
  console.log('  ✔ [PASS] Empty DNS answer rejected before backend start (DNS_UNAVAILABLE)');

  // Verify private IP in DNS rejected before request dispatch
  const privateDnsTransport = candidate.createTrustedHttpTransport({
    trustedDomains: ['safe.example'],
    dnsLookup: async () => [{ address: '10.0.0.1', family: 4 }],
    request: () => {
      assert.fail('Request dispatch must NEVER be called for private IP in DNS');
    },
  });
  await assert.rejects(
    privateDnsTransport('https://safe.example/page'),
    (err) => err.code === 'PRIVATE_IP_REJECTED'
  );
  console.log('  ✔ [PASS] Private IP in DNS rejected before dispatching request (PRIVATE_IP_REJECTED)');
}

async function testStreamingReadCeilings() {
  console.log('\n[2] Streaming Read Ceilings & Active Stream/Socket Destruction');

  let streamDestroyed = false;
  let requestDestroyed = false;
  let bytesSent = 0;

  const mockRequest = (parsedUrl, opts, callback) => {
    opts.lookup('safe.example', {}, (err, addr, fam) => {});
    const req = new EventEmitter();
    req.destroy = () => {
      requestDestroyed = true;
    };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.destroy = () => {
        streamDestroyed = true;
      };
      callback(res);
      queueMicrotask(() => {
        // Stream chunks: first chunk 6 bytes
        bytesSent += 6;
        res.emit('data', Buffer.from('123456'));
        // Second chunk 6 bytes -> total 12 bytes > maxBytes (8)
        bytesSent += 6;
        res.emit('data', Buffer.from('789012'));
      });
    };
    return req;
  };

  const transport = candidate.createTrustedHttpTransport({
    trustedDomains: ['safe.example'],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: mockRequest,
  });

  await assert.rejects(
    transport('https://safe.example/page', { maxBytes: 8 }),
    (err) => {
      assert.equal(err.code, 'CONTENT_TOO_LARGE');
      return true;
    }
  );

  assert.equal(streamDestroyed, true, 'Stream must be actively destroyed upon exceeding maxBytes');
  assert.equal(requestDestroyed, true, 'Request socket must be destroyed upon exceeding maxBytes');
  console.log('  ✔ [PASS] Streaming early cut-off actively destroys response stream and socket');
}

async function testLifecycleResourceDestruction() {
  console.log('\n[3] Full Lifecycle Resource Destruction on Timeout & Abort');

  let timeoutReqDestroyed = false;
  const mockTimeoutRequest = (parsedUrl, opts, callback) => {
    opts.lookup('safe.example', {}, () => {});
    const req = new EventEmitter();
    req.destroy = () => {
      timeoutReqDestroyed = true;
    };
    req.end = () => {
      // Simulate slow / non-responsive server
    };
    return req;
  };

  const transport = candidate.createTrustedHttpTransport({
    trustedDomains: ['safe.example'],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: mockTimeoutRequest,
  });

  await assert.rejects(
    transport('https://safe.example/page', { timeoutMs: 15 }),
    (err) => {
      assert.equal(err.code, 'FETCH_TIMEOUT');
      return true;
    }
  );
  assert.equal(timeoutReqDestroyed, true, 'Underlying request must be destroyed on timeout');
  console.log('  ✔ [PASS] Underlying request socket terminated on deadline timeout (FETCH_TIMEOUT)');

  // Caller signal abort during active request
  let abortReqDestroyed = false;
  const ac = new AbortController();
  const mockAbortRequest = (parsedUrl, opts, callback) => {
    opts.lookup('safe.example', {}, () => {});
    const req = new EventEmitter();
    req.destroy = () => {
      abortReqDestroyed = true;
    };
    req.end = () => {
      queueMicrotask(() => ac.abort());
    };
    return req;
  };

  const abortTransport = candidate.createTrustedHttpTransport({
    trustedDomains: ['safe.example'],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: mockAbortRequest,
  });

  const abortPromise = abortTransport('https://safe.example/page', { signal: ac.signal });

  await assert.rejects(abortPromise, (err) => {
    assert.equal(err.code, 'RUN_CANCELLED');
    return true;
  });
  assert.equal(abortReqDestroyed, true, 'Underlying request must be destroyed on signal abort');
  console.log('  ✔ [PASS] Underlying request socket terminated on abort signal (RUN_CANCELLED)');
}

async function testPublicErrorAndCauseSanitization() {
  console.log('\n[4] Public Error Sanitization & Cause Boundary');

  const marker = 'SYNTHETIC_SECOND_COOKIE';
  const cookieString = `network Cookie: sid=first; preference=${marker}`;
  const sanitized = candidate.sanitizeError(cookieString);

  assert.ok(!sanitized.includes(marker), 'Multi-value cookie marker must NOT survive sanitizeError');
  assert.ok(!sanitized.includes('preference='), 'preference cookie key must be redacted');
  console.log('  ✔ [PASS] Multi-value Cookie headers completely redacted in sanitizeError');

  // Verify provider boundary cause sanitization in createDshSearchProvider
  const search = candidate.createDshSearchProvider({
    ...identity,
    trustedDomains: ['safe.example'],
    searchBackend: async () => {
      const err = new Error(`Cookie: sid=first; preference=${marker}`);
      err.cause = new Error(`Nested raw cause preference=${marker}`);
      throw err;
    },
  });

  await assert.rejects(search.search({ query: 'fixture' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR');
    assert.ok(!error.message.includes(marker), 'Provider error message must NOT leak marker');
    assert.ok(error.cause, 'Cause must be present');
    assert.ok(!error.cause.message.includes(marker), 'Provider cause message must NOT leak marker');
    return true;
  });
  console.log('  ✔ [PASS] Provider error.message and error.cause.message fully sanitized across boundary');

  // Verify fetch provider available() and error formatting
  const fetchProvider = candidate.createDshFetchProvider({
    ...identity,
    trustedDomains: ['safe.example'],
    transport: candidate.createTrustedHttpTransport({
      trustedDomains: ['safe.example'],
    }),
  });
  assert.equal(fetchProvider.available(), true, 'FetchProvider with transport must be available');
  console.log('  ✔ [PASS] DSH FetchProvider availability properly aligned with network transport');
}

async function main() {
  await testTrustedTransportDnsAndSocketPinning();
  await testStreamingReadCeilings();
  await testLifecycleResourceDestruction();
  await testPublicErrorAndCauseSanitization();
  console.log('\n=== ALL WEB04 R4 VERIFICATIONS PASSED (ZERO NETWORK CALLS) ===\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
