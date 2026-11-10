import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.env.WEB04_REVIEW_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const candidate = require(path.join(root, 'shell/candidates/web-20261103/index.cjs'));

const sdkRoot = process.env.DSH_SDK_ROOT || path.resolve(root, 'shell');
const sdk = (name) =>
  import(pathToFileURL(path.join(sdkRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);

const { Context, Service } = await sdk('cordis');
const { WebRuntime } = await sdk('dsh-web');
const toolWeb = await sdk('dsh-tool-web');

const identity = { runId: 'fixture-run', tenantId: 'fixture-tenant' };
const target = 'https://safe.example/page';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testNativeDshTool() {
  console.log('[1] Native web_fetch execute and render with body.kind');
  const ctx = new Context();
  new WebRuntime(ctx);
  class Tools extends Service {
    constructor(c) {
      super(c, 'tools');
      this.defs = new Map();
    }
    register(def) {
      this.defs.set(def.name, def);
      return () => this.defs.delete(def.name);
    }
  }
  class Prompt extends Service {
    constructor(c) {
      super(c, 'systemPrompt');
    }
    section() {
      return () => {};
    }
  }
  new Tools(ctx);
  new Prompt(ctx);

  let backendStatus = 200;
  const dispose = candidate.registerToDsh(ctx, {
    ...identity,
    trustedDomains: ['safe.example'],
    customFetcher: async () => ({ statusCode: backendStatus, content: 'fixture text' }),
  });

  try {
    toolWeb.apply(ctx, toolWeb.Config({ search: false, fetch: true }));
    const tool = ctx.tools.defs.get('web_fetch');
    assert.ok(tool, 'web_fetch tool must be registered');

    // 200 OK execution
    const result = await tool.execute({ url: target }, { signal: new AbortController().signal });
    assert.equal(result.body.kind, 'text', 'result.body.kind must be text');
    assert.doesNotThrow(() => tool.output.render({ url: target }, result), 'tool.output.render must succeed');
    console.log('  ✔ [PASS] 200 OK: execute preserves body.kind=text and output.render succeeds');

    // HTTP 500 execution: must return valid body, execute must not throw TypeError
    backendStatus = 500;
    const errResult = await tool.execute({ url: target }, { signal: new AbortController().signal });
    assert.ok(errResult.body, 'HTTP 500 must supply body');
    assert.equal(errResult.body.kind, 'text', 'HTTP 500 body.kind must be text');
    assert.doesNotThrow(() => tool.output.render({ url: target }, errResult), 'HTTP 500 render must not throw');
    console.log('  ✔ [PASS] HTTP 500: provider supplies valid body and execute does not throw TypeError');
  } finally {
    dispose();
  }
}

async function testDeadlineClassification() {
  console.log('\n[2] Deadline reports FETCH_TIMEOUT and aborts backend signal');
  let fetchSignal, releaseFetch;
  const timed = candidate.createWebResearcher({
    trustedDomains: ['safe.example'],
    customFetcher: ({ signal }) => {
      fetchSignal = signal;
      return new Promise((resolve) => {
        releaseFetch = resolve;
      });
    },
  });

  const timeoutResult = await timed.fetchPage({ ...identity, url: target, timeoutMs: 5 });
  assert.equal(timeoutResult.code, 'FETCH_TIMEOUT', 'timeout must report FETCH_TIMEOUT');
  assert.equal(fetchSignal.aborted, true, 'backend signal must be aborted');
  releaseFetch({ statusCode: 200, content: 'late' });
  console.log('  ✔ [PASS] Deadline reports FETCH_TIMEOUT and backend signal is actively aborted');
}

async function testSearchDeadline() {
  console.log('\n[3] Search deadline reports FETCH_TIMEOUT at provider boundary');
  let releaseSearch;
  const search = candidate.createDshSearchProvider({
    ...identity,
    trustedDomains: ['safe.example'],
    timeoutMs: 5,
    searchBackend: () =>
      new Promise((resolve) => {
        releaseSearch = resolve;
      }),
  });

  try {
    await assert.rejects(
      search.search({ query: 'fixture' }),
      (error) => error.code === 'FETCH_TIMEOUT',
      'search deadline must throw FETCH_TIMEOUT, not WEB_PROVIDER_ERROR'
    );
    console.log('  ✔ [PASS] Search deadline preserves FETCH_TIMEOUT error classification');
  } finally {
    releaseSearch([]);
  }
}

async function testSynchronousCancellation() {
  console.log('\n[4] Synchronous cancellation during backend start settles immediately');
  const ac = new AbortController();
  let releaseRace;
  const race = candidate.createWebResearcher({
    trustedDomains: ['safe.example'],
    customFetcher: () => {
      ac.abort();
      return new Promise((resolve) => {
        releaseRace = resolve;
      });
    },
  });

  const raceRequest = race.fetchPage({ ...identity, url: target, timeoutMs: 5, signal: ac.signal });
  const raced = await Promise.race([raceRequest.then(() => 'SETTLED'), pause(40).then(() => 'PENDING')]);
  assert.equal(raced, 'SETTLED', 'synchronous cancellation must settle immediately');
  releaseRace({ content: 'late', statusCode: 200 });
  await raceRequest;
  console.log('  ✔ [PASS] Synchronous cancellation caught before backend start, settles without pending');
}

async function testStatusAndBackendParity() {
  console.log('\n[5] Invalid status NaN rejected & fetchBackend wired to fetchPage');
  const invalidStatus = candidate.createWebResearcher({
    trustedDomains: ['safe.example'],
    customFetcher: async () => ({ statusCode: NaN, content: 'fixture' }),
  });
  const nanRes = await invalidStatus.fetchPage({ ...identity, url: target });
  assert.equal(nanRes.ok, false, 'status NaN must be rejected');
  assert.equal(nanRes.code, 'FETCH_ERROR');
  console.log('  ✔ [PASS] Invalid status NaN rejected as FETCH_ERROR');

  const nominalBackend = candidate.createDshFetchProvider({
    ...identity,
    trustedDomains: ['safe.example'],
    fetchBackend: async () => ({ statusCode: 200, content: 'fixture' }),
  });
  assert.equal(nominalBackend.available(), true);
  const fetchRes = await nominalBackend.fetch({ url: target });
  assert.equal(fetchRes.statusCode, 200, 'fetchBackend must be used by fetchPage to return 200');
  console.log('  ✔ [PASS] fetchBackend accurately drives fetchPage and returns statusCode 200');
}

async function testSanitizer() {
  console.log('\n[6] Error sanitizer redacts Cookie and local paths');
  const marker = 'SYNTHETIC_COOKIE_VALUE';
  const redacted = candidate.sanitizeError(`transport failed Cookie: session=${marker} /private/fixture/secret-file`);
  assert.ok(!redacted.includes(marker), 'Cookie must be redacted');
  assert.ok(!redacted.includes('/private/fixture/secret-file'), 'Local path must be redacted');
  console.log('  ✔ [PASS] Cookie value and local filesystem paths fully redacted');
}

async function main() {
  console.log('=== WEB04 R3 Native Lifecycle Fixed Verification ===\n');
  await testNativeDshTool();
  await testDeadlineClassification();
  await testSearchDeadline();
  await testSynchronousCancellation();
  await testStatusAndBackendParity();
  await testSanitizer();
  console.log('\n=== ALL WEB04 R3 FIXED TESTS PASSED ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
