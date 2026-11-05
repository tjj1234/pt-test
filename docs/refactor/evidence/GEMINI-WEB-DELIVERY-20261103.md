# GEMINI-WEB-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/web-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**28/28 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | 协议与基础校验 | 非 HTTPS 协议返回 HTTP_REJECTED | ✔ PASS |
| 2 | 协议与基础校验 | URL 带有用户名密码凭据返回 CREDENTIAL_IN_URL | ✔ PASS |
| 3 | 协议与基础校验 | 畸形 URL 返回 INVALID_URL | ✔ PASS |
| 4 | SSRF 与白名单防护 | 127.0.0.1 回环 IP 返回 PRIVATE_IP_REJECTED | ✔ PASS |
| 5 | SSRF 与白名单防护 | 192.168.x 私网 IP 返回 PRIVATE_IP_REJECTED | ✔ PASS |
| 6 | SSRF 与白名单防护 | 10.x 私网 IP 返回 PRIVATE_IP_REJECTED | ✔ PASS |
| 7 | SSRF 与白名单防护 | 非白名单域名返回 DOMAIN_NOT_TRUSTED | ✔ PASS |
| 8 | SSRF 与白名单防护 | 合法白名单 HTTPS URL 校验通过 | ✔ PASS |
| 9 | DNS 重绑定拦截 | DNS 解析到私网返回 PRIVATE_IP_REJECTED | ✔ PASS |
| 10 | 离线环境安全 | 离线环境默认安全拦截返回 NETWORK_BLOCKED | ✔ PASS |
| 11 | 抓取与 SHA 确定性 | 抓取成功 ok=true | ✔ PASS |
| 12 | 抓取与 SHA 确定性 | title 提取准确 | ✔ PASS |
| 13 | 抓取与 SHA 确定性 | contentSha256 计算精确 | ✔ PASS |
| 14 | 抓取与 SHA 确定性 | 多次抓取具有确定性与幂等性 SHA256 证据 | ✔ PASS |
| 15 | 资源与异常限制 | 内容超限返回 CONTENT_TOO_LARGE | ✔ PASS |
| 16 | 资源与异常限制 | 重定向超限返回 REDIRECT_LIMIT | ✔ PASS |
| 17 | 资源与异常限制 | 抓取超时返回 FETCH_TIMEOUT | ✔ PASS |
| 18 | 资源与异常限制 | 信号取消返回 RUN_CANCELLED | ✔ PASS |
| 19 | 搜索与 Citation 结构化 | 离线状态 search 返回 blocked=true | ✔ PASS |
| 20 | 搜索与 Citation 结构化 | 无外部引擎时返回空结果列表 | ✔ PASS |
| 21 | 搜索与 Citation 结构化 | 搜索正常返回 blocked=false | ✔ PASS |
| 22 | 搜索与 Citation 结构化 | 提供商名称正确 | ✔ PASS |
| 23 | 搜索与 Citation 结构化 | 自动过滤未受信任域名（保留2条） | ✔ PASS |
| 24 | 搜索与 Citation 结构化 | 第1条引用 index=1 | ✔ PASS |
| 25 | 搜索与 Citation 结构化 | 引用 URL 正确 | ✔ PASS |
| 26 | 搜索与 Citation 结构化 | 结果生成确定性 SHA256 | ✔ PASS |
| 27 | 搜索与 Citation 结构化 | 第2条引用 index=2 | ✔ PASS |
| 28 | 参数合法性 | query 超过 512 字符抛出 INVALID_INPUT | ✔ PASS |

## 实现说明

- **强制 HTTPS 与凭据防护**：严格仅允许 `https://` 协议，拦截含内嵌凭据的 URL，防止鉴权信息外泄
- **SSRF 深度防御与域名白名单**：全覆盖 IPv4/IPv6 私有地址、回环地址、链路本地地址检测，并支持 DNS 解析后重绑定校验；仅放行配置的 `trustedDomains`
- **离线安全与 Fail-Closed**：未配置公网能力时，默认返回 `NETWORK_BLOCKED`（fetch）及 `blocked: true`（search），绝不尝试非法裸公网连接
- **内容证据与可追溯性**：抓取内容与搜索结果摘要均绑定确定性 `contentSha256` 与抓取时间戳 `fetchedAt`，形成可审计证据链
- **规范化引用（Citation）生成**：搜索结果按白名单校验后自动生成从 1 递增的引用索引、标题与原始 URL
- **资源限制与取消响应**：严格执行 `maxBytes`、重定向最大 3 次拦截、超时检测及 `AbortSignal` 级联取消

## 文件 SHA256

```
dd783c0e6a4f7272e9e6828e334a74a76fb8a5ba6bc723fc8f9a9babba8d039d  shell/candidates/web-20261103/CONTRACT.md
a06efd415697a5ac860fdf8662227bc2be3690594d355338c96c975cc4697caf  shell/candidates/web-20261103/index.cjs
65c6800166bb53d451d35d5b40a8852db763eb62c0c5a63fdc5cdb5a05d5b81d  tests/probes/web-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_REAL_NETWORK`: 真实公网搜索引擎 API Key（如 Tavily、Bing 等）及生产出口防火墙资格待生产运维环境开通。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (28/28 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载至联网研究工具链。
