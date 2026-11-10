# CONTRACT: 可信联网研究与引用 (web-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
修订: Revision R4 (实际受信 Transport、流式读取/解压限额、资源销毁与公开错误全路径脱敏)

## 输入 Schema

```typescript
interface WebSearchInput {
  runId: string;
  tenantId: string;
  query: string;                   // 最大 512 字符
  maxResults?: number;             // 默认 5，最大 10
  trustedDomains?: string[];       // 域名白名单（仅允许收敛/缩小服务端配置白名单，严禁扩大）
  timeoutMs?: number;              // 默认 10_000ms，硬上限 60_000ms
  signal?: AbortSignal;
}

interface FetchPageInput {
  runId: string;
  tenantId: string;
  url: string;                     // 必须 HTTPS，且域名在有效白名单中
  maxBytes?: number;               // 默认 131_072 (128KB)，正有限整数，硬上限 10_485_760 (10MB)
  trustedDomains?: string[];       // 单次请求白名单限制
  timeoutMs?: number;              // 默认 10_000ms，硬上限 60_000ms
  signal?: AbortSignal;
}
```

## 输出 Schema

```typescript
interface SearchResult {
  results: WebResult[];
  queryAt: number;                 // Unix ms
  provider: string;                // 'local-stub' | 'dsh-ctx-web' | ...
  blocked: boolean;                // true = 真实网络不可用或被取消/超时阻断
  code?: string;                   // 状态或错误码
}

interface WebResult {
  url: string;
  title: string;
  snippet: string;
  fetchedAt: number;
  contentSha256: string;           // 内容/摘要确定性 SHA256，可重现核对
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
| `NETWORK_BLOCKED` | 真实网络不可用（离线环境且无 transport）|
| `DOMAIN_NOT_TRUSTED` | URL 域名不在白名单 |
| `HTTP_REJECTED` | URL 非 HTTPS |
| `PRIVATE_IP_REJECTED` | URL 或 DNS 解析到私有/回环 IP（SSRF 防护）|
| `DNS_UNAVAILABLE` | DNS 解析失败或返回空记录（禁止发起连接）|
| `FETCH_TIMEOUT` | 抓取超时（全链路包含 DNS、连接与流式读取）|
| `FETCH_ERROR` | 抓取失败（非 2xx 响应如 HTTP 500/404 判定失败，不发布正文）|
| `CONTENT_TOO_LARGE` | 流式读取/解压实际内容超限（流式阶段即时断流并销毁 Socket）|
| `REDIRECT_LIMIT` | 重定向次数超限（默认最多 3 跳，请求前逐跳校验）|
| `CREDENTIAL_IN_URL` | URL 含用户名密码凭据（拒绝）|
| `RUN_CANCELLED` | 任务被外部信号取消（联动底层 AbortController 真实终止连接与流）|
| `INVALID_INPUT` | 参数校验失败（如 maxBytes=Infinity/NaN、超过 10MB、无效 query 等）|

## 安全、传输与生命周期约束 (W04-R1 全矩阵)

1. **HTTPS 强制与凭据拦截**：所有 URL 必须 https://，URL 含 `://user:pass@` 格式一律拒绝；错误信息脱敏敏感凭据、Token、密码及本地路径。
2. **私网与 CIDR 策略防御 (W04-R1-01)**：完整支持 IPv4/IPv6 CIDR，涵盖回环 (127./8, ::1)、私有地址 (10./8, 172.16./12, 192.168./16)、链路本地 (169.254./16, fe80::/10)、ULA (fc00::/7)、IPv4 映射 (::ffff:0:0/96) 及特殊前缀；白名单绝对不可为私网授权。
3. **实际受信 Transport 与逐跳出网绑定 (W04-R1-02)**：
   - 导出独立受信传输工厂 `createTrustedHttpTransport`。
   - **连接前 DNS 审核**：请求发送前解析全部 DNS 记录，空记录或含私网 IP 立即拒绝；
   - **真实 Socket 绑定**：通过定制 `lookup` 回调将底层 socket 严格绑定至前置校验的公网 IP，同时保留 TLS SNI 主机名证书验证；
   - **逐跳重定向安全**：响应重定向（301/302/303/307/308）前销毁当前流与连接，下一跳请求发送前强制重新执行 URL 合法性、白名单与 DNS 审核；最终目标也进行一致性核验。
4. **流式限额与资源真实终止 (W04-R1-03 / W04-R1-04)**：
   - 构造配置与单次请求统一共享正有限整数上下界，硬上限 10MB；
   - **流式阶段早期断流**：在响应流 `data` 事件与解压流中实时累加字节，一旦超出 `maxBytes` 立即调用 `req.destroy()` 与 `stream.destroy()`，拒绝继续消费网络带宽与内存；
   - **全生命周期 Deadline 与取消联动**：DNS 解析、连接建立、数据流读取全程纳入 AbortController 联动；超时或取消信号到达时真实终止底层网络句柄，无挂起泄漏任务。
5. **公开错误脱敏与证据边界 (W04-R1-05)**：
   - 全路径脱敏多项 Cookie（`Cookie: ...`、`Set-Cookie: ...`）、`Authorization: Bearer ...`、URL Query 凭据与本地文件路径；
   - DSH Provider 边界（`createDshSearchProvider` / `createDshFetchProvider`）对抛出的公开异常 `error.message` 以及嵌套 `error.cause.message` 执行严格脱敏，不泄漏原始凭据；
   - 支持宿主通过 `resolveContext(req)` 注入真实可信 `runId` / `tenantId` 上下文。
6. **可用性与依赖边界声明 (W04-R1-06)**：
   - `available()` 语义诚实反映抓取后端状态，仅提供名称或 `allowNetwork: true` 而无真实 transport / fetcher 时明确返回 `false`；
   - 注册入 DSH 时若缺少 `ctx.web` 服务显式报错；支持返回 disposer 清理所有注册。

## 责任矩阵分工

| 责任项 | 提供方 | 机制与证据 |
|--------|--------|------------|
| 工具注册、路由选择与分派 | DSH 原生（`@deepseek-ai/cordis`, `dsh-web`） | `ctx.web.registerSearchProvider`, `ctx.web.registerFetchProvider` |
| 模型工具定义与调用渲染 | DSH 原生（`@deepseek-ai/dsh-tool-web`） | `web_search`, `web_fetch` 工具定义与输出渲染契约 |
| 实际 HTTP Transport、DNS 绑定与流式熔断 | 本候选模块（`createTrustedHttpTransport`） | 连接前 DNS 校验、Socket Pinning、逐跳重定向拦截、流式 bytesRead 熔断销毁 |
| 安全策略、IP CIDR 与错误脱敏 | 本候选模块（`index.cjs`） | `validateUrl`, `isPrivateIp`, `sanitizeError`, `createLinkedAbortContext` |
| 宿主 Run 上下文、预算核对与来源入库 | 宿主（Codex / PT 主程） | `resolveContext`、共享 Run 调度、计费与 Citation 持久化 |
