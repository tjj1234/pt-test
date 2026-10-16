# T02 · Google 单一登录服务入口集成证据

日期：2026-10-16 17:02–17:14 JST。分支：`feature/northstar-phase1-refactor-20261016`。交付 commit：`98c0411f8ec101e48ff1aff1cf6397ece0356663`。本批唯一集成人：主 Agent。结论：**Google-only 服务入口与登录页集成，受控本地 HTTP 冒烟通过；真实 Google 登录／浏览器确认仍待验，T02 尚未整体完成。**

## 变更

| 文件 | 变更 |
|---|---|
| `shell/server.cjs` | 启动时不再创建默认密码管理员；装配 Google OAuth HTTP adapter；首次成功回调前幂等初始化产品工作区与租户 DSH workspace；统一退役登录、注册、忘记／重置／修改密码 API（410）；忘记／重置页面回登录；公网监听要求 Google OAuth 配置；保留登出、BYOK、会话查询既有接口 |
| `shell/db-migrations/012_google_identities.sql` | Google身份迁移时撤销未绑定Google身份的旧本地密码会话，不删除用户或租户资产；已绑定身份会话保留 |
| `shell/auth-google-routes.cjs` | 新增仅返回 `{ok,configured}` 的状态接口；新增 `onAuthenticated` trusted hook，workspace准备完成前不下发 `pt_session` Cookie，初始化失败使用固定错误跳转且不泄露内部路径 |
| `shell/auth-google.cjs` | 可信身份绑定在同一事务撤销该用户原有Session，避免绑定后旧密码Cookie继续有效 |
| `shell/public/login.html`、`shell/public/google-login.js` | 去除预填管理员账号、密码、密码注册／找回流程；加入有配置状态提示的 Google 登录按钮及固定错误提示 |
| `tests/regression/google-auth-routes-test.mjs` | 扩展到10项，覆盖status与provision hook顺序／失败无Cookie |
| `tests/regression/google-login-server-test.mjs` | 新增真实本地HTTP子进程冒烟：配置缺失状态、Google-only页面、旧密码API退役、旧密码页面重定向、无默认本地用户 |
| `tests/regression/google-session-upgrade-test.mjs` | 旧库迁移反例：本地密码会话被撤销、用户保留、绑定后的Google会话不被后续重放移除 |

## 验证

| 命令 | 环境与结论 |
|---|---|
| `node --check shell/server.cjs` | Node v24.14.0，语法通过 |
| `node --test tests/regression/google-auth-routes-test.mjs tests/regression/google-auth-routes-review-test.mjs` | 真实隔离PGlite＋受控JWT/JWKS＋route adapter夹具，19/19 PASS（adapter实现10＋独立9） |
| `node --test tests/regression/google-session-upgrade-test.mjs` | PGlite迁移夹具，1/1 PASS：旧密码态会话注销、用户身份保留、已绑定Google身份的session保留 |
| `node --test tests/regression/google-login-server-test.mjs` | 独立Node server listener、随机loopback端口、临时PGlite／master key／日志目录、未设置Google/PT凭据；1/1 PASS。完成后重开临时DB并确认users=0。首次沙箱内运行被loopback `listen EPERM`拒绝；在授权的沙箱外重跑通过，不访问外网 |
| `node --test tests/regression/google-login-integration-review-test.mjs tests/regression/google-binding-review-test.mjs` | 独立集成复核与身份绑定反例合计5项 PASS；旧密码路径、受控回调／workspace顺序、跨用户会话隔离、绑定事务失败回滚均通过 |

真实listener冒烟请求包括：`GET /healthz`、`GET /api/auth/google/status` 返回`configured:false`、`GET /login`不含默认账号／密码或注册／找回入口、旧`POST /api/auth/login`和`POST /api/auth/register`返回410、`GET /forgot`重定向到`/login`、关闭服务后数据库`users`表为空。自动化请求无线上Request-ID中间件，因此按测试名、方法／路径、HTTP断言和测试时间窗口关联；相关Node测试在2026-10-16 17:02–17:14 JST执行，完整逐项断言见测试文件。关闭采用测试专用一次性token，测试结束清理临时目录。未读取`.env`，不使用 `.env` 中余额 $0.033 的Key；没有Google token交换、PT请求或付费请求。

## 边界与待验收

未验证真实Google Cloud OAuth client、实际HTTPS/反代部署、真实浏览器回调、反代下Google route IP限流配置、已有账号人工身份绑定、登出后浏览器状态、首次用户绑PT Key并成功真实对话。缺Google配置时服务可在loopback启动并明确禁用登录；公网监听启动失败，避免无认证暴露。认证模块已持久化新用户、租户与session，但首次workspace hook失败后会留下无cookie可用的服务端session记录，需后续清理策略评估。此交付不声称Google单一登录整体验收通过。
