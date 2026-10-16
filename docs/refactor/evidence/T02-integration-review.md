# T02 · Google 单一登录 server／UI 接线独立验收

日期：2026-10-16。验收者：架构子 Agent，未参与本次 server／login／Google 接线。范围：真实产品 server、登录静态资源、012 迁移、旧密码路由与 Session 升级、OAuth route 在全局 Origin 检查前挂载、工作区初始化与 Cookie 暴露顺序。结论：**限定集成层 PASS；真实 Google／生产 HTTPS／浏览器视觉与 PT 闭环未验，T02 全包不能据此完成。**

新增检查件 `tests/regression/google-login-integration-review-test.mjs`；未修改 server、UI、Google 实现、迁移或实现方测试，未调用 Google／PT，未提交。

## 实测证据

| 检查 | 方法与实际结果 |
|---|---|
| 无默认用户／默认密码 | 原 server 测试启动完整服务，Google 未配置时配置状态 false；退出重开 PGlite users=0，没有 admin／northstar 默认账户 |
| 旧密码旁路 | 独立检查对 `/api/login`、login/register/forgot/reset/change-password 六路径逐一 GET／POST／PUT，均 410，无 Set-Cookie；已知旧账号密码无法从这些入口恢复 session |
| 迁移后旧 Session | 先用真实旧迁移建立用户并取得有效密码 Session，再启动完整 server 自动应用 012；旧 token 请求 `/api/auth/me` 为 401，原用户资产保留 |
| Google route 与 Origin 顺序 | start 带攻击站 Origin 为 403；callback 跨站 Google Origin 在有效浏览器绑定下可到达鉴权与初始化；无 binding 只失败重定向，无 session cookie |
| Cookie 与初始化 | 用受控“已验证身份交换”替身，实际 HTTP route 和 server `onAuthenticated` 不替换；callback 返回 cookie 前，租户 `.dsh/skills` 目录和 workspace metadata 已真实创建，metadata tenantId 正确，cookie 能被现有 me 识别 |
| 初始化失败 | 只破坏测试创建的 metadata，下一次 callback 失败跳回登录页且不发 session Cookie；不会让用户拿到未就绪工作区登录态 |
| 写操作 Origin | 有效测试 session 跨站 logout 被全局 Origin 校验 403，无清除 Cookie；Google callback 的跨站 GET 特例没有放开普通写操作 |
| UI 静态接线 | login.html 只挂 google-login.js 和唯一 Google 按钮，无密码输入／恢复入口；脚本状态获取失败会禁用按钮并显示错误，跳转地址固定内部 start |

外部身份替身只替换 `auth-google-routes` 的 Google token／身份交换依赖；没有测试签名、nonce、state 单次消费、JWKS 或 Google 官方可用性。HTTP、真实 PGlite、迁移、现有会话读取、server callback 初始化、文件系统与 Cookie 响应未 mock。测试身份、数据库和主密钥均临时；合成 UUID 的两个 workspace 在确认原本不存在后创建并清理，不触碰真实用户目录。

| 命令 | 实际结果 |
|---|---|
| `node --test tests/regression/google-login-integration-review-test.mjs` | 1／1 PASS（含旧库→真实服务升级、18种旧路由请求、受控回调与故障注入） |
| `node --test tests/regression/google-login-server-test.mjs` | 1／1 PASS，原实现测试保持不变 |
| `node --test tests/regression/google-session-upgrade-test.mjs` | 1／1 PASS，012 保留用户、撤销未绑定用户 Session、已绑定用户有效 Session 重跑保留 |

首次独立 HTTP 测试因沙箱 `listen EPERM 127.0.0.1` 失败；按批准后权限重跑，上述服务测试均成功，不把沙箱失败计为产品缺陷，也不静默跳过。

## 边界与维护要求

012 对未绑定 Google 身份的密码用户撤销旧 Session，并保留已经有 Google identity 的有效 Session。另已加固未来受信任人工绑定路径：绑定 identity 与撤销该用户全部现存 Session 在同一事务执行，避免旧密码 Cookie 在绑定后继续有效；实现方回归断言及独立复核结论补记于后续证据增量。

真实 Google consent、issuer／signature／nonce／PKCE、安全 HTTPS Cookie 在目标反代下工作、账号禁用、身份绑定迁移审批、实际浏览器可用性与首次绑 BYOK 后真实 Agent，均不在本次集成验收。缺少 Google 生产配置时产品登录不可用应明确阻塞，不能提供密码兜底。受控回调成功不是 Google OAuth 全链路通过。

## 可信绑定维护提示更新

后续 `bindIdentity` 已增加同事务撤销该用户全部现存 Session；独立实库审查 18／18 通过，见 `T02-binding-review.md`。上文“人工绑定需单独撤销旧 Session”适用于直接改表或旧脚本；通过当前受控 bindIdentity 执行时由代码原子完成，不再要求手工重复删除。滚动发布时停止旧密码签发仍是部署前提。
