# CONTRACT: 可信联网研究与引用 (web-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface WebSearchInput {
  runId: string;
  tenantId: string;
  query: string;                   // 最大 512 字符
  maxResults?: number;             // 默认 5，最大 10
  trustedDomains?: string[];       // 域名白名单（覆盖全局配置）
  timeoutMs?: number;              // 默认 10_000ms，最大 30_000ms
  signal?: AbortSignal;
}

interface FetchPageInput {
  runId: string;
  tenantId: string;
  url: string;                     // 必须 HTTPS，且域名在白名单中
  maxBytes?: number;               // 默认 131_072 (128KB)
  signal?: AbortSignal;
}
```

## 输出 Schema

```typescript
interface SearchResult {
  results: WebResult[];
  queryAt: number;                 // Unix ms
  provider: string;                // 'local-stub' | 'tavily' | ...
  blocked: boolean;                // true = 真实网络不可用
}

interface WebResult {
  url: string;
  title: string;
  snippet: string;
  fetchedAt: number;
  contentSha256: string;           // 内容 SHA256，可重现核对
  citation: Citation;
}

interface Citation {
  index: number;                   // 从 1 开始
  url: string;
  title: string;
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `NETWORK_BLOCKED` | 真实网络不可用（离线环境）|
| `DOMAIN_NOT_TRUSTED` | URL 域名不在白名单 |
| `HTTP_REJECTED` | URL 非 HTTPS |
| `PRIVATE_IP_REJECTED` | URL 解析到私有/回环 IP（SSRF 防护）|
| `FETCH_TIMEOUT` | 抓取超时 |
| `CONTENT_TOO_LARGE` | 响应超 maxBytes |
| `REDIRECT_LIMIT` | 重定向次数超限 |
| `CREDENTIAL_IN_URL` | URL 含用户名密码（拒绝）|

## 安全约束

1. **HTTPS 强制**：所有 URL 必须 https://
2. **私网拒绝**：解析后 IP 在 10./172.16-31./192.168./127./ 范围拒绝（SSRF）
3. **域名白名单**：可配置，默认空（需显式配置才可访问）
4. **凭据 URL 拒绝**：URL 含 `://user:pass@` 格式拒绝
5. **重定向跟踪**：最多 3 次，不跟踪到非白名单域名
6. **内容 sha256 可重现**：相同内容多次 fetch 相同 sha256

## BLOCKED 项目

- `BLOCKED_REAL_NETWORK`: 真实公网抓取需网络权限，离线环境用本地替身
- `BLOCKED_DNS_RESOLUTION`: 私网 IP 检测依赖真实 DNS 解析，本地替身用固定映射模拟

## DSH 原生能力

- `@deepseek-ai/dsh-tool-web`（若存在）：原生 web search tool
- 本候选在原生缺口上提供最小宿主桥，本地替身可用

## 挂载接口

```javascript
const { createWebResearcher } = require('./shell/candidates/web-20261103/index.cjs');
const researcher = createWebResearcher({ trustedDomains: ['example.com'], maxBytes: 131072 });
const result = await researcher.search(query, { runId, tenantId, signal });
```
