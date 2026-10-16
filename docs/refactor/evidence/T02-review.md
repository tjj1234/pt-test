# T02 Google 身份模块独立审查

日期：2026-10-16。审查当前 `shell/auth-google.cjs`、`012_google_identities.sql` 与 google-auth-test；审查者未参与实现。新增独立测试 `tests/regression/google-auth-review-test.mjs`，没有修改实现或依赖。

**独立模块结论：PASS（离线真实密码学＋PGlite范围），不能称 Web Google 登录已交付。** 实跑 `node --test tests/regression/google-auth-review-test.mjs`：**5/5 PASS，exit 0**。测试每项使用独立落盘真 PGlite、真实迁移；使用 jose 真 RS256 签名／验签与受控 JWKS 响应，不是把 verifier 改为总返回成功。fetch 只注入本地响应，没有联系 Google 或付费服务。

| 验收面 | 独立实际证据 |
|---|---|
| 验签负向 | 发布公钥A，却用另一独立RSA私钥B签名同kid JWT；callback拒绝，sessions仍0行。不是仅改token字段或跳过验签 |
| claims负向 | 对真实有效签名分别修改nonce、aud、azp、多aud错误azp、iss、超过30秒容差的过期exp、字符串email_verified；均拒绝，users仍0行 |
| state持久化 | begin写库后真正close再以同目录重开PGlite、新建Google auth实例；错误浏览器回调拒绝且不exchange；正确浏览器两个并发callback一次成功、另一次INVALID_OAUTH_STATE，仅一次token exchange |
| 旧账号隔离 | 建立大写同邮箱旧viewer账号；Google首次登录返回IDENTITY_BINDING_REQUIRED，google_identities仍0行，无email自动合并 |
| 受控绑定 | 缺approvedBy的bind拒绝；显式trusted migration绑定后仍使用旧userId/tenantId/role=viewer，没有提权成首次账号admin |
| 旧session兼容 | 在该真实DB上临时注入db.open，调用实际旧initAuth/getSession/logout，Google产生的session可读取并登出，退出后getSession=null。没有运行HTTP/Cookie |
| 错误保密 | 受控exchange抛带合成secret与code的Error；结果无原文，并且state已消费、重试拒绝 |

阅读核对：jwtVerify限制RS256、issuer与audience并要求exp/iat/nonce等claims；多aud要求azp匹配，提供azp时也检查；issuer两种合法写法统一存储；state消费绑定浏览器hash与过期时间；callback不接受role/tenant/userId/任意returnTo。原测试已有expiry、PKCE、deny与合法multi-aud场景；本报告只把上表独立实际跑过的内容作为独立证据，不把原自测转述为已独立复现。

## 边界与后续门禁

- `bindIdentity` 是显式可信服务端迁移能力，不是证明approvedBy字符串的人就可自助绑定。HTTP接线必须不公开此方法，不接收callback/request的userId作为可信目标，另有身份所有权与审批证据。本模块没有独立验证操作员权限，依赖组合层，不能把注释算作完整授权功能。
- 浏览器绑定ID需要HTTP层安全生成及Secure/HttpOnly/SameSite策略，不能由客户端任意自报；Origin/CSRF、限流、回调路由、前端入口、生产Google应用、真实凭据与用户授权均未在本模块测试。
- state在token交换前消费；网络失败需要重新开始授权，不允许重放旧state。此行为本组验证通过，前端需给重新登录提示。
- 未验证真正Google JWKS轮换／网络超时、生产代理、真实Google token、PostgreSQL多进程争抢与完整账号禁用／删除链路。已有session兼容只限真实仓储函数，不等于Cookie生命周期端到端通过。
- `iat`存在和数值类型由JWT库检查；当前没有额外产品级token最大年龄／未来iat容差规则。Google正常签发与重放限制还依赖nonce及exp；如后续要求更严格时间策略，须明确规则并测试，不在本轮虚构已验证的策略。

最终放行仅针对模块此组边界，T02整体仍等待HTTP/UI接线、真实Google验收及旧密码入口退出的完整测试；不宣称「Google单一登录已上线」。
