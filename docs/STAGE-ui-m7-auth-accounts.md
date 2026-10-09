# STAGE · UI-M7 前端半部：账户与授权「广告与数据源授权」分节

## 任务定位
- 对应需求盘点文档的 **M7（账户与授权）** 前端半部。当前 `settings.html` 仅有占位 stub（"暂无已授权账户"），本任务把它做成**真实可交互**的一节。
- 优先级：排在 U3、report 抽屉渲染器之后（按本期权优先级，不插队）。单客户阶段 ROI 不高，故**先用 mock 数据跑通交互**，等基座 `GET/DELETE /api/auth-accounts` 上线后"换血"回归（沿用 U-M-B「先 mock 再换血」模式）。
- 本任务**只动前端**，未碰任何后端/其他业务线代码（范围约束：仅 `shell/public/settings.html`、`shell/public/settings.js`）。

## 交付内容
1. **settings.html**
   - 在「广告与数据源授权」节内新增 `#acctStatus`（状态行）+ `#acctList`（列表容器），替换原占位 `<p>`。
   - 新增解除确认弹框 `#revokeModal`（modal-mask + modal-card，含「取消 / 确认解除」按钮）。
   - 在页面 `<style>` 内（inline，合规 `style-src 'self' 'unsafe-inline'`）新增：
     - 列表/卡片布局 `.acct-item / .acct-main / .acct-scope / .acct-updated`；
     - **三态徽标配色**：`有效`=绿(`.ok`)、`即将过期`=琥珀(`.warn`)、`需重验`=红(`.danger`)，视觉区分明确；
     - `.acct-revoke` 解除按钮；
     - 弹框样式 + `.btn.danger`；
     - `@media (max-width:480px)` 移动端单栏堆叠（响应式，不错位）。
2. **settings.js**
   - 新增 M7 区块（IIFE 内）：`USE_MOCK_AUTH_ACCOUNTS=true` 开关 + `MOCK_ACCOUNTS`（3 条样例：SS-GTM/有效、Meta/即将过期、MCP/需重验，字段严格对齐契约）。
   - `renderAccounts(list)`：纯渲染层，对数据来源无感知（`GET` 真数据或 mock 走同一函数，换源即回归）。
   - `loadAuthAccounts()`：`USE_MOCK` 为真用 mock；为假则 `GET /api/auth-accounts`，401 跳登录。
   - 解除流程：`openRevokeModal` 弹出**解除影响提醒**文案（停止回传 / 已生成结果不受影响 / 可重新授权恢复）→ `confirmRevoke`：mock 阶段本地移除并刷新（不真调后端）；真接口阶段 `DELETE /api/auth-accounts/:id` 后重新拉取。
   - XSS：所有字段经 `esc()` 转义后再拼 HTML。
   - 事件委托：列表内「解除」按钮、弹框「取消/确认」、点击遮罩关闭。

## 契约（基座后续实现，前端已对齐）
- `GET /api/auth-accounts` → `[{id,tenantId,accountType:"SS-GTM|Meta|MCP",status:"有效|即将过期|需重验",scope,updatedAt}]`
- `DELETE /api/auth-accounts/:id` → 解除授权
- **换血方式**：将 `settings.js` 中 `USE_MOCK_AUTH_ACCOUNTS` 置 `false`，确认两端点上线即可，UI 零改动。

## 真实验收（`_u_m7_accept.cjs`，加载真实 settings.js + 极简 DOM shim）
17/17 PASS：
- mock 列表渲染 3 条；三态徽标 ok/warn/danger 均出现且一一对应；含账户类型/授权范围/最后更新时间；
- 点击「解除」弹框显示且文案含「解除影响」+ 平台恢复说明；确认解除后列表剩 2 条、弹框关闭、被解除项不再出现；
- 取消按钮关闭弹框且不误删；渲染对 `< >` 做了转义。

## 提交
- 分支 `feature/ui-m7-auth-accounts`（基于 main `381df2f`）。
- `main..HEAD`：`shell/public/settings.html` / `shell/public/settings.js` / `docs/STAGE-ui-m7-auth-accounts.md`。
- 未 push（用户未要求），待独立核实后给指令。
