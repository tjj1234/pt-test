'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = process.env.WEB04_REVIEW_ROOT || path.resolve(__dirname, '../..');
const {
  createWebResearcher,
  validateUrl,
  isPrivateIp,
  validateBoundedMaxBytes,
  sanitizeError,
} = require(path.join(root, 'shell/candidates/web-20261103/index.cjs'));

const identity = { runId: 'lifecycle-run', tenantId: 'lifecycle-tenant' };

async function run() {
  console.log('\n=== WEB04 R2 Lifecycle & Matrix Review Probe ===\n');

  // [1] 统一硬限额与 maxBytes=Infinity 防御
  console.log('[1] 统一硬限额与 maxBytes=Infinity 防御');
  {
    // 构造配置检测
    let constructorThrew = false;
    try {
      createWebResearcher({ maxBytes: Infinity });
    } catch (e) {
      constructorThrew = e.code === 'INVALID_INPUT';
    }
    assert.equal(constructorThrew, true, '构造函数传入 maxBytes=Infinity 必须抛出 INVALID_INPUT');

    let constructorExceeded = false;
    try {
      createWebResearcher({ maxBytes: 20 * 1024 * 1024 }); // 20MB > 10MB
    } catch (e) {
      constructorExceeded = e.code === 'INVALID_INPUT';
    }
    assert.equal(constructorExceeded, true, '构造函数传入超 10MB 必须抛出 INVALID_INPUT');

    // 单次请求检测
    const researcher = createWebResearcher({ trustedDomains: ['safe.example'] });
    const infReq = await researcher.fetchPage({ ...identity, url: 'https://safe.example', maxBytes: Infinity });
    assert.equal(infReq.ok, false, '单次请求 maxBytes=Infinity 必须失败');
    assert.equal(infReq.code, 'INVALID_INPUT');

    const nanReq = await researcher.fetchPage({ ...identity, url: 'https://safe.example', maxBytes: NaN });
    assert.equal(nanReq.ok, false, '单次请求 maxBytes=NaN 必须失败');
    assert.equal(nanReq.code, 'INVALID_INPUT');

    const overReq = await researcher.fetchPage({ ...identity, url: 'https://safe.example', maxBytes: 15 * 1024 * 1024 });
    assert.equal(overReq.ok, false, '单次请求超 10MB 必须失败');
    assert.equal(overReq.code, 'INVALID_INPUT');

    console.log('  ✔ [PASS] 构造配置与单次请求严格共享有限整数校验与 10MB 硬上限');
  }

  // [2] 全生命周期 deadline / 取消联动底层 AbortController (含 DNS 等待)
  console.log('\n[2] 全生命周期 deadline / 取消联动底层 AbortController (含 DNS 等待)');
  {
    // A. DNS 等待纳入取消与超时竞争
    let dnsAborted = false;
    const dnsHangingResearcher = createWebResearcher({
      trustedDomains: ['safe.example'],
      customDnsResolver: async (hostname, opts) => {
        return new Promise((resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              dnsAborted = true;
              reject(new Error('DNS aborted by signal'));
            });
          }
        });
      },
    });

    const ac = new AbortController();
    const dnsReq = dnsHangingResearcher.fetchPage({
      ...identity,
      url: 'https://safe.example',
      timeoutMs: 10,
      signal: ac.signal,
    });
    const earlyDns = await Promise.race([
      dnsReq.then(() => 'SETTLED'),
      new Promise((r) => setTimeout(() => r('PENDING_TIMEOUT'), 50)),
    ]);
    assert.equal(earlyDns, 'SETTLED', 'DNS 挂起时超时触发必须立即结算 fetchPage');
    assert.equal(dnsAborted, true, '底层 DNS 等待必须收到 linkedSignal abort 终止通知');

    // B. 自定义抓取器底层 signal 联动
    let fetcherAborted = false;
    const fetcherHangingResearcher = createWebResearcher({
      trustedDomains: ['safe.example'],
      customFetcher: async (req) => {
        return new Promise((resolve) => {
          if (req?.signal) {
            req.signal.addEventListener('abort', () => {
              fetcherAborted = true;
              resolve({ aborted: true });
            });
          }
        });
      },
    });

    const fetcherReq = fetcherHangingResearcher.fetchPage({
      ...identity,
      url: 'https://safe.example',
      timeoutMs: 10,
    });
    const earlyFetcher = await Promise.race([
      fetcherReq.then(() => 'SETTLED'),
      new Promise((r) => setTimeout(() => r('PENDING_TIMEOUT'), 50)),
    ]);
    assert.equal(earlyFetcher, 'SETTLED', 'fetcher 挂起时超时触发必须立即结算');
    assert.equal(fetcherAborted, true, '底层 fetcher 必须联动收到 AbortController 终止信号');

    console.log('  ✔ [PASS] 全生命周期联动底层 AbortController，DNS 与网络等待均真实终止');
  }

  // [3] 状态与证据真实性 (HTTP 500 不得成功，失败正文不得包装成引用)
  console.log('\n[3] 状态与证据真实性 (HTTP 500 不得成功，失败正文不得包装成引用)');
  {
    const errorResearcher = createWebResearcher({
      trustedDomains: ['safe.example'],
      customFetcher: async () => ({
        statusCode: 500,
        statusText: 'Internal Server Error',
        content: '{"error":"database failure at /var/run/secrets/key"}',
      }),
    });

    const errRes = await errorResearcher.fetchPage({
      ...identity,
      url: 'https://safe.example/data',
    });
    assert.equal(errRes.ok, false, 'HTTP 500 绝对不得返回 ok: true');
    assert.equal(errRes.code, 'FETCH_ERROR');
    assert.equal(errRes.status, 500);
    assert.equal(errRes.content, undefined, '失败正文不得作为内容发布');
    assert.equal(errRes.contentSha256, undefined, '失败正文不得生成内容 hash 证据');

    const notFoundResearcher = createWebResearcher({
      trustedDomains: ['safe.example'],
      customFetcher: async () => ({
        status: 404,
        statusText: 'Not Found',
        content: 'Page not found',
      }),
    });
    const notFoundRes = await notFoundResearcher.fetchPage({
      ...identity,
      url: 'https://safe.example/missing',
    });
    assert.equal(notFoundRes.ok, false, 'HTTP 404 绝对不得返回 ok: true');
    assert.equal(notFoundRes.code, 'FETCH_ERROR');

    console.log('  ✔ [PASS] HTTP 500/404 真实校验拦截，严禁将错误正文包装为成功引用');
  }

  // [4] 错误信息脱敏 (Redaction of credentials, tokens and sensitive headers)
  console.log('\n[4] 错误信息脱敏');
  {
    const sanitized1 = sanitizeError('Failed to connect with token=secret123456 to host');
    assert.ok(!sanitized1.includes('secret123456'), 'token 必须被脱敏');

    const sanitized2 = sanitizeError('Invalid response from https://admin:password123@safe.example/path');
    assert.ok(!sanitized2.includes('password123'), 'URL 用户名密码凭据必须被脱敏');

    console.log('  ✔ [PASS] 凭据与敏感字段全路径脱敏');
  }

  // [5] W04-R1-01 至 06 全矩阵复核
  console.log('\n[5] W04-R1-01 至 06 全矩阵复核');
  {
    // IP CIDR
    for (const ip of ['fc01::1', 'fd12::1', 'fe90::1', '::ffff:7f00:1']) {
      assert.equal(isPrivateIp(ip), true, `${ip} 必须属于私网 IP`);
    }
    // 白名单不允许私网
    assert.equal(validateUrl('https://[::1]/', ['[::1]']).ok, false);
    assert.equal(validateUrl('https://127.0.0.1/', ['127.0.0.1']).ok, false);

    // 最终重定向到私网必须拦截
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
    const redirRes = await redirected.fetchPage({ ...identity, url: 'https://safe.example' });
    assert.equal(redirRes.ok, false);
    assert.equal(redirRes.code, 'PRIVATE_IP_REJECTED');

    console.log('  ✔ [PASS] 原 W04-R1-01~06 核心边界与集成约束全数保持闭环');
  }

  console.log('\n=== WEB04 R2 Lifecycle Review Probe 全项通过 ===\n');
}

run().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
