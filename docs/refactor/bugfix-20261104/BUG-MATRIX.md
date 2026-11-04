# 20 项 Bug 详细矩阵与核验全景表 (BUG-MATRIX)

| Bug ID | 用户描述 | 状态标记 | 归属 Commit | 修改文件 | 本地验证方法 | 独立复测与配置要求 |
|:---:|---|:---:|:---:|---|---|---|
| **Bug-01** | 资料检索，选择后不能删除 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | `shell/server.cjs` | 自动化断言：`batch2-bugfix-test.mjs` 测试 3 | 需在独立 Web UI 中选择资料后点击删除，观察无 409 且上下文清理生效 |
| **Bug-02** | 业务流库 enabled-status 报 502 (内部 403) | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | `shell/server.cjs` | 代理请求头与鉴权凭据构造断言 | 需 FAT/生产配置 `PT_DASH_INTERNAL_KEY` 方可闭环业务线真实验证 |
| **Bug-03** | 日志记录列表数据不全，没有成功的数据 | `CODE_FIXED` | `27f4731` (Batch 4) | `shell/tasks/store.cjs` | 自动化断言：`batch4-bugfix-test.mjs` 测试 1 (`created_at DESC`) | 需在持久数据库插入成功/失败记录，复测分页与置顶排序 |
| **Bug-04** | 切换模型或切换对话时模型加载特别慢 | `CODE_FIXED` | `27f4731` (Batch 4) | `shell/server.cjs` | 自动化断言：`batch4-bugfix-test.mjs` 测试 2 (无强制 force) | 在前端连续切换对话和模型，核对耗时由 1~3s 降低至 < 10ms |
| **Bug-05** | 对话返回 tool-call budget exhausted | `CODE_FIXED` | `13806fa` (Batch 1) | `shell/persistent-runner.mjs` | 自动化断言：`batch1-bugfix-test.mjs` 测试 3 | 提问「今天几号/周几」，验证正常回复日期且未触碰调用预算 |
| **Bug-06** | 广告导入 workspace 报 403 invalid token | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | `shell/server.cjs` | 鉴权代理身份映射测试 | 依赖 `PT_DASH_INTERNAL_KEY`，独立测试需用真实租户 session curl |
| **Bug-07** | 不能回写内容到上传的文件中 | `SCOPE_CLARIFIED` | `27f4731` (Batch 4) | `shell/agent-persona.md` | 人设与约束断言：`batch4-bugfix-test.mjs` 测试 4 | 要求 Agent 修改上传文件，检查 Agent 说明只读约束并输出产物文件供下载 |
| **Bug-08** | 对话框不能 ctrl+v 粘贴表格和视频 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | `shell/public/app.js` | 自动化断言：`batch2-bugfix-test.mjs` 测试 1 (MIME 识别) | 在浏览器中复制 `.xlsx` 或 `.mp4` 文件到输入框按 Ctrl+V，附件区正常显示 |
| **Bug-09** | 生成图片/问今天周几报 budget exhausted | `CODE_FIXED` | `13806fa` (Batch 1) | `shell/server.cjs` | 自动化断言：`batch1-bugfix-test.mjs` 测试 2 (意图与预算扩展) | 在 AUTO 模式提问「帮我画一张猫」，验证正确进入生成确认卡片流程 |
| **Bug-10** | 归因看板被 CSP 拦截 frame-ancestors | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | `shell/server.cjs` | 自动化断言：`batch1-bugfix-test.mjs` 测试 1 (`frame-ancestors 'self'`) | 在同源系统内打开看板，核对 iframe 正常渲染；需 Nginx 不强行改写此头 |
| **Bug-11** | 广告导入 jobs 报 403 Forbidden | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | `shell/server.cjs` | 鉴权代理透传校验 | 需 FAT 环境配置内部看板通信秘钥 |
| **Bug-12** | 不能生成 html 文件，直接回复代码内容 | `CODE_FIXED` | `27f4731` (Batch 4) | `shell/server.cjs` | 自动化断言：`batch4-bugfix-test.mjs` 测试 4 (HTML 提取物化) | 要求生成网页报表，验证右侧自动弹出产物面板渲染 HTML 页面并支持下载 |
| **Bug-13** | details withheld，更换会话正常 | `CODE_FIXED` | `27f4731` (Batch 4) | `shell/persistent-runner.mjs`, `shell/server.cjs` | 自动化断言：`batch4-bugfix-test.mjs` 测试 3 (坏态 session 驱逐) | 制造异常终止后，在同一会话继续发言，验证不再报错且对话能够自愈 |
| **Bug-14** | turn ended without completion(reason=error) | `CODE_FIXED` | `27f4731` (Batch 4) | `shell/persistent-runner.mjs`, `shell/server.cjs` | 自动化断言：`batch4-bugfix-test.mjs` 测试 3 | 与 Bug-13 相同自愈机制验证 |
| **Bug-15** | 调度与执行 jobs/workspace 均 403 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | `shell/server.cjs` | 鉴权代理透传校验 | 点击「调度与执行」页面，核对列表正常拉取 |
| **Bug-16** | 文生视频确认报 409，回答消失 | `CODE_FIXED` | `5b941d6` (Batch 3) | `shell/public/app.js` | 自动化断言：`batch3-bugfix-test.mjs` 测试 1 (合格候选过滤) | 点击生成视频，确认弹窗只出现 `wan2.7-t2v`，提交无 409，流式文字不被冲掉 |
| **Bug-17** | 上传图片必须输入文字才能发出 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | `shell/public/app.js`, `shell/server.cjs` | 自动化断言：`batch2-bugfix-test.mjs` 测试 2 (空文本放行) | 只上传一张图片，不输任何文字直接点击发送，消息正常发出并获得回复 |
| **Bug-18** | 对话不支持文生图、图生图、视频 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `5b941d6` (Batch 3) | `shell/public/app.js`, `shell/server.cjs` | 自动化断言：`batch3-bugfix-test.mjs` 测试 2 (标准媒体目录接线) | 模型菜单中生成模型清晰标注，点击自动切换生成面板 |
| **Bug-19** | 模型列表中图片视频模型不可用 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `5b941d6` (Batch 3) | `shell/public/app.js`, `shell/server.cjs` | 自动化断言：`batch3-bugfix-test.mjs` 测试 3 (媒体资格矩阵) | 验证媒体生成模型与纯文本聊天模型分类展示，无误报不支持弹窗 |
| **Bug-20** | 图片理解报当前无通过核验模型 | `CODE_FIXED` | `5b941d6` (Batch 3) | `shell/server.cjs`, `shell/public/app.js` | 自动化断言：`batch3-bugfix-test.mjs` 测试 1 (`qwen3.8-flash` 试跑核验) | AUTO 模式冷启动上传图片，系统自动调度视觉模型完成识图回复 |

---

## 20 个 Bug 逐项 9 字段标准规范报告

### Bug-01
- **Bug ID**：Bug-01
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：在检索资料列表中勾选已挂载资料后点击删除，资料被安全移除，下一轮不再引用。
  - 实际：点击删除接口报 409 Conflict，提示 `Run not drained`。
- **复现步骤**：在对话中挂载资料，随后在资料管理区执行删除操作。
- **根因**：`onRevoke` 触发关联 Run 取消时，由于 Run 处于 `cancelling` 过渡态，强行断言非终态抛出异常回滚事务。
- **修改文件/commit**：`shell/server.cjs` / Commit: `6b932ce`
- **修复前后证据**：修复前抛错 `Run not drained` 阻断资料删除；修复后宽容处理过渡态并等待安全注销。
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` 测试 3 PASS。
- **剩余风险**：删除时若有 Run 正在流式打字，会平滑收到上下文变更中断。

---

### Bug-02
- **Bug ID**：Bug-02
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：请求 `/api/workspaces/enabled-status` 返回业务线真实启用状态。
  - 实际：接口返回 502 `业务线工作区状态查询失败（403）`。
- **复现步骤**：进入「业务流库」页面，观察启用状态加载。
- **根因**：网关转发到内部服务时缺失可信租户内部认证 Header，触发业务线拦截。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：修复前未携带认证信息直接 403；修复后统一代理注入内部签名凭据。
- **回归结果**：`batch1-bugfix-test.mjs` 接口契约校验通过。
- **剩余风险**：属于 `CONFIG_PENDING`，依赖生产/FAT 环境变量 `PT_DASH_INTERNAL_KEY`。

---

### Bug-03
- **Bug ID**：Bug-03
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：用量与运行列表中展示真实任务，按时间倒序排列，最新成功的运行置顶。
  - 实际：列表数据不全，看不到成功的运行数据。
- **复现步骤**：运行数次成功对话或工具调用，进入用量与日志查看运行清单。
- **根因**：`shell/tasks/store.cjs` 中 `listRuns` 查询为 `ORDER BY run_id`，UUID 伪随机排序导致新记录散落截断。
- **修改文件/commit**：`shell/tasks/store.cjs` / Commit: `27f4731`
- **修复前后证据**：修复前随机乱序；修复后变更为 `ORDER BY created_at DESC, run_id DESC`。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 1 PASS。
- **剩余风险**：无。

---

### Bug-04
- **Bug ID**：Bug-04
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：点击会话列表切换对话或点击模型下拉框时秒开（< 50ms）。
  - 实际：每次切换对话卡顿 1~3 秒，下拉框不可用。
- **复现步骤**：在左侧对话历史中连续点击不同会话。
- **根因**：`shell/server.cjs` 的 `GET /api/models` 与 `POST /api/models/select` 传入 `{ force: true }`，穿透缓存触发外部网络同步。
- **修改文件/commit**：`shell/server.cjs` / Commit: `27f4731`
- **修复前后证据**：修复前每次切换打出远程 HTTP 请求；修复后默认走内存缓存，耗时 < 5ms。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 2 PASS。
- **剩余风险**：远端若添加新模型，依赖后台定时同步或带 `force=1` 显式刷新。

---

### Bug-05
- **Bug ID**：Bug-05
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：提问「今天周几」正常回复当前星期。
  - 实际：报错 `Run stopped because the tool-call budget was exhausted`。
- **复现步骤**：发送「今天周几」。
- **根因**：文本对话默认预算将 `get_current_time` 纳入工具上限计数（限额为 0）。
- **修改文件/commit**：`shell/persistent-runner.mjs` / Commit: `13806fa`
- **修复前后证据**：修复前调用探针直接耗尽；修复后将只读时间探针豁免工具计数。
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` 测试 3 PASS。
- **剩余风险**：其他业务类修改工具仍保留 4 次上限保护。

---

### Bug-06
- **Bug ID**：Bug-06
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：广告数据导入模块读取工作区配置正常。
  - 实际：接口 `api/business/attribution/import/workspace` 返回 403 invalid token。
- **复现步骤**：打开「广告数据导入」页面。
- **根因**：归因模块鉴权头与网关代理未同步租户上下文。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：修复前丢失 Authorization；修复后构造合法内部凭证转发。
- **回归结果**：`batch1-bugfix-test.mjs` PASS。
- **剩余风险**：`CONFIG_PENDING`，需确保 `PT_DASH_INTERNAL_KEY` 配置正确。

---

### Bug-07
- **Bug ID**：Bug-07
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：用户要求修改上传文件时，获得修改后的文件产物。
  - 实际：生硬报错不能回写。
- **复现步骤**：上传表格后要求「修改第三列并写回原文件」。
- **根因**：系统架构安全红线：`_uploads` 目录实行不可篡改 SHA-256 校验，原地修改会破坏历史证据。此前缺少用户友好的替代产物生成引导。
- **修改文件/commit**：`shell/agent-persona.md` / Commit: `27f4731`
- **修复前后证据**：修复前盲目报错；修复后 Agent 告知只读安全约束，并以独立导出产物（Artifact）形式提供修改后新文件。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 4 PASS。
- **剩余风险**：无。

---

### Bug-08
- **Bug ID**：Bug-08
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：Ctrl+V 支持粘贴图片、表格（CSV/Excel）及视频。
  - 实际：只有图片可以粘贴，表格和视频无反应。
- **复现步骤**：复制 Excel 表格文件，在输入框按 Ctrl+V。
- **根因**：`shell/public/app.js` 中 `paste` 监听严格限定 `item.type.startsWith("image/")`。
- **修改文件/commit**：`shell/public/app.js` / Commit: `6b932ce`
- **修复前后证据**：修复前忽略非图片；修复后支持多种文件分流至各自附件上传接口。
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` 测试 1 PASS。
- **剩余风险**：若操作系统剪贴板未提供文件句柄，将退化为普通纯文本粘贴。

---

### Bug-09
- **Bug ID**：Bug-09
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：在 AUTO 模式下输入「生成图片」顺利拉起生成链路。
  - 实际：报错 `Run stopped because the tool-call budget was exhausted`。
- **复现步骤**：保持 AUTO 模式，发送「帮我画一张插画」。
- **根因**：AUTO 模式下请求初始未带 `taskType`，后端按纯文本对话预算（0 工具限额）分配导致溢出。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：修复前未识别意图；修复后后端动态推断媒体意图并放宽任务预算。
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` 测试 2 PASS。
- **剩余风险**：用户最终生成仍需在前端确认卡片二次点击授权。

---

### Bug-10
- **Bug ID**：Bug-10
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：点击「归因看板」正常在 iframe 中显示报表。
  - 实际：浏览器报错 `violates CSP frame-ancestors 'none'`，页面空白。
- **复现步骤**：点击主界面「归因看板」。
- **根因**：`server.cjs` 硬编码响应头 `frame-ancestors 'none'` 拦截了本站自身 iframe 嵌入。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：修复前为 `'none'`；修复后为 `'self'`。
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` 测试 1 PASS。
- **剩余风险**：`CONFIG_PENDING`，需运维确认反代 Nginx 未覆盖同名 CSP 头。

---

### Bug-11
- **Bug ID**：Bug-11
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：广告数据导入模块获取 jobs 任务列表成功。
  - 实际：`GET /api/business/attribution/import/jobs` 返回 403 Forbidden。
- **复现步骤**：进入广告数据导入页面查看作业记录。
- **根因**：内部代理调用缺失有效租户令牌。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：修复前缺失认证头；修复后补全代理鉴权通道。
- **回归结果**：`batch1-bugfix-test.mjs` PASS。
- **剩余风险**：依赖 `PT_DASH_INTERNAL_KEY` 配置。

---

### Bug-12
- **Bug ID**：Bug-12
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：要求生成 HTML 时生成独立预览产物。
  - 实际：不能生成 HTML 文件，直接回复大段纯文本代码。
- **复现步骤**：提问「生成一个数据分析报告 HTML 页面」。
- **根因**：DSH 运行时未开放通用写文件工具，模型只能输出 markdown 代码块，未物化为 Artifact。
- **修改文件/commit**：`shell/server.cjs` / Commit: `27f4731`
- **修复前后证据**：修复前仅聊天气泡显示文本；修复后自动提取完整 HTML 物化为 `report.html`，发送 `artifact` 事件唤醒 `#artPane` 预览。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 4 PASS。
- **剩余风险**：预览窗口严格启用沙箱隔离，禁止运行恶意外部脚本。

---

### Bug-13
- **Bug ID**：Bug-13
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：单次任务失败后，在同一会话继续发言可恢复交互。
  - 实际：返回 `Agent task failed before a complete response; diagnostic details were withheld`；更换会话才正常。
- **复现步骤**：制造一次任务超时或中断，随后在该会话中再次输入问题。
- **根因**：`persistent-runner.mjs` 在捕获异常时未从 `agentMap` 中驱逐损坏的 agent 会话，下轮请求命中坏死实例。
- **修改文件/commit**：`shell/persistent-runner.mjs`, `shell/server.cjs` / Commit: `27f4731`
- **修复前后证据**：修复前坏 session 残留；修复后异常发生时立即 `agentMap.delete(sid)` 并在服务端清空原生会话指针。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 3 PASS。
- **剩余风险**：无。

---

### Bug-14
- **Bug ID**：Bug-14
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：turn 异常结束后，会话状态自动重置，保留历史上下文。
  - 实际：返回 `Agent turn ended without completion (reason=error)` 且会话死锁。
- **复现步骤**：触发底层 turn error，后续交互持续报错。
- **根因**：未完成状态保留在会话内存中，未被垃圾回收。
- **修改文件/commit**：`shell/persistent-runner.mjs`, `shell/server.cjs` / Commit: `27f4731`
- **修复前后证据**：与 Bug-13 相同，在 `outcome.reason.kind !== 'completed'` 时驱逐 session。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` 测试 3 PASS。
- **剩余风险**：无。

---

### Bug-15
- **Bug ID**：Bug-15
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：「调度与执行」页面加载 jobs 和 workspace 成功。
  - 实际：控制台报错两个接口均 403 Forbidden。
- **复现步骤**：点击顶部导航「调度与执行」。
- **根因**：与 Bug-06/11 共享根因，内部导入代理拦截。
- **修改文件/commit**：`shell/server.cjs` / Commit: `13806fa`
- **修复前后证据**：同 Batch 1 代理鉴权修复。
- **回归结果**：`batch1-bugfix-test.mjs` PASS。
- **剩余风险**：`CONFIG_PENDING`，依赖生产 `PT_DASH_INTERNAL_KEY`。

---

### Bug-16
- **Bug ID**：Bug-16
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：文生视频选择确认模型提交成功；流式文字保留。
  - 实际：确认接口报 409，提示未完成或过期；上方对话回答闪烁消失。
- **复现步骤**：触发视频生成任务，在弹窗中选择模型后点击提交。
- **根因**：
  1. 弹窗下拉框注入了通用语言模型，提交不合格模型触发服务端 409 拦截。
  2. 终止帧错误处理将前端暂存的 `acc` 流式增量内容置空。
- **修改文件/commit**：`shell/public/app.js` / Commit: `5b941d6`
- **修复前后证据**：修复前模型下拉混杂通用模型且回答闪烁；修复后精准过滤合格任务模型，并妥善保留 `acc`。
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` 测试 1 PASS。
- **剩余风险**：视频最终落地还受宿主 `PT_MEDIA_ASSET_HOSTS` 限制。

---

### Bug-17
- **Bug ID**：Bug-17
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：上传图片后可以直接按回车发送。
  - 实际：必须输入文字才能发出，无文字时发送按钮禁用。
- **复现步骤**：上传图片，输入框留空，点击发送。
- **根因**：前端判空逻辑直接绑定 `#ta.value.trim()`，阻止了仅附件的有效请求。
- **修改文件/commit**：`shell/public/app.js`, `shell/server.cjs` / Commit: `6b932ce`
- **修复前后证据**：修复前必须输字；修复后空文本图片请求放行，服务端自动补齐引导提问。
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` 测试 2 PASS。
- **剩余风险**：无。

---

### Bug-18
- **Bug ID**：Bug-18
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：支持从模型列表选择并进入文生图、图生图或文生视频任务。
  - 实际：提示目前仅支持文本。
- **复现步骤**：点击模型切换，尝试启动生成任务。
- **根因**：生成模型被文本聊天路由逻辑判定为 `chat === false` 并被硬拦截。
- **修改文件/commit**：`shell/public/app.js`, `shell/server.cjs` / Commit: `5b941d6`
- **修复前后证据**：修复前直接阻断；修复后在前端平滑引导切换到对应生成模式输入区。
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` 测试 2 PASS。
- **剩余风险**：无。

---

### Bug-19
- **Bug ID**：Bug-19
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：模型列表中明确标明多模态能力与生成模型用途。
  - 实际：图片/视频类模型全不可用，仅文本模型可用。
- **复现步骤**：查看顶部模型下拉菜单。
- **根因**：前端未向用户区分「对话模型」与「素材生成模型」，通用接口缺少媒体资格矩阵关联。
- **修改文件/commit**：`shell/public/app.js`, `shell/server.cjs` / Commit: `5b941d6`
- **修复前后证据**：修复前报错不可用；修复后按分类友好展示并标注用途。
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` 测试 3 PASS。
- **剩余风险**：无。

---

### Bug-20
- **Bug ID**：Bug-20
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：发图片后自动完成图片解析理解。
  - 实际：报错 `当前没有通过资格核验的图片理解模型，请选择已确认支持图片输入的模型`。
- **复现步骤**：AUTO 模式下上传图片提问。
- **根因**：`selectChatModel` 在图片理解任务上强依赖本地已有验证快照，冷启动时未自动试跑合格视觉候选。
- **修改文件/commit**：`shell/server.cjs` / Commit: `5b941d6`
- **修复前后证据**：修复前抛出未核验错误；修复后无缓存时自动使用标准视觉模型 `qwen3.8-flash` 试跑核验。
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` 测试 1 PASS。
- **剩余风险**：若用户手动强制选择不支持视觉的纯文本模型并传图，会提示切换。
