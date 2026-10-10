# GA 设置页真实接线 · 2026-10-10
代码接线及隔离环境验证完成；真实 Google 账号授权待有效 GCP 配置与实际 GA4 property。分支 `feature/business-ga-settings-wiring`，基于 GA 连接器提交 `68dc7adf5a57d4c31069d1b16314af6c9ecc7684`。本次不改数据库结构。

设置页输入数字 property ID，点击「连接Google Analytics」→ Shell 已有 `/api/business/` 登录代理 → analytics OAuth authorize → Google。浏览器 OAuth callback 成功保存连接后 302 返回固定 `/settings`，页面重新读取状态；API 客户端仍收到原有 JSON。设置页移除 mock 账户和 mock 解除授权逻辑，动态内容使用 `textContent`；加载错误单独显示，不能误判为未连接。

## 状态接口
`GET /api/business/ga-connector/status`，浏览器使用同源登录 cookie，由 Shell 换成租户 HMAC token；analytics 验证 token、有效期、UUID 与 `analytics:read` scope。只使用鉴权产生的租户，忽略 query/body 中的租户值。真库查询走事务内 RLS + 显式 tenant 条件，仅 SELECT `property_id, updated_at`，不读取、解密或返回 token；不依赖 Google OAuth 环境配置。响应 `Cache-Control: no-store`。

| 状态 | HTTP / 响应 |
|---|---|
| 未连接 | 200 `{ok:true,connected:false,propertyId:null,updatedAt:null}` |
| 已连接 | 200 `{ok:true,connected:true,propertyId:"123456789",updatedAt:"..."}` |
| 缺少或过期 token | 401 |
| token 无效、scope 不足、租户非法 | 403 |
| 真库错误 | 500 / 安全错误码；UI 显示读取失败 |

`connected` 表示该租户有已保存的连接，不表示已实时复查 Google 凭证是否撤销或 property 权限是否仍有效；既有查询接口继续负责返回 `GA_REAUTHORIZE_REQUIRED` 等错误。

## 验证记录与边界
| 验证 | 结果 / 证据 |
|---|---|
| `cd business/attribution && npm run test:ga` | **13/13 PASS**；真实 Fastify inject、PGlite、pt_app/RLS、AES-GCM，Google token/Data API 响应 mock |
| 新状态接口 | 未连接/已连接、401/403、越权参数无效、无 OAuth 配置可查元数据、仅返回元数据、数据库重启恢复 |
| OAuth 回调 | JSON 契约保持；浏览器成功回调固定返回设置页 |
| 浏览器真实接线 | 实际 Shell + analytics 进程、登录/session、HMAC token 真库验证、真实 OAuth state/PKCE 与真实 SQL 落库；没有 mock 状态接口或 Shell 代理 |
| 按钮跳转 | 捕获实际 `https://accounts.google.com/o/oauth2/v2/auth` 请求，核验只读 scope 和 PKCE；使用隔离测试 client ID，Google 返回 `invalid_client`，未完成真实 Google 授权 |
| 授权后页面 | 测试 code + mock Google token 响应，经真实 callback 落库并返回设置页显示「已连接」与 property `123456789`；刷新页面仍显示已连接 |
| 页面边界 | `G-INVALID` 本地拒绝；状态 503 显示读取失败、恢复后可刷新；390px 手机布局无横向溢出 |
| 语法 / diff | `node --check shell/public/settings.js`、`git diff --check` PASS |

截图均来自上述隔离环境，`123456789` 为测试 property，不能作为真实 Google 授权成功证据：

- [未连接](evidence/ga-settings-wiring/settings-disconnected.png)
- [已连接分节](evidence/ga-settings-wiring/settings-connected.png)
- [设置页全图](evidence/ga-settings-wiring/settings-desktop.png)
- [手机分节](evidence/ga-settings-wiring/settings-mobile.png)

## 实际验收停点
按照 [GA-CONNECTOR.md](GA-CONNECTOR.md) 在 analytics 进程配置有效 OAuth client、secret、callback 与持久加密密钥；提供要测试的 Shell 地址及真实数字 property ID。mmdn 在同一浏览器登录 Shell，打开设置页填 ID 点击连接，自行完成 Google 同意授权；成功后自动返回设置页并显示 property。验收需记录真实 Google 同意页、返回设置页截图及状态响应；禁止记录 code/state/refresh token。当前未部署、未合并 main，未完成这一真实账号验收。
