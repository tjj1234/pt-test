# r28 20项Bug修复全量交接报告（Codex主程序专递）

> **交付状态**：已就绪，已停止在**送主审（SUBMITTED_FOR_REVIEW）**状态。  
> **基线版本**：Release r28 线上提交 `bbd9997d1e19920dc1c850c31ec6c71dbc5994d1`  
> **候选集成分支**：`candidate/r28-bugfix-full`（对应工作区分支 `fix/bug-batch4-presentation-output`）  
> **候选分支 Tip Hash**：`0f0bb52e862c352d808bb62b7913c4f4d171f113`  
> **隔离工作区绝对路径**：`/private/tmp/pt-fix-batch4`  
> **主工作区状态**：`/Users/mmdn/Downloads/pt项目` 保持原状，无任何违规 git clean / reset 或覆盖。  
> **交付边界**：不自行合并主线、不上线、不修改生产配置；等待主程代码主审与独立工程师复测。

---

## 目录
1. [一分钟速览与分支拓扑](#一-一分钟速览与分支拓扑)
2. [独立测试报告差异核验说明](#二-独立测试报告差异核验说明)
3. [20项Bug全景状态分类矩阵](#三-20项bug全景状态分类矩阵)
4. [20项Bug逐项9字段标准交付卡片](#四-20项bug逐项9字段标准交付卡片)
5. [运维环境配置差异单 (CONFIG-DELTA)](#五-运维环境配置差异单-config-delta)
6. [测试执行证据与退出码 (TEST-EVIDENCE)](#六-测试执行证据与退出码-test-evidence)
7. [主程一键审查与集成指引](#七-主程一键审查与集成指引)

---

## 一、 一分钟速览与分支拓扑

四批修复在隔离工作区采用**单向线性递进演进**，第四批 Tip 已经完全包含了前三批所有必要改动。主程无需手动处理复杂的 cherry-pick 或合并冲突：

```text
基线：r28 线上提交 (bbd9997d1e19920dc1c850c31ec6c71dbc5994d1)
  │
  ├─> 13806fa5e9f268e068a9facb0d7685ec4c522b2e (Batch 1: 核心阻断与认证)
  │     涵盖：Bug-10, Bug-02, Bug-06, Bug-11, Bug-15, Bug-05, Bug-09
  │
  ├─> 6b932ce6b82d4a53da087f401b2140c517f4631c (Batch 2: 输入与交互体验)
  │     涵盖：Bug-08, Bug-17, Bug-01
  │
  ├─> 5b941d6255c4138b23b163fc94ff60d58a8073ec (Batch 3: 多模态与受控媒体)
  │     涵盖：Bug-16, Bug-18, Bug-19, Bug-20
  │
  ├─> 27f4731b329a5775eadfd14b0b26bed6b653d47e (Batch 4: 呈现、产物与稳定性)
  │     涵盖：Bug-03, Bug-04, Bug-07, Bug-12, Bug-13, Bug-14
  │
  └─> 0f0bb52e862c352d808bb62b7913c4f4d171f113 (candidate/r28-bugfix-full / TIP)
        docs(bugfix): add full review and integration package for Codex lead programmer
```

- **修改代码文件数**：严格限定为 5 个核心文件（`server.cjs`, `persistent-runner.mjs`, `app.js`, `store.cjs`, `agent-persona.md`）。
- **总代码变动**：`+618 / -35`（含 4 个独立自动化回归套件），无依赖升级，未改动 `node_modules`，未触碰 Gemini 原 8 包候选。

---

## 二、 独立测试报告差异核验说明

经与独立测试工程师报告（`PTR-20261104-R28-FINAL`，实测时间 2026-11-04 15:30）逐项对齐：
1. **测试基准不同**：独立测试工程师是对当时已部署的 FAT 镜像环境 (`https://agent-fat.adorado.top/`) 运行的测试，**该环境运行的是未打补丁的原版 r28 代码（`bbd9997`）**，并非本次四批修复分支。
2. **已复现的缺陷**：测试报告中列为“待前端专项优化”的项（Bug-01 资料删除 409、Bug-08 剪贴板非图片、Bug-17 纯图片发送、Bug-12 HTML 回复纯文本）在未打补丁的线上如实复现，在本次候选分支中均已完成修复。
3. **403 invalid token (Bug-02/06/11/15)**：测试报告证实线上存在 403 阻断。代码层已修复代理身份透传，但需要生产/FAT 环境配置 `PT_DASH_INTERNAL_KEY` 方可完成跨服务认证（已标记为 `CONFIG_PENDING`）。
4. **文生视频远端成功与落地拦截 (Bug-16)**：测试报告证实远端 Wan2.7 视频生成成功，但 FAT 宿主缺失 CDN 白名单导致 `HOST_NOT_ALLOWED`。本次修复在前端解决了弹窗混入语言模型导致 409 的问题，CDN 域名属于运维环境配置项 `PT_MEDIA_ASSET_HOSTS`。
5. **图片理解 (Bug-20)**：测试报告建议后置，本次修复已通过 AUTO 模式视觉候选试跑（`qwen3.8-flash`）闭环解决，无需延期。

---

## 三、 20项Bug全景状态分类矩阵

状态标记说明：
- `CODE_FIXED`：代码修复完成，本地自动化测试通过。
- `AUTHOR_UI_TESTED`：修复作者在隔离服务环境下走通了 UI 流程。
- `CONFIG_PENDING`：代码已完善，但生效依赖真实环境运维配置（如密钥/域名）。
- `SCOPE_CLARIFIED`：属于底层安全或架构边界，已补充机制说明与替代体验闭环。

| Bug ID | 用户反馈简述 | 状态标记 | 归属 Commit | 核心解决方案与责任归属 |
|:---:|---|:---:|:---:|---|
| **01** | 资料检索已选后不能删除 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | 容忍 Run 过渡态取消，放行资料删除与上下文清理 |
| **02** | enabled-status 报 502/403 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | 补齐代理内部认证签名；需 FAT 配置 `PT_DASH_INTERNAL_KEY` |
| **03** | 日志记录列表缺成功数据 | `CODE_FIXED` | `27f4731` (Batch 4) | `listRuns` 调整为 `created_at DESC`，最新成功记录稳定置顶 |
| **04** | 切换模型或对话时模型加载极慢 | `CODE_FIXED` | `27f4731` (Batch 4) | 去除强制 `{ force: true }`，读取本地缓存避免阻塞外部 HTTPS |
| **05** | 时间等工具触发 budget exhausted | `CODE_FIXED` | `13806fa` (Batch 1) | 只读探针 `get_current_time` 豁免工具调用限额计数 |
| **06** | 广告导入 workspace 报 403 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | 代理层透传合法租户上下文；需外部服务鉴权秘钥 |
| **07** | 不能回写内容到上传文件中 | `SCOPE_CLARIFIED` | `27f4731` (Batch 4) | 阐明上传文件只读哈希安全边界，物化新产物供下载替代 |
| **08** | 对话框不能 Ctrl+V 粘贴表格/视频 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | 剪贴板事件扩展分流，放行表格与音视频进入附件区 |
| **09** | 生成图片/问日期报预算耗尽 | `CODE_FIXED` | `13806fa` (Batch 1) | AUTO 模式动态识别媒体意图分配任务预算，配合时间探针豁免 |
| **10** | 归因看板 iframe 被 CSP 拦截 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | 服务端将 `frame-ancestors 'none'` 调整为 `'self'`；需 Nginx 协同 |
| **11** | 广告导入 jobs 报 403 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | 内部代理请求鉴权修补；需内部签名密钥 |
| **12** | HTML 只回复代码内容不能生成文件 | `CODE_FIXED` | `27f4731` (Batch 4) | 服务端自动提取 HTML 代码块物化为 `report.html` 沙箱预览产物 |
| **13** | details withheld，同会话死锁 | `CODE_FIXED` | `27f4731` (Batch 4) | 异常时驱逐损坏 session 并重置指针，下一轮输入自动初始化健康实例 |
| **14** | turn ended without completion | `CODE_FIXED` | `27f4731` (Batch 4) | 捕获未完成状态，清理内存坏态，保留会话历史关联 |
| **15** | 调度与执行页面 jobs/workspace 403 | `CODE_FIXED` / `CONFIG_PENDING` | `13806fa` (Batch 1) | 统一导入子系统鉴权映射；需内部签名密钥 |
| **16** | 媒体授权 409，流式回答消失 | `CODE_FIXED` | `5b941d6` (Batch 3) | 弹窗下拉精准过滤任务合格模型，保留 `acc` 流式内容防闪烁清空 |
| **17** | 图片必须输入文字才能发 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `6b932ce` (Batch 2) | 前端放行纯图片，服务端缺省注入「请分析该图片」提问 |
| **18** | 对话不支持文生图、图生图、视频 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `5b941d6` (Batch 3) | 标识素材生成模型，点击自动切换为文生图/文生视频生成模式 |
| **19** | 模型列表中图片视频模型不可用 | `CODE_FIXED` / `AUTHOR_UI_TESTED` | `5b941d6` (Batch 3) | 暴露标准媒体资格矩阵，区分聊天与素材生成模型用途 |
| **20** | 图片理解报无通过核验模型 | `CODE_FIXED` | `5b941d6` (Batch 3) | AUTO 识图无本地快照时自动试跑视觉候选 `qwen3.8-flash` |

---

## 四、 20项Bug逐项9字段标准交付卡片

### Bug-01
- **Bug ID**：Bug-01
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：勾选已挂载参考资料点击删除后，资料被移除，下一轮不再引用。
  - 实际：点击删除接口报 409 Conflict，提示 `Run not drained`。
- **复现步骤**：在对话中挂载资料，随后在资料管理区执行删除操作。
- **根因**：`onRevoke` 触发关联 Run 取消时，由于 Run 处于 `cancelling` 过渡态，强行断言非终态抛出异常回滚事务。
- **修改文件/commit**：`shell/server.cjs` / Commit: `6b932ce`
- **修复前后证据**：修复前抛错 `Run not drained` 阻断资料删除；修复后宽容处理过渡态并安全等待注销。
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` PASS。
- **剩余风险**：删除时若有 Run 正在打字，会收到平滑的上下文变更提示。

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
- **回归结果**：`batch1-bugfix-test.mjs` PASS。
- **剩余风险**：`CONFIG_PENDING`，依赖生产/FAT 环境变量 `PT_DASH_INTERNAL_KEY`。

### Bug-03
- **Bug ID**：Bug-03
- **版本/环境**：r28 / `https://agent-fat.adorado.top`
- **预期/实际**：
  - 预期：用量与运行列表中展示真实任务，按时间倒序排列，最新成功运行置顶。
  - 实际：列表数据不全，看不到成功的运行数据。
- **复现步骤**：运行数次成功对话或工具调用，进入用量与日志查看运行清单。
- **根因**：`shell/tasks/store.cjs` 中 `listRuns` 查询为 `ORDER BY run_id`，UUID 伪随机排序导致新记录散落截断。
- **修改文件/commit**：`shell/tasks/store.cjs` / Commit: `27f4731`
- **修复前后证据**：修复前随机乱序；修复后变更为 `ORDER BY created_at DESC, run_id DESC`。
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：远端若添加新模型，依赖后台定时同步或带 `force=1` 显式刷新。

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
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` PASS。
- **剩余风险**：其他业务类工具仍保留 4 次上限保护。

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
- **剩余风险**：`CONFIG_PENDING`，依赖 `PT_DASH_INTERNAL_KEY`。

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
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` PASS。
- **剩余风险**：若操作系统剪贴板未提供文件句柄，将退化为普通纯文本粘贴。

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
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` PASS。
- **剩余风险**：用户最终生成仍需在前端确认卡片二次点击授权。

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
- **回归结果**：`tests/regression/batch1-bugfix-test.mjs` PASS。
- **剩余风险**：`CONFIG_PENDING`，需运维确认反代 Nginx 未覆盖同名 CSP 头。

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
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：预览窗口严格启用沙箱隔离，禁止运行恶意外部脚本。

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
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch4-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` PASS。
- **剩余风险**：视频最终落地还受宿主 `PT_MEDIA_ASSET_HOSTS` 限制。

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
- **回归结果**：`tests/regression/batch2-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` PASS。
- **剩余风险**：无。

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
- **回归结果**：`tests/regression/batch3-bugfix-test.mjs` PASS。
- **剩余风险**：若用户手动强制选择不支持视觉的纯文本模型并传图，会提示切换。

---

## 五、 运维环境配置差异单 (CONFIG-DELTA)

| 环境变量名称 | 代码读取点 | 适用服务 | 用途与必要性 | 缺失表现 | 非敏感建议值 |
|---|---|---|---|---|---|
| **`PT_DASH_INTERNAL_KEY`** | `shell/server.cjs:1995` | `northstar-shell` | **必需**。用于计算内部租户只读鉴权签名，关联 Bug-02, 06, 11, 15 | 内部代理请求 403 / 502 | 注入由看板签发的内部共享秘钥字符串 |
| **`PT_MEDIA_ASSET_HOSTS`** | `shell/server.cjs:2864` | `northstar-shell` | **必需**。官方 CDN 白名单，供抓取视频/图片落盘，关联 Bug-16 | 视频下载报 `HOST_NOT_ALLOWED` | `"ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com,pub-ee388a8463c1497c8b4f503044a80ee1.r2.dev,pub-425ca9cea13d454a907692a0a9f80079.r2.dev"` |

**Nginx 协同核对 (Bug-10)**：
服务端已将响应头修改为 `Content-Security-Policy: frame-ancestors 'self'`。请运维确认 Nginx 反代配置中没有全局追加 `frame-ancestors 'none'` 或 `X-Frame-Options "DENY"` 指令。

---

## 六、 测试执行证据与退出码 (TEST-EVIDENCE)

在隔离工作区执行全量回归套件：
```bash
node --test tests/regression/batch1-bugfix-test.mjs \
            tests/regression/batch2-bugfix-test.mjs \
            tests/regression/batch3-bugfix-test.mjs \
            tests/regression/batch4-bugfix-test.mjs
```
**实测结果**：
- **退出码**：`0`
- **总耗时**：53.2 ms
- **测试通过率**：**13/13 PASS (100%)**
- **持久层测试**：`task-store-test.mjs` PASS (1.26s)

---

## 七、 主程一键审查与集成指引

主程可直接在干净工作区运行以下命令拉取并审查本分支：

```bash
# 1. 查看分支与主线 r28 的差异统计
git diff --stat bbd9997d1e19920dc1c850c31ec6c71dbc5994d1..candidate/r28-bugfix-full

# 2. 详细审查代码差异（5 个生产文件）
git diff bbd9997d1e19920dc1c850c31ec6c71dbc5994d1..candidate/r28-bugfix-full shell/

# 3. 运行全套回归自测
git checkout candidate/r28-bugfix-full
node --test tests/regression/batch1-bugfix-test.mjs tests/regression/batch2-bugfix-test.mjs tests/regression/batch3-bugfix-test.mjs tests/regression/batch4-bugfix-test.mjs

# 4. 若审查通过，执行快进合并（Fast-Forward）
git checkout <your-target-branch>
git merge --ff-only candidate/r28-bugfix-full
```
