# T02 · Google HTTP Adapter 独立验收

日期：2026-10-16。**模块范围 PASS，可交唯一集成人接线；T02整体未完成。** 审查对象为 `shell/auth-google-routes.cjs`（含status与onAuthenticated最新扩展）、对应实现测试与HTTP实施证据。审查者未参与该HTTP adapter实现；审查者曾实现底层auth-google，本次不把底层身份模块自称再次独立验收。

冻结实现SHA-256：`9fa4ad7316858f53f607f9cc476220573db574494e548abc6293aa7de36e878f`。未修改实现、共享入口、UI或既有测试；仅新增独立测试和本报告，无提交、部署或真实Google调用。

## 独立证据

新增 `tests/regression/google-auth-routes-review-test.mjs`。实际调用HTTP adapter.handle，串联**实际auth-google模块＋真实隔离内存PGlite＋jose RS256签名／验签＋受控JWKS/token fetch**；不使用“任何token都通过”的身份验证替身。req/res为直接Node对象夹具，没有HTTP listener或浏览器；fetch只返回本地数据且断言固定Google URL，零网络／付费调用、不读.env。

| 场景 | 独立结果 |
|---|---|
| 真实模块回调接缝 | start产state、PKCE和nonce；callback实际验签后数据库有哈希session，Set-Cookie匹配实际token；request中的userId/tenantId/role/returnTo无法改变身份或固定落点 |
| 浏览器绑定与重放 | A的state配B的cookie不兑换，正确cookie仍可用；两个并发相同callback仅一个成功、一个session、一次token兑换 |
| 参数污染 | encoded重复code/error/state和重复cookie均在认证前拒绝，合法state不被这些边界解析错误消耗 |
| 错误与现有会话 | Google拒绝授权消费state，固定失败跳转，无error_description或secret泄露，不覆盖已有pt_session |
| Host与转发头 | 伪造Host、X-Forwarded-Host/Proto、X-Real-IP不能改变Google授权地址、固定redirect URI或Secure属性 |
| onAuthenticated | 收到已验证principal；hook未完成前无session Cookie或响应结束；完成后才发Cookie；hook抛私密路径／错误时失败且不发Cookie、不泄露细节 |
| status | 配置存在／缺失分别只返回`{ok:true,configured:true/false}`，no-store、无Cookie／token兑换；POST明确405＋Allow:GET |
| Cookie降级反例 | HTTPS模式下仅unprefixed pt_google_binding不能替代__Host-pt_google_binding |

命令：

```bash
node --test tests/regression/google-auth-routes-review-test.mjs tests/regression/google-auth-routes-test.mjs
```

实跑 **19/19 PASS、exit 0**：独立9项、实现10项。独立新增异步hook测试有5秒timeout，避免永不收敛时假成功。此报告只将独立9项表内行为视为独立证据，原实现10项保持实现者自测口径。

## 缺陷与交付边界

本次未发现该adapter范围的阻塞缺陷。binding cookie回调后保留是已明确的并行tab设计：一次性边界由数据库state消费保证，不要求删cookie来代替；失败不清除现有session也符合防止恶意错误回调强制登出。新建数据库session先于workspace hook，hook失败时该token不会下发，未接线前不宣称已经具备session清理或失败任务审计。

实施证据初读仍写9/9且未列新status/onAuthenticated，已提醒实现者更新至10/10并补新接口；本报告不修改实施文档。

放行只针对组合模块：实际server尚未挂载、密码路由尚未按新策略退出、登录页尚未切换，不能称“Google单一登录已交付”。真实HTTPS cookie、反代可信IP、全局Origin例外、浏览器Google跳转／Console回调配置、workspace实际初始化、注销撤销、账号禁用和首次BYOK／AUTO闭环仍需集成验收。默认socket IP在反代后共享桶的问题已在实施证据说明，集成人必须选择可信resolver／外层限流；不能把该默认写成已验证的生产IP治理。

## 后续状态

主Agent已完成server/login UI接线与真实本地HTTP子进程冒烟；详见 `T02-integration.md`。本报告中“尚未挂载／UI未切换”记录的是本轮模块验收时状态，不代表当前代码状态。共享接线的独立集成审查仍单独待做，真实Google和部署环境也未验。
