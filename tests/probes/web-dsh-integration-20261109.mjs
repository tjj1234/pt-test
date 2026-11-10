import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const {
  createWebResearcher,
  createDshSearchProvider,
  createDshFetchProvider,
  registerToDsh,
  computeEffectiveTrustedDomains,
  validateUrl,
  isPrivateIp,
  sha256,
} = await import('../../shell/candidates/web-20261103/index.cjs');

const cordisModule = await import(path.join(root, 'shell/node_modules/@deepseek-ai/cordis/lib/index.js'));
const { Context, Service } = cordisModule;
const dshWebModule = await import(path.join(root, 'shell/node_modules/@deepseek-ai/dsh-web/lib/index.js'));
const { WebRuntime } = dshWebModule;
const toolWebModule = await import(path.join(root, 'shell/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js'));

let passed = 0;
function pass(msg) {
  console.log(`  ✔ [PASS] ${msg}`);
  passed++;
}

async function run() {
  console.log('\n=== DSH 原生 WEB 接缝集成探针 ===\n');

  // [1] DSH Provider 契约与独立可用性 (W04-R1-06)
  console.log('[1] DSH Provider 契约与独立可用性');
  {
    const searchProv = createDshSearchProvider({
      trustedDomains: ['example.com'],
      searchBackend: async () => [{ url: 'https://example.com/a', snippet: 'A' }],
    });
    assert.equal(typeof searchProv.id, 'string');
    assert.equal(searchProv.available(), true);

    // 未配置 searchBackend 时，available 必须返回 false
    const unavailableSearch = createDshSearchProvider({
      provider: 'local-stub',
    });
    assert.equal(unavailableSearch.available(), false, '无真实后端时 available() 必须为 false');

    const fetchProv = createDshFetchProvider({
      trustedDomains: ['example.com'],
      customFetcher: async () => ({ content: 'hello', byteLength: 5 }),
    });
    assert.equal(typeof fetchProv.id, 'string');
    assert.equal(fetchProv.available(), true);

    const unavailableFetch = createDshFetchProvider({
      allowNetwork: true, // 仅传 allowNetwork 但无 fetcher 仍不可用
    });
    assert.equal(unavailableFetch.available(), false, '无 fetcher 实例时 available() 必须为 false');

    pass('createDshSearchProvider 和 createDshFetchProvider 诚实实现 available() 语义');
  }

  // [2] 注册至 ctx.web 并通过 WebRuntime 调用
  console.log('\n[2] 注册至 ctx.web 并通过 WebRuntime 调用');
  {
    const ctx = new Context();
    new WebRuntime(ctx);

    const dispose = registerToDsh(ctx, {
      trustedDomains: ['docs.python.org'],
      searchBackend: async ({ query }) => [
        { url: 'https://docs.python.org/3/library/os.html', title: 'os module', snippet: 'OS interface' },
        { url: 'https://untrusted.com/bad', title: 'bad', snippet: 'bad' },
      ],
      customFetcher: async ({ url }) => ({
        content: '<html><body>Docs</body></html>',
        byteLength: 29,
      }),
    });

    const searchRes = await ctx.web.search({ query: 'os', maxResults: 5 });
    assert.equal(searchRes.sources.length, 1);
    assert.equal(searchRes.sources[0].url, 'https://docs.python.org/3/library/os.html');
    pass('ctx.web.search 执行成功且受信任域名自动过滤');

    const fetchRes = await ctx.web.fetch({ url: 'https://docs.python.org/3/library/os.html' });
    assert.equal(fetchRes.statusCode, 200);
    assert.equal(fetchRes.body?.type, 'text');
    assert.match(fetchRes.body?.content || '', /Docs/);
    pass('ctx.web.fetch 执行成功并规范返回 body');

    dispose();
  }

  // [3] dsh-tool-web 模型工具无缝桥接
  console.log('\n[3] dsh-tool-web 模型工具无缝桥接');
  {
    const ctx = new Context();
    new WebRuntime(ctx);

    class MockTools extends Service {
      constructor(c) {
        super(c, 'tools');
        this.tools = new Map();
      }
      register(def) {
        this.tools.set(def.name, def);
        return () => this.tools.delete(def.name);
      }
    }
    new MockTools(ctx);

    class MockSystemPrompt extends Service {
      constructor(c) {
        super(c, 'systemPrompt');
      }
      section() { return () => {}; }
    }
    new MockSystemPrompt(ctx);

    registerToDsh(ctx, {
      trustedDomains: ['docs.python.org'],
      searchBackend: async ({ query }) => [
        { url: 'https://docs.python.org/3/library/sys.html', title: 'sys module', snippet: 'Sys module' },
      ],
    });

    const config = toolWebModule.Config({ search: true, fetch: false });
    toolWebModule.apply(ctx, config);

    const webSearchTool = ctx.tools.tools.get('web_search');
    assert.ok(webSearchTool, 'web_search tool 已向 tools 注册');

    const outcome = await webSearchTool.execute(
      { queries: ['python sys'] },
      { signal: new AbortController().signal }
    );
    assert.equal(outcome.sources.length, 1);
    assert.equal(outcome.sources[0].url, 'https://docs.python.org/3/library/sys.html');
    pass('dsh-tool-web web_search 直接复用注册 provider 并成功执行');
  }

  // [4] W04-R1-01: IP CIDR 分类与白名单私网穿透防御
  console.log('\n[4] W04-R1-01: IP CIDR 分类与白名单私网穿透防御');
  {
    for (const ip of ['fc01::1', 'fd12::1', 'fe90::1', '::ffff:7f00:1']) {
      assert.equal(isPrivateIp(ip), true, `${ip} 必须被分类为私有/非公网 IP`);
    }
    // 白名单即使包含 [::1] 也绝不放行
    const loopbackRes = validateUrl('https://[::1]/', ['[::1]']);
    assert.equal(loopbackRes.ok, false);
    assert.equal(loopbackRes.code, 'PRIVATE_IP_REJECTED');
    pass('fc01/fd12/fe90/::ffff:7f00:1 正确拦截且 [::1] 无法通过白名单伪装越权');
  }

  // [5] W04-R1-02: 最终目标 URL 与逐跳网络出口验证
  console.log('\n[5] W04-R1-02: 最终目标 URL 与逐跳网络出口验证');
  {
    const redirected = createWebResearcher({
      trustedDomains: ['safe.example'],
      ctx: {
        web: {
          fetch: async () => ({
            url: 'https://127.0.0.1/private',
            statusCode: 200,
            body: { content: 'private fixture' },
          }),
        },
      },
    });
    const res = await redirected.fetchPage({
      runId: 'r',
      tenantId: 't',
      url: 'https://safe.example',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'PRIVATE_IP_REJECTED');
    pass('ctx.web.fetch 重定向到私有 IP 127.0.0.1 最终被安全拦截');
  }

  // [6] W04-R1-03: 有界 Deadline / 取消竞争与不配合后端的快速结算
  console.log('\n[6] W04-R1-03: 有界 Deadline / 取消竞争与不配合后端的快速结算');
  {
    let release;
    const controller = new AbortController();
    const wait = createWebResearcher({
      trustedDomains: ['safe.example'],
      customFetcher: () => new Promise((r) => { release = r; }),
    });
    const request = wait.fetchPage({
      runId: 'r',
      tenantId: 't',
      url: 'https://safe.example',
      timeoutMs: 5,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const early = await Promise.race([
      request.then(() => 'SETTLED'),
      new Promise((r) => setTimeout(() => r('STILL_PENDING_AFTER_ABORT'), 40)),
    ]);
    assert.equal(early, 'SETTLED', 'Abort 后必须立即结算，不等待非配合 fetcher');
    release({ content: 'fixture' });
    await request;

    let finish;
    const search = createWebResearcher({
      trustedDomains: ['safe.example'],
      searchBackend: () => new Promise((r) => { finish = r; }),
    });
    const pending = search.search('fixture', { runId: 'r', tenantId: 't', timeoutMs: 5 });
    const earlySearch = await Promise.race([
      pending.then(() => 'SETTLED'),
      new Promise((r) => setTimeout(() => r('STILL_PENDING_AFTER_DEADLINE'), 40)),
    ]);
    assert.equal(earlySearch, 'SETTLED', 'Timeout 达到时 search 必须立即结算');
    finish([]);
    await pending;

    pass('fetcher 取消与 search deadline 均实现立即结算');
  }

  // [7] W04-R1-04: maxBytes=NaN 防御与严格参数校验
  console.log('\n[7] W04-R1-04: maxBytes=NaN 防御与严格参数校验');
  {
    const widened = createWebResearcher({
      trustedDomains: ['safe.example'],
      customFetcher: async () => ({ content: 'fixture' }),
    });
    const nanRes = await widened.fetchPage({
      runId: 'r',
      tenantId: 't',
      url: 'https://safe.example',
      maxBytes: NaN,
    });
    assert.equal(nanRes.ok, false);
    assert.equal(nanRes.code, 'INVALID_INPUT');
    pass('maxBytes=NaN 被严格校验拦截返回 INVALID_INPUT');
  }

  // [8] W04-R1-05 & W04-R1-06: 宿主上下文注入与缺少 ctx.web 明确失败
  console.log('\n[8] W04-R1-05 & W04-R1-06: 宿主上下文注入与缺少 ctx.web 明确失败');
  {
    let injectedRunId = null;
    const searchProv = createDshSearchProvider({
      trustedDomains: ['safe.example'],
      searchBackend: async () => [{ url: 'https://safe.example/1', snippet: 'text' }],
      resolveContext: () => ({ runId: 'real-run-123', tenantId: 'real-tenant-456' }),
    });
    const searchOutcome = await searchProv.search({ query: 'test' });
    assert.equal(searchOutcome.sources.length, 1);
    pass('resolveContext 允许宿主注入真实 Run/Tenant 上下文');

    // registerToDsh 缺少服务必须抛出错误，不可默默 no-op
    assert.throws(
      () => registerToDsh({}, {}),
      /requires a valid Cordis context with ctx\.web/,
      '缺少 ctx.web 时 registerToDsh 必须显式报错'
    );
    pass('缺少 ctx.web 服务时显式报错');
  }

  console.log(`\n=== DSH WEB 集成探针完成：共 ${passed} 项全数通过 ===\n`);
}

run().catch((err) => {
  console.error('Fatal error in integration probe:', err);
  process.exit(1);
});
