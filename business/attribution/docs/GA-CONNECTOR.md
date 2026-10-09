# GA 连接器：配置、基座接入与验收
分支 `feature/business-ga-connector-skill`。本模块仅使用 Google 官方 GA4 Data API；没有 CSV 回退。OAuth refresh token 通过只读引用 `shell/keys.cjs` 的 AES-256-GCM 原语加密；业务表位于 `business/attribution/schema/ga_connector.sql`，由 analytics 启动迁移注册，强制 RLS + 显式租户条件。每租户当前只绑定一个 property，重新授权会替换绑定。

## GCP 登记与运行配置
Google Cloud Console 创建 **Web application** OAuth 客户端，启用 Google Analytics Data API，配置 consent screen 与测试用户；授权账号须具有目标 GA4 property 的读取权限。请求只读 scope `https://www.googleapis.com/auth/analytics.readonly`。Data API v1 的 GA4 `runReport` 当前官方 REST 地址为 `https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport`，不是 Universal Analytics API。[官方 runReport 文档](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport)、[官方 Web Server OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)。

在 **analytics 后端进程** 注入以下环境变量，Secret 不经过对话或前端：

| 变量 | 值 / 约束 |
|---|---|
| `GA_CLIENT_ID` | GCP OAuth Web client ID |
| `GA_CLIENT_SECRET` | 同一客户端的 Secret |
| `GA_REDIRECT_URI` | `<Shell 外部 origin>/api/business/ga-connector/oauth/callback`；必须和 GCP Authorized redirect URIs 完全一致，无尾斜线、query、fragment |
| `GA_TOKEN_ENCRYPTION_KEY` | 独立随机 32 字节密钥的 base64；需持久保存并备份，所有 analytics 实例一致；更换后旧连接需重新授权 |

正式环境必须 HTTPS；本地仅允许 `http://localhost` 或 `http://127.0.0.1`。Shell 代码默认端口为 **8098**（可由 `--port` / `PT_SHELL_PORT` 覆盖）：若使用默认本地地址，登记并设置 **`http://localhost:8098/api/business/ga-connector/oauth/callback`**。尚未确认本次实际外部地址，正式域名需替换 origin；不要登记 analytics 内部端口，也不要混用 localhost 与 127.0.0.1。用户登录 Shell 后在同一浏览器打开 `<Shell origin>/api/business/ga-connector/oauth/authorize?propertyId=<数字 GA4 property ID>`。property ID 不是 `G-XXXX` measurement ID。Google 回调返回 `{ok:true,propertyId}`，不返回 token。state 有效期 10 分钟、一次性消费、绑定租户与登录 cookie，并使用 PKCE；授权期间更换登录 session 或登录 cookie 会要求重新授权。Google 未返回 refresh token / 未授予 scope 时拒绝落库。

## 基座 agent 接入契约（本分支不改 Shell）
公开入口 `business/attribution/index.js`：`gaConnector.gaQueryToolDefinition()` 与 `gaConnector.buildGaQueryExecutor({internalKey,dashPort})`。基座 `shell/tools/autoload.cjs` provider 可使用 `modulePath: "../../business/attribution/index.js"`、`definitionGetter: "gaConnector.gaQueryToolDefinition"`，executor 工厂直接调用同一公开入口导出的 `buildGaQueryExecutor`。它按 trusted `context.tenantId` 计算既有 HMAC token，内部 POST `/api/business/ga-connector/query`；Google POST runReport 是只读查询。禁止把用户输入的 tenant/property/token 作为工具参数。

`ga.query` 声明 `tool.use` + `attribution:read`，输入 `metrics`、可选 `dimensions`、`dateRange: {startDate,endDate}`、可选 `format: summary|table`。默认 summary，具体 GA4 指标名称由对话 agent 选择；Google 检查指标存在性和组合兼容性。输出类型固定 `report`，顶层严格只包含 `title/meta/stats/table`，通过现有 `OUTPUT_MOLDS.report` 校验；table 使用 `{title,head,rows}`，无结果不输出空 table，以免现有渲染器显示“暂无问题项”。原始数值字符串保持精度，不擅自汇总跨维度用户数。返回最多 10000 行并显式标记截断；metadata（时区、阈值等）保留在 stats。

**需基座核验 DSH 与抽屉桥接**：当前 main `persistent-runner.mjs` 的 setup 只显式注册 `get_current_time`；当前 `app.js` 未发现 `openReportDrawer` 调用。本次已提供工具定义、HTTP executor 与兼容 report 输出，但仅加 Shell 目录 provider 不足以证明模型可调用/结果自动打开抽屉；基座需确认真实 DSH 注册与 report 结果桥接。该依赖不通过修改业务输出伪装完成。

## 验证与证据边界
运行 `cd business/attribution && npm run test:ga`。测试使用真实 Fastify `inject`、真实 PGlite / pt_app / RLS、真实 AES-GCM，只有 Google HTTP 响应 mock。覆盖 OAuth redirect/PKCE、session/tenant/state 重放防护、过期/拒绝/缺 refresh token、SQL 密文、数据库重启恢复、跨租户 RLS、GA4 请求、summary/空结果/截断、严格 report 模具与现有 report renderer、安全错误及配置拒绝。

| 验收项 | 本次状态 / 证据 |
|---|---|
| mock Google + 真库测试 | 自动化代码 `ga-connector/connector.test.js`；日志见 `GA-CONNECTOR-TEST-EVIDENCE.txt` |
| Google 真实 OAuth 与真实库密文 | 待 GCP 环境配置、真实 property 和登录会话 |
| 对话真实 GA4 数字 | 待上述配置与基座工具加载/DSH 接入 |
| 真实 report-drawer 渲染 | 已验证纯函数 HTML 与模具；浏览器对话端到端待基座桥接 |

真实验收时记录：授权成功页面、仅含 tenant/property/iv/ciphertext 的库查询（禁止展示解密 token）、Google runReport 成功的脱敏日志和真实数值、对话 tool/call → tool/result 轨迹、抽屉截图。请求回调路由关闭 Fastify 请求日志，避免 URL 中的 code/state 泄漏；部署反代访问日志也应脱敏此路径。Google 撤销授权或 testing 模式 refresh token 失效后返回 `GA_REAUTHORIZE_REQUIRED`，要求重新授权。当前没有完成真实验收，不能标记业务交付已验收。
