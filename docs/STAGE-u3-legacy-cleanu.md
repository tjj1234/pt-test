# STAGE · U3 前端遗留项清理（登录/设置页 + 忘记/改密码 + 响应式）

> 分支：`feature/ui-u3-legacy-cleanu`（基于 `main` @ `20b825f`）
> 范围：`shell/public/` 下登录/设置相关页面；例外：`shell/auth-routes.cjs` 仅新增 3 个密码相关端点（不改任何既有登录/注册/会话逻辑）。
> 状态：实现完成 + 真实验收全绿（18/18 PASS）。

## 一、交付内容

### 1. 忘记密码流程（forgot → reset）
- **新端点 `POST /api/auth/forgot-password`**：按用户名/邮箱查用户；命中则生成重置令牌（UUID 关联 `users.id`），存 `password_reset_tokens` 表（**懒创建，未新增迁移文件、未碰 `db-migrations`**）。
- **开发态发信开关 `PT_RESET_DELIVERY`**：默认 `return` —— 直接把重置链接返回前端，**不假设任何不存在的发信基础设施**。代码已预留，将来接邮件后切 `email` 即可。
- **抗账户枚举**：无论账号是否存在都返回同一套成功文案；仅 `return` 模式才附带令牌，杜绝「账号是否存在」侧信道。
- **新端点 `POST /api/auth/reset-password`**：校验令牌（签名/过期/已用），通过后更新 `password_hash`，并把令牌标记 `used`。
- 新页面 `forgot.html` + `forgot.js`、`reset.html` + `reset.js`（复用业务壳 `.login-card` 视觉，登录态无关，不套 `authed` 重定向）。

### 2. 已登录改密码
- **新端点 `POST /api/auth/change-password`**：校验当前会话 → 校验当前密码 → 更新密码；改密后让该用户**其他设备/标签页会话失效，仅保留当前会话**（安全）。
- 设置页 `settings.html` 新增「修改登录密码」独立区块（与 PT Key 绑定互不打扰）。

### 3. 响应式（手机宽度不错位）
- `styles.css`：`.login-card` / `.key-card` 加 `max-width:calc(100vw - 32px)`，避免 380/460px 固定宽在窄屏溢出；新增 `@media (max-width:480px)` 缩小内边距。
- 仅覆盖 `login.html` 与 `settings.html`（按确认范围，**归因面板响应式另排**）。

### 4. 密码强度提示
- 新增共用 `pw-strength.js`（暴露 `attachPwStrength`），注册页、设置页改密、重置页三处复用；纯前端 advisory（只提示强度+建议），后端仍以「至少 8 位」兜底。

### 5. 安全合规（关键）
- 发现线上 `server.cjs` 对所有响应设 `Content-Security-Policy: script-src 'self'`（**无 `unsafe-inline`**）。因此所有新增逻辑均放**外部脚本**（`register.js` / `settings-pw.js` / `forgot.js` / `reset.js` / `pw-strength.js`），**无内联 `<script>`**，否则会被 CSP 拦截。验收已断言各页面无内联脚本且 CSP 含 `script-src 'self'`。

## 二、改动文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `shell/auth-routes.cjs` | 改 | 新增 forgot/reset/change-password 3 端点 + 限流 + 懒建重置令牌表 |
| `shell/server.cjs` | 改 | 新增 `/forgot`、`/reset` 静态页路由（公开页） |
| `shell/public/styles.css` | 改 | 响应式 max-width + 媒体查询 + 密码强度样式 |
| `shell/public/login.html` | 改 | 加「忘记密码？」入口 + 注册密码强度 markup |
| `shell/public/register.js` | 改 | 接密码强度提示 |
| `shell/public/settings.html` | 改 | 加修改密码区块 + 响应式 max-width |
| `shell/public/settings-pw.js` | 新 | 修改密码前端（外部脚本，合规 CSP） |
| `shell/public/pw-strength.js` | 新 | 密码强度提示（共用） |
| `shell/public/forgot.html` + `forgot.js` | 新 | 忘记密码页 |
| `shell/public/reset.html` + `reset.js` | 新 | 重置密码页 |
| `docs/STAGE-u3-legacy-cleanu.md` | 新 | 本报告 |

## 三、真实验收（证据 `_u3_accept_result.txt`）

自测 harness 直接 `require` 真实 `auth.cjs` + `auth-routes.cjs`，起最小服务（复用 `/api/auth/*` 路由 + 静态页 + 线上同款 CSP），跑通：
- 注册 → 登录 → **改密码** → 旧密码失效(401) → 新密码登录 ✅
- **忘记密码**（return 模式返回令牌）→ **重置密码** → 重置后登录 ✅
- 抗枚举（不存在账号不返回令牌）✅
- 坏令牌(400) / 已用令牌复用(400) ✅
- 未登录改密码(401) ✅
- 四个页面可达 + CSP 合规 + 无内联脚本 ✅
- `/assets/pw-strength.js` 可加载 ✅

> 注：完整 `shell/server.cjs` 启动依赖的 `keys/conversations` 子系统在沙箱内会卡（与本任务无关），故验收用同模块的最小服务；`server.cjs` 仅新增 2 行静态路由，已逐行核对。

## 四、未覆盖 / 待你确认
- **真实发信通道**：当前为开发态 `return` 模式（重置链接直接回页面）。接邮件/SMS 后把 `PT_RESET_DELIVERY` 切到 `email` 并实现投递即可。
- **归因面板响应式**：按确认不在 U3 范围，另排。
- **真实浏览器手机宽度视觉核对**：CSS 层面已用 `max-width` + 媒体查询保证不错位；如需要可走 agent-browser 截图二次确认。
