# T02 Google HTTP Adapter 实施证据

日期：2026-10-16。仅新增 `shell/auth-google-routes.cjs` 与 `tests/regression/google-auth-routes-test.mjs`；未修改server/auth-routes/public UI，未部署、未请求Google。以下为实现者自测，不替代独立验收。

## 集成 API

```js
const {createGoogleAuthRoutes} = require('./auth-google-routes.cjs');
const googleRoutes = await createGoogleAuthRoutes({
  db: auth.db,
  config: process.env,
  // getClientKey: trustedClientIpResolver, // 仅在可信反代边界正确配置后接入
});
// 在共享server中由唯一集成人接线，早于旧密码处理和通用Origin检查：
if (await googleRoutes.handle(req, res)) return;
```

`configured` 是配置／模块初始化状态，不是Google连通性或数据库完整性已验证；`paths.start` 固定 `/api/auth/google/start`、`paths.callback` 固定 `/api/auth/google/callback`，仅GET。配置复用实际Google模块的 `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET`／`GOOGLE_REDIRECT_URI`。redirect URI必须精确使用固定callback路径且不带query；公网仅HTTPS，本地loopback允许HTTP。配置缺失／不合法／初始化失败时已识别路由返回503安全JSON，不退回密码或共享Key。

HTTPS binding cookie为 `__Host-pt_google_binding`，本地HTTP为 `pt_google_binding`；服务器生成43位随机值，HttpOnly/SameSite=Lax/Path=/，HTTPS强制Secure，Max-Age=600。开始授权复用合法cookie以支持并行tab；callback保留binding cookie，让其他尚未完成的state继续有效。真正一次性／浏览器绑定／5分钟过期由auth-google数据库state实现，不用Cookie是否删除代替state消费。

callback只向模块传state/code/error及cookie-derived browserSessionId，不传用户身份／role／returnTo。重复state/code/error query、缺失／损坏／重复cookie直接固定跳转 `/login?error=google_auth`；失败不反射上游code、error或secret。成功仅接受安全token和未来session expiry，发兼容现有 `pt_session` Cookie并固定跳转 `/`。失败不清除已有session，防止错误回调强制登出其他正常会话。

所有已处理OAuth响应no-store/no-cache/no-referrer；不输出上游异常或凭据。start如有Origin必须与配置origin相同，Sec-Fetch-Site=cross-site拒绝；callback允许Google正常跨站顶层GET，必须由持久state＋浏览器cookie验证，而非套全局同源Origin拒绝。现有server接线必须调整此例外，仅对这条回调使用完整OAuth验证。

每个adapter独立内存限流，默认每IP每路由10次/分钟，429＋Retry-After。默认只信socket.remoteAddress，不信任Host或转发头。反代下可能全站共IP；集成人需使用已经明确边界的可信client-IP resolver，或部署外层共享限流。`getClientKey`／`authFactory`／`fetchImpl`仅可信服务器组合参数，不能由HTTP字段控制。

## 验证与限制

`node --test tests/regression/google-auth-routes-test.mjs`：**9/9 PASS**。使用直接Node req/res夹具及受控authFactory，覆盖随机安全Cookie、固定跳转、callback字段隔离、query/cookie重复与格式、Origin、缺配置、异常／token注入／错误不泄密、GET-only／限流、本地HTTP和公网HTTPS、过期session及恶意授权目的地拒绝。**未启动真实HTTP listener，未把上游stub当真实Google登录或JWT验签验收。** JWT及state底层另有T02真实密码学独立测试，本次未更改模块。

下一步由共享文件唯一集成人接线、移除可调用密码登录／注册／重置入口、补登录页与配置提示，测试真实HTTP Cookie／SSE身份兼容和浏览器回调；Google真实客户端授权、注销、会话撤销、账号禁用与首次workspace/BYOK闭环仍需独立验收。当前仅适配模块可供集成，不宣称T02完成。

## 后续集成进展

主Agent已按唯一集成责任完成server/login UI接线、旧密码API与页面退役、OAuth状态接口、workspace hook，并在Google-only迁移中撤销未绑定身份的旧密码session。具体文件与本地HTTP子进程证据见 `T02-integration.md`。本模块独立审查完成于集成之前；其“尚未挂载”的段落是审查时状态。真实Google浏览器回调、目标HTTPS反代、BYOK→AUTO→真实问答及整包独立集成验收仍待完成。
