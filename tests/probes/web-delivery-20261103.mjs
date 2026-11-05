import { createWebResearcher, validateUrl, isPrivateIp, sha256 } from '../../shell/candidates/web-20261103/index.cjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✖ [FAIL] ${message}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== WEB 可信联网研究与引用探针开始 ===\n');

  const trusted = ['docs.python.org', 'nodejs.org', 'trusted.example.com'];

  // [1] URL 基础与协议安全校验
  console.log('[1] URL 基础与协议安全校验');
  {
    const httpRes = validateUrl('http://docs.python.org/3/', trusted);
    assert(httpRes.ok === false && httpRes.code === 'HTTP_REJECTED', '非 HTTPS 协议返回 HTTP_REJECTED');

    const credRes = validateUrl('https://admin:secret@docs.python.org/', trusted);
    assert(credRes.ok === false && credRes.code === 'CREDENTIAL_IN_URL', 'URL 带有用户名密码凭据返回 CREDENTIAL_IN_URL');

    const malformed = validateUrl('not-a-valid-url', trusted);
    assert(malformed.ok === false && malformed.code === 'INVALID_URL', '畸形 URL 返回 INVALID_URL');
  }

  // [2] SSRF 私网 IP 与域名白名单拦截
  console.log('\n[2] SSRF 私网 IP 与域名白名单拦截');
  {
    const loopback = validateUrl('https://127.0.0.1/status', trusted);
    assert(loopback.ok === false && loopback.code === 'PRIVATE_IP_REJECTED', '127.0.0.1 回环 IP 返回 PRIVATE_IP_REJECTED');

    const privClassC = validateUrl('https://192.168.1.50:8443/', trusted);
    assert(privClassC.ok === false && privClassC.code === 'PRIVATE_IP_REJECTED', '192.168.x 私网 IP 返回 PRIVATE_IP_REJECTED');

    const privClassA = validateUrl('https://10.0.0.1/', trusted);
    assert(privClassA.ok === false && privClassA.code === 'PRIVATE_IP_REJECTED', '10.x 私网 IP 返回 PRIVATE_IP_REJECTED');

    const notTrusted = validateUrl('https://evil-attacker.com/leak', trusted);
    assert(notTrusted.ok === false && notTrusted.code === 'DOMAIN_NOT_TRUSTED', '非白名单域名返回 DOMAIN_NOT_TRUSTED');

    const okRes = validateUrl('https://docs.python.org/3/library/os.html', trusted);
    assert(okRes.ok === true, '合法白名单 HTTPS URL 校验通过');
  }

  // [3] fetchPage DNS 模拟私网重绑定拦截
  console.log('\n[3] fetchPage DNS 模拟私网重绑定拦截');
  {
    const researcher = createWebResearcher({
      trustedDomains: trusted,
      customDnsResolver: async (host) => {
        if (host === 'trusted.example.com') return '10.20.30.40'; // 模拟 DNS 重绑定到私网
        return '93.184.216.34';
      },
    });

    const res = await researcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://trusted.example.com/api',
    });
    assert(res.ok === false && res.code === 'PRIVATE_IP_REJECTED', 'DNS 解析到私网返回 PRIVATE_IP_REJECTED');
  }

  // [4] 默认离线环境安全检测
  console.log('\n[4] 默认离线环境安全检测');
  {
    const offlineResearcher = createWebResearcher({ trustedDomains: trusted });
    const res = await offlineResearcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://docs.python.org/3/',
    });
    assert(res.ok === false && res.code === 'NETWORK_BLOCKED', '离线环境默认安全拦截返回 NETWORK_BLOCKED');
  }

  // [5] fetchPage 模拟抓取与 SHA256 确定性
  console.log('\n[5] fetchPage 模拟抓取与 SHA256 确定性');
  {
    const pageHtml = '<html><head><title>Node.js Docs</title></head><body>Buffer API specification</body></html>';
    const researcher = createWebResearcher({
      trustedDomains: trusted,
      customFetcher: async ({ url }) => ({
        url,
        title: 'Node.js Docs',
        content: pageHtml,
        byteLength: Buffer.byteLength(pageHtml, 'utf8'),
      }),
    });

    const res1 = await researcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://nodejs.org/api/buffer.html',
    });
    assert(res1.ok === true, '抓取成功 ok=true');
    assert(res1.title === 'Node.js Docs', 'title 提取准确');
    assert(res1.contentSha256 === sha256(pageHtml), 'contentSha256 计算精确');

    const res2 = await researcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://nodejs.org/api/buffer.html',
    });
    assert(res1.contentSha256 === res2.contentSha256, '多次抓取具有确定性与幂等性 SHA256 证据');
  }

  // [6] fetchPage 资源与生命周期异常处理
  console.log('\n[6] fetchPage 资源与生命周期异常处理');
  {
    // 内容超限
    const largeResearcher = createWebResearcher({
      trustedDomains: trusted,
      customFetcher: async () => ({
        byteLength: 200000,
        content: 'x',
      }),
    });
    const resLarge = await largeResearcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://docs.python.org/big',
      maxBytes: 1000,
    });
    assert(resLarge.ok === false && resLarge.code === 'CONTENT_TOO_LARGE', '内容超限返回 CONTENT_TOO_LARGE');

    // 重定向超限
    const redirResearcher = createWebResearcher({
      trustedDomains: trusted,
      customFetcher: async () => ({
        redirectCount: 5,
      }),
    });
    const resRedir = await redirResearcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://docs.python.org/redir',
    });
    assert(resRedir.ok === false && resRedir.code === 'REDIRECT_LIMIT', '重定向超限返回 REDIRECT_LIMIT');

    // 超时
    const timeoutResearcher = createWebResearcher({
      trustedDomains: trusted,
      customFetcher: async () => ({
        timeout: true,
      }),
    });
    const resTimeout = await timeoutResearcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://docs.python.org/slow',
    });
    assert(resTimeout.ok === false && resTimeout.code === 'FETCH_TIMEOUT', '抓取超时返回 FETCH_TIMEOUT');

    // 外部 AbortSignal 取消
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const resAbort = await timeoutResearcher.fetchPage({
      runId: 'run-w1',
      tenantId: 'tenant-1',
      url: 'https://docs.python.org/cancelled',
      signal: abortCtrl.signal,
    });
    assert(resAbort.ok === false && resAbort.code === 'RUN_CANCELLED', '信号取消返回 RUN_CANCELLED');
  }

  // [7] 搜索接口与 Citation 结构化
  console.log('\n[7] 搜索接口与 Citation 结构化');
  {
    const stubResearcher = createWebResearcher({ trustedDomains: trusted });
    const stubSearch = await stubResearcher.search('python asyncio', {
      runId: 'run-w1',
      tenantId: 'tenant-1',
    });
    assert(stubSearch.blocked === true, '离线状态 search 返回 blocked=true');
    assert(stubSearch.results.length === 0, '无外部引擎时返回空结果列表');

    // 带模拟后端
    const backendResearcher = createWebResearcher({
      trustedDomains: trusted,
      provider: 'mock-search-engine',
      searchBackend: async () => [
        {
          url: 'https://docs.python.org/3/library/asyncio.html',
          title: 'asyncio — Asynchronous I/O',
          snippet: 'asyncio is a library to write concurrent code using the async/await syntax.',
        },
        {
          url: 'https://untrusted-site.com/bad',
          title: 'Untrusted',
          snippet: 'Should be filtered out',
        },
        {
          url: 'https://nodejs.org/api/async_hooks.html',
          title: 'Async hooks | Node.js',
          snippet: 'The node:async_hooks module provides an API to track asynchronous resources.',
        },
      ],
    });

    const hits = await backendResearcher.search('asynchronous', {
      runId: 'run-w1',
      tenantId: 'tenant-1',
      maxResults: 5,
    });

    assert(hits.blocked === false, '搜索正常返回 blocked=false');
    assert(hits.provider === 'mock-search-engine', '提供商名称正确');
    assert(hits.results.length === 2, '自动过滤未受信任域名（保留2条）');

    const first = hits.results[0];
    assert(first.citation.index === 1, '第1条引用 index=1');
    assert(first.citation.url === 'https://docs.python.org/3/library/asyncio.html', '引用 URL 正确');
    assert(first.contentSha256 === sha256(first.snippet), '结果生成确定性 SHA256');

    const second = hits.results[1];
    assert(second.citation.index === 2, '第2条引用 index=2');
  }

  // [8] 搜索参数约束
  console.log('\n[8] 搜索参数约束');
  {
    const stubResearcher = createWebResearcher({ trustedDomains: trusted });
    let queryTooLong = false;
    try {
      await stubResearcher.search('a'.repeat(600), { runId: 'run-w1', tenantId: 'tenant-1' });
    } catch (e) {
      queryTooLong = e.code === 'INVALID_INPUT';
    }
    assert(queryTooLong, 'query 超过 512 字符抛出 INVALID_INPUT');
  }

  console.log(`\n=== WEB 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Web probe fatal error:', err);
  process.exit(1);
});
