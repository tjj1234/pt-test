import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (!process.env.WEB04_REVIEW_ROOT || !process.env.DSH_SDK_ROOT) throw Error('Explicit candidate and locked SDK roots required');
const candidate = require(path.join(process.env.WEB04_REVIEW_ROOT, 'shell/candidates/web-20261103/index.cjs'));
const sdk = name => import(pathToFileURL(path.join(process.env.DSH_SDK_ROOT, 'shell/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context, Service } = await sdk('cordis');
const { WebRuntime } = await sdk('dsh-web');
const toolWeb = await sdk('dsh-tool-web');
const identity = { runId: 'fixture-run', tenantId: 'fixture-tenant' };
const target = 'https://safe.example/page';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real locked native tool execute + render; mock only the backend and registry services.
const ctx = new Context();
new WebRuntime(ctx);
class Tools extends Service {
  constructor(c) { super(c, 'tools'); this.defs = new Map(); }
  register(def) { this.defs.set(def.name, def); return () => this.defs.delete(def.name); }
}
class Prompt extends Service {
  constructor(c) { super(c, 'systemPrompt'); }
  section() { return () => {}; }
}
new Tools(ctx); new Prompt(ctx);
let backendStatus = 200;
const dispose = candidate.registerToDsh(ctx, {
  ...identity, trustedDomains: ['safe.example'],
  customFetcher: async () => ({ statusCode: backendStatus, content: 'fixture text' }),
});
try {
  toolWeb.apply(ctx, toolWeb.Config({ search: false, fetch: true }));
  const tool = ctx.tools.defs.get('web_fetch');
  assert.ok(tool);
  const result = await tool.execute({ url: target }, { signal: new AbortController().signal });
  assert.equal(result.body.kind, undefined);
  assert.throws(() => tool.output.render({ url: target }, result));
  console.log('REPRODUCED native web_fetch: execute loses body kind; real output renderer throws');
  backendStatus = 500;
  await assert.rejects(tool.execute({ url: target }, { signal: new AbortController().signal }), TypeError);
  console.log('REPRODUCED native web_fetch HTTP 500: provider omits required body; real execute throws TypeError');
} finally { dispose(); }

let fetchSignal, releaseFetch;
const timed = candidate.createWebResearcher({ trustedDomains: ['safe.example'], customFetcher: ({ signal }) => {
  fetchSignal = signal; return new Promise(resolve => { releaseFetch = resolve; });
} });
const timeoutResult = await timed.fetchPage({ ...identity, url: target, timeoutMs: 5 });
assert.equal(timeoutResult.code, 'RUN_CANCELLED');
assert.equal(fetchSignal.aborted, true);
releaseFetch({ statusCode: 200, content: 'late' });
console.log('REPRODUCED deadline reports RUN_CANCELLED, while backend signal is aborted; no resource-close evidence for noncooperative backend');

let releaseSearch;
const search = candidate.createDshSearchProvider({ ...identity, trustedDomains: ['safe.example'], timeoutMs: 5,
  searchBackend: () => new Promise(resolve => { releaseSearch = resolve; }) });
try {
  await assert.rejects(search.search({ query: 'fixture' }), error => error.code === 'WEB_PROVIDER_ERROR');
  console.log('REPRODUCED search deadline loses FETCH_TIMEOUT classification at provider boundary');
} finally { releaseSearch([]); }

const ac = new AbortController();
let releaseRace;
const race = candidate.createWebResearcher({ trustedDomains: ['safe.example'], customFetcher: () => {
  ac.abort(); return new Promise(resolve => { releaseRace = resolve; });
} });
const raceRequest = race.fetchPage({ ...identity, url: target, timeoutMs: 5, signal: ac.signal });
const raced = await Promise.race([raceRequest.then(() => 'SETTLED'), pause(40).then(() => 'PENDING')]);
assert.equal(raced, 'PENDING');
releaseRace({ content: 'late', statusCode: 200 }); await raceRequest;
console.log('REPRODUCED synchronous cancellation during backend start misses abort listener, pending past deadline');

const invalidStatus = candidate.createWebResearcher({ trustedDomains: ['safe.example'],
  customFetcher: async () => ({ statusCode: NaN, content: 'fixture' }) });
assert.equal((await invalidStatus.fetchPage({ ...identity, url: target })).ok, true);
console.log('REPRODUCED invalid status NaN accepted as successful content');
const nominalBackend = candidate.createDshFetchProvider({ ...identity, trustedDomains: ['safe.example'],
  fetchBackend: async () => ({ statusCode: 200, content: 'fixture' }) });
assert.equal(nominalBackend.available(), true);
assert.equal((await nominalBackend.fetch({ url: target })).statusCode, 403);
console.log('REPRODUCED fetchBackend marks provider available but is never used by fetchPage');
const marker = 'SYNTHETIC_COOKIE_VALUE';
const redacted = candidate.sanitizeError(`transport failed Cookie: session=${marker} /private/fixture/secret-file`);
assert.ok(redacted.includes(marker));
assert.ok(redacted.includes('/private/fixture/secret-file'));
console.log('REPRODUCED error sanitizer retains synthetic Cookie and local path; no real credentials used');
console.log('ZERO NETWORK; exact author module and real locked native SDK; all fixture promises released');
