'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.WEB04_REVIEW_ROOT;
if (!root) throw Error('Explicit WEB04_REVIEW_ROOT required');
const candidate = require(path.join(root, 'shell/candidates/web-20261103/index.cjs'));
const identity = { runId: 'fixture-run', tenantId: 'fixture-tenant' };
const url = 'https://safe.example/page';
(async () => {
  const order = [];
  let observedIps;
  const redirects = candidate.createWebResearcher({ trustedDomains: ['safe.example'],
    customDnsResolver: async () => ['8.8.8.8'],
    customFetcher: async ({ resolvedIps }) => {
      observedIps = resolvedIps;
      order.push('backend-produced-result');
      return { statusCode: 200, url, hops: ['https://127.0.0.1/private'], content: 'fixture' };
    },
  });
  const result = await redirects.fetchPage({ ...identity, url });
  order.push('wrapper-policy-result');
  assert.deepEqual(observedIps, ['8.8.8.8']);
  assert.equal(result.code, 'PRIVATE_IP_REJECTED');
  assert.deepEqual(order, ['backend-produced-result', 'wrapper-policy-result']);
  console.log('CONFIRMED: resolvedIps forwarded; private hops rejected only after backend-produced result; no socket binding proved');

  let started = false;
  const emptyDns = candidate.createWebResearcher({ trustedDomains: ['safe.example'],
    customDnsResolver: async () => [], customFetcher: async ({ resolvedIps }) => {
      started = true; assert.deepEqual(resolvedIps, []);
      return { statusCode: 200, content: 'fixture' };
    },
  });
  assert.equal((await emptyDns.fetchPage({ ...identity, url })).ok, true);
  assert.equal(started, true);
  console.log('CONFIRMED: empty DNS answer still starts backend and accepts content; no validated transport provenance required');

  let consumed = 0;
  const size = candidate.createWebResearcher({ trustedDomains: ['safe.example'],
    customFetcher: async () => {
      const chunks = [];
      for (let i = 0; i < 3; i++) { consumed += 8; chunks.push(Buffer.alloc(8)); }
      return { statusCode: 200, content: Buffer.concat(chunks) };
    },
  });
  assert.equal((await size.fetchPage({ ...identity, url, maxBytes: 8 })).code, 'CONTENT_TOO_LARGE');
  assert.equal(consumed, 24);
  console.log('CONFIRMED: 8-byte policy rejects only after synthetic backend consumed 24 bytes; transport read/decompression cap unproved');

  let release, active = false, signal;
  const resources = candidate.createWebResearcher({ trustedDomains: ['safe.example'],
    customFetcher: input => { signal = input.signal; active = true;
      return new Promise(resolve => { release = () => { active = false; resolve({ content: 'late' }); }; });
    },
  });
  try {
    assert.equal((await resources.fetchPage({ ...identity, url, timeoutMs: 5 })).code, 'FETCH_TIMEOUT');
    assert.equal(signal.aborted, true); assert.equal(active, true);
    console.log('CONFIRMED: wrapper deadline and aborted signal work; synthetic noncooperative backend remains active until explicit fixture release');
  } finally { release?.(); }

  const marker = 'SYNTHETIC_SECOND_COOKIE';
  assert.ok(candidate.sanitizeError(`network Cookie: sid=first; preference=${marker}`).includes(marker));
  const search = candidate.createDshSearchProvider({ ...identity, trustedDomains: ['safe.example'],
    searchBackend: async () => { throw Error(`Cookie: sid=first; preference=${marker}`); },
  });
  await assert.rejects(search.search({ query: 'fixture' }), error => {
    assert.ok(error.message.includes(marker)); assert.ok(error.cause.message.includes(marker)); return true;
  });
  console.log('REPRODUCED: multi-value Cookie survives public provider error and raw cause; synthetic markers only');
  console.log('ZERO NETWORK; synthetic backend ordering and lifecycle evidence only, no private network access; fixture promises released');
})().catch(error => { console.error(error); process.exitCode = 1; });
