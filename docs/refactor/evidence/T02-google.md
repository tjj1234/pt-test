# T02 · Google OIDC 独立模块证据

日期：2026-10-16。状态：**独立模块与受控集成测试完成，16/16 通过；尚未接入 HTTP／UI，真实 Google 登录待验。** 不读取 `.env`、不使用 Google／PT Key、不请求真实 Google。

## 文件与接口

| 文件 | 作用 |
|---|---|
| `shell/auth-google.cjs` | 固定 Google OAuth/OIDC 流程，jose 验证 ID token，身份映射与本地会话 |
| `shell/db-migrations/012_google_identities.sql` | issuer+subject 唯一身份、user唯一绑定、短期浏览器绑定state |
| `tests/regression/google-auth-test.mjs` | 真实隔离 PGlite＋本地 RSA 签名／JWKS＋受控 fetch，16项测试 |

模块采用已安装受支持库 `jose`；主 Agent 确认将 `jose@6.2.12` 固定为直接依赖，本子任务不修改 package/lock。工厂异步：

```js
const google = await createGoogleAuth({
  db: auth.db,
  config: { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI }
});
await google.begin({ browserSessionId });
// => { authorizationUrl, state, expiresAt }
await google.callback({ state, code, error, browserSessionId });
// => { ok:true, token, user, tenant, expiresAt }
// or { ok:false, code, error:'Google 登录未完成，请重新登录' }
```

`browserSessionId` 必须来自服务端签发的随机高熵浏览器绑定cookie，32–256个base64url字符；不是用户ID、会话ID或回调query提供的身份。state和binding仅存SHA-256，nonce和PKCE verifier短期存库，过期state在begin时清理。callback以单条DELETE RETURNING验证、消费绑定state，错误绑定不消耗合法state；合法state无论拒绝授权、兑换或验签失败都只能使用一次。HTTP层不能输出verifier、code、ID token或cookie。

固定Google授权／token／JWKS端点，无客户端可控网络地址。授权采用code＋S256 PKCE＋nonce，只请求openid/email/profile，不保存Google access token，不申请offline access。token兑换设置10秒超时且禁止重定向；JWT只接受RS256，校验签名、issuer、audience、exp/iat必需、nonce、email_verified以及多audience的azp。Google允许的两个issuer拼写归一为`https://accounts.google.com`，稳定身份始终issuer+sub，邮箱仅用于展示／冲突提示。

## 身份、事务与旧资产

首次未绑定身份在事务内建个人tenant、user和identity、session；用户role='admin'只表示自己的tenant管理员，不授予平台PM／Skill发布权。Google-only密码为随机不可用标记，现verifyPassword拒绝，不是共享密码。并发唯一冲突回滚全部事务并重查一次，避免遗留重复tenant；身份与session保存使用真实DB事务。

邮箱撞已有账号返回 `IDENTITY_BINDING_REQUIRED`，不按邮箱合并。已绑定subject重复登录保留原user/tenant ID，旧对话、文件、Key与用量不迁移、不删除。仅可信服务端显式迁移能力：

```js
await google.bindIdentity({
  issuer, subject, userId, email,
  approvedBy: '已核验归属及审批记录的内部标识'
});
```

该接口不接受浏览器直接调用，不得暴露为普通HTTP绑定路由，不得把同邮箱当归属证明。它要求已有user、唯一映射和审批标识，审批记录保存在identity的binding_approved_by字段；实际归属核验、操作员权限与审计入口由后续受控迁移流程负责。未经决策不自动迁移测试账号或删库。

返回session与现auth.login形状兼容：随机明文token只返回一次，数据库存SHA-256与有效期；测试实际调用现 `auth.getSession(token)` 读取Google会话、`auth.logout(token)`使之失效。新tenant的磁盘workspace初始化和可选analytics内部签发仍由现产品服务的幂等初始化负责，本模块不越权写文件或调用analytics。

## 验证

命令：`node --test tests/regression/google-auth-test.mjs`，**16 tests，16 pass，0 fail，exit 0**。全部在内存PGlite；固定Google端点由测试fetch完全接管，本地签名JWT通过真实jose与受控JWKS验签。覆盖：首登PKCE/session、重复登录ID稳定、现auth会话兼容/注销、state绑定/重放/过期、拒绝授权、错误issuer/aud/azp/多aud/nonce/email_verified/expiry、伪造签名、受控旧账号绑定与旧ID保留、同subject并发创建、错误脱敏、配置URL协议和合法issuer归一。

PGlite并发测试证明该实现的事务和约束行为，尚不替代真实PostgreSQL并发竞争验收。没有接线也没有声称密码路由已关闭或Google端到端可用。

## 主 Agent HTTP 接线要求

1. 启动时配置三项GOOGLE变量，缺失时返回明确未配置状态；不回退密码或共享管理员登录。使用固定且已登记的redirect URI。
2. begin签发独立随机cookie并绑定state；cookie HttpOnly、SameSite=Lax、生产Secure、固定Path，反代信任与HTTPS按既有策略处理；callback只读该cookie，不从query读binding。
3. callback成功复用现登录cookie写入与注销机制，随后幂等准备workspace；清理一次性绑定cookie。失败仅用结构化code与固定提示，禁止反射Google原始error_description。
4. 移除旧密码注册／登录／找回入口及生产可调用路由；旧数据保留。不要把admin当全局PM。
5. trusted binding只供授权归属核验后的迁移操作，不开放员工自助按邮箱认领。已禁用账号与本地会话撤销策略需同产品用户生命周期接线。
6. 补真实Google首登、再次登录、拒绝授权、过期、HTTPS cookie与部署回调验收；受控测试不证明Google Console配置、浏览器或生产登录通过。
