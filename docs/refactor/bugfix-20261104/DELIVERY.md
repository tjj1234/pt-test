# r28 全量 Bug 修复与集成送审交付报告 (DELIVERY)

**交付日期**：2026-11-04  
**交付责任人**：Bug修复程序 / 原修复作者  
**接收人**：Codex 主程序（代码主审与集成负责人）  
**基线版本**：Release r28 线上提交 `bbd9997d1e19920dc1c850c31ec6c71dbc5994d1`  
**候选集成分支**：`candidate/r28-bugfix-full`（对应工作区分支 `fix/bug-batch4-presentation-output`）  
**完整候选 Tip Hash**：`27f4731b329a5775eadfd14b0b26bed6b653d47e`  
**工作区绝对路径**：`/private/tmp/pt-fix-batch4`（主仓库 `/Users/mmdn/Downloads/pt项目` 保持干净未改动）  
**交付状态**：**送主审状态（SUBMITTED_FOR_REVIEW）**。停止在送审状态，不自行合并主线、不上线、不修改生产配置。

---

## 一、 四批分支关系与完整提交树

所有四批修复采用单向线性依赖演进，第四批分支的 Tip 直接包含了前三批的全部提交，祖先关系清晰完整：

```
* 27f4731b329a5775eadfd14b0b26bed6b653d47e (HEAD -> fix/bug-batch4-presentation-output, candidate/r28-bugfix-full)
|   fix(batch4): fix log ordering, model loading lag, turn failure recovery, and html artifact preview
|   涵盖 Bug: Bug-03, Bug-04, Bug-07, Bug-12, Bug-13, Bug-14
|
* 5b941d6255c4138b23b163fc94ff60d58a8073ec (fix/bug-batch3-multimodal-media)
|   fix(batch3): resolve media authorization, image understanding qualification and media routing
|   涵盖 Bug: Bug-16, Bug-18, Bug-19, Bug-20
|
* 6b932ce6b82d4a53da087f401b2140c517f4631c (fix/bug-batch2-input-interaction)
|   fix(interaction): support non-image clipboard paste, allow sending attachments without text, and fix source revocation run drain
|   涵盖 Bug: Bug-08, Bug-17, Bug-01
|
* 13806fa5e9f268e068a9facb0d7685ec4c522b2e (fix/bug-batch1-core-blockers)
|   fix(core): fix CSP frame-ancestors, token provisioning on proxy, and get_current_time tool budget
|   涵盖 Bug: Bug-10, Bug-02, Bug-06, Bug-11, Bug-15, Bug-05, Bug-09
|
* bbd9997d1e19920dc1c850c31ec6c71dbc5994d1 (origin/feature/northstar-integration-20261102)
    docs: save r28 online state and next-session handoff
```

- **Merge Base**：`bbd9997d1e19920dc1c850c31ec6c71dbc5994d1`
- **Tip Hash**：`27f4731b329a5775eadfd14b0b26bed6b653d47e`
- **差异统计**：共修改 5 个核心代码文件，新增 4 个自动化回归测试文件，总变更 `+618 / -35` 行，无任何未跟踪脏文件。

---

## 二、 与独立测试报告 (`PTR-20261104-R28-FINAL`) 的差异分析

独立测试工程师于 2026-11-04 15:30 (UTC+9) 对线上 FAT 镜像环境 (`https://agent-fat.adorado.top/`) 进行了实测。核对后确认：**该测试是在四批修复代码合入/发布之前针对未打补丁环境进行的**。

| 事项 / Bug | 独立测试工程师报告观察 | 修复候选分支实际状态 | 差异原因与主程说明 |
|---|---|---|---|
| **Bug-01** (资料选择后删除) | 列为“待前端专项优化” | 代码已修，增加删除确认与上下文解挂 | 测试时线上仍为旧版，未集成 Batch 2 修复 |
| **Bug-08** (非图片剪贴板粘贴) | 列为“待前端专项优化” | 代码已修，放开表格/音视频 MIME 分流 | 测试时线上未集成 Batch 2 修复 |
| **Bug-17** (仅图片无文字发送) | 列为“待前端专项微调” | 代码已修，空文本时自动填充分析引导词 | 测试时线上未集成 Batch 2 修复 |
| **Bug-02/06/11/15** (403 invalid token) | 现场 curl 复测 403 / 502 | 代码已修鉴权代理，标注 `CONFIG_PENDING` | 代码层已修复内部租户令牌路由，但依赖生产/FAT 环境配置 `PT_DASH_INTERNAL_KEY` |
| **Bug-10** (CSP iframe 拦截) | 归因为 Nginx 反代响应头冲突 | 服务端响应头 `frame-ancestors 'none'` 已修正为 `'self'` | 服务端已放行同源；若 Nginx 额外下发了同名头，需运维协同检查 |
| **Bug-04** (模型切换慢) | 认为资格探活耗时为预期，建议加缓存 | 代码已去除无条件 `{ force: true }` 穿透 | 切换会话与模型时默认查内存缓存（< 5ms），不再发起外部 HTTPS 往返 |
| **Bug-12** (HTML 回复纯代码块) | 归因为 Prompt 策略缺陷 | 实现了服务端 HTML 代码块自动物化为 `report.html` 产物 | 用户无需依赖模型自我工具调用，直接在沙箱 `#artPane` 获得交互式网页与下载 |
| **Bug-13/14** (会话失败后坏态死锁) | 归因为历史遗留，称 R4 链修复后零崩溃 | 代码层实现了 agent session 内存驱逐与原生会话重置 | 针对 turn incomplete / error 错误，确保下一次在同一会话输入时能平滑自愈 |
| **Bug-16** (文生视频模型弹窗 409) | 提出租约超时、模型过滤问题，指出缺 CDN 域名 | 代码已限定仅展示合格媒体模型，并保留流式内容 | 避免非法模型提交触发 409；CDN 白名单属于运维配置项 `PT_MEDIA_ASSET_HOSTS` |
| **Bug-20** (图片理解无核验模型) | 建议“排入下阶段多模态计划” | 代码已实现 AUTO 模式下视觉候选 `qwen3.8-flash` 试跑核验 | 明确闭环该问题，不拖延至下一阶段 |

---

## 三、 20 个 Bug 处理状态速览汇总

状态定义：
- `CODE_FIXED`：代码修复完成，本地自动化测试通过。
- `AUTHOR_UI_TESTED`：修复作者在隔离服务环境下走通了 UI 流程。
- `CONFIG_PENDING`：代码已完善，但生效依赖真实环境运维配置（如密钥/域名）。
- `SCOPE_CLARIFIED`：属于底层安全或架构边界，已补充机制说明与替代体验闭环。
- `INDEPENDENT_RETEST_PENDING`：待主程序组织独立测试工程师在新镜像复测。

| Bug ID | 用户反馈要点 | 分支 / Commit | 处理状态 | 核心解决方式 |
|:---:|---|:---:|:---:|---|
| **01** | 已选资料不能删除 | Batch 2 (`6b932ce`) | `CODE_FIXED` / `AUTHOR_UI_TESTED` | 修复 Run 取消过渡态 409，放行资料删除与上下文清理 |
| **02** | enabled-status 报 502/403 | Batch 1 (`13806fa`) | `CODE_FIXED` / `CONFIG_PENDING` | 修复工作区状态代理鉴权映射；需配置 `PT_DASH_INTERNAL_KEY` |
| **03** | 日志缺成功记录 | Batch 4 (`27f4731`) | `CODE_FIXED` | `listRuns` 改为 `created_at DESC` 稳定排序，最新成功记录置顶 |
| **04** | 模型/会话切换极慢 | Batch 4 (`27f4731`) | `CODE_FIXED` | 去除无条件 `{ force: true }`，读取本地缓存避免外网阻塞 |
| **05** | 时间等工具 budget 耗尽 | Batch 1 (`13806fa`) | `CODE_FIXED` | 只读探针 `get_current_time` 豁免调用预算计数 |
| **06** | 广告导入 workspace 403 | Batch 1 (`13806fa`) | `CODE_FIXED` / `CONFIG_PENDING` | 修正内部只读令牌代理转发；需配置 `PT_DASH_INTERNAL_KEY` |
| **07** | 不能回写到上传文件 | Batch 4 (`27f4731`) | `SCOPE_CLARIFIED` | 阐明上传文件只读哈希安全边界，物化新产物供下载替代 |
| **08** | 不能粘贴表格和视频 | Batch 2 (`6b932ce`) | `CODE_FIXED` / `AUTHOR_UI_TESTED` | 扩展剪贴板文件类型分流，支持表格/音视频进入附件区 |
| **09** | 生成图片/问日期 budget 耗尽 | Batch 1 (`13806fa`) | `CODE_FIXED` | 自动识别媒体意图放宽任务预算，配合时间探针豁免 |
| **10** | 归因看板被 CSP 拦截 | Batch 1 (`13806fa`) | `CODE_FIXED` / `CONFIG_PENDING` | 服务端将 `frame-ancestors 'none'` 调整为 `'self'` |
| **11** | 广告导入 jobs 403 | Batch 1 (`13806fa`) | `CODE_FIXED` / `CONFIG_PENDING` | 修正导入任务鉴权头；需配置 `PT_DASH_INTERNAL_KEY` |
| **12** | HTML 只回复代码内容 | Batch 4 (`27f4731`) | `CODE_FIXED` | 服务端提取 HTML 代码块物化为 `report.html` 沙箱产物 |
| **13** | details withheld，同会话死锁 | Batch 4 (`27f4731`) | `CODE_FIXED` | 异常时驱逐损坏 session，下轮发言自动初始化健康实例 |
| **14** | turn ended without completion | Batch 4 (`27f4731`) | `CODE_FIXED` | 捕获未完成状态，清理内存坏态，保留会话历史关联 |
| **15** | 调度执行页面 403 | Batch 1 (`13806fa`) | `CODE_FIXED` / `CONFIG_PENDING` | 统一导入子系统租户认证；需配置 `PT_DASH_INTERNAL_KEY` |
| **16** | 媒体授权 409，回答消失 | Batch 3 (`5b941d6`) | `CODE_FIXED` | 弹窗下拉精准限定合格候选，保留 `acc` 流式内容防闪烁 |
| **17** | 图片必须输入文字才能发 | Batch 2 (`6b932ce`) | `CODE_FIXED` / `AUTHOR_UI_TESTED` | 前端放行纯图片，服务端缺省注入「请分析该图片」提问 |
| **18** | 对话不支持文生图/图生图/视频 | Batch 3 (`5b941d6`) | `CODE_FIXED` / `AUTHOR_UI_TESTED` | 标识素材生成模型，点击自动切换为文生图/文生视频模式 |
| **19** | 图片视频模型列表中不可用 | Batch 3 (`5b941d6`) | `CODE_FIXED` / `AUTHOR_UI_TESTED` | 暴露标准媒体候选资格，区分普通聊天模型与生成模型 |
| **20** | 图片理解报无通过核验模型 | Batch 3 (`5b941d6`) | `CODE_FIXED` | AUTO 识图无缓存时自动试跑视觉候选 `qwen3.8-flash` |

---

## 四、 核心代码修改文件清单 (5 个文件)

1. `shell/server.cjs`：
   - CSP 放行同源 iframe：`frame-ancestors 'self'` (Bug-10)
   - 内部租户鉴权代理与只读 Token 补齐 (Bug-02, 06, 11, 15)
   - 媒体意图自动识别与动态预算扩展 (Bug-05, 09)
   - 纯图片发送后端兜底提问 (Bug-17)
   - 资料注销时安全等待 Run 状态 (Bug-01)
   - AUTO 模式图片理解自适应试跑候选 `qwen3.8-flash` (Bug-20)
   - 标准媒体目录与生成资格核验 (Bug-18, 19)
   - 移除模型目录无条件强制远端刷新，默认走缓存 (Bug-04)
   - 异常轮次服务端主动关闭原生会话 (Bug-13, 14)
   - HTML 代码块提取并物化为 `report.html` 产物 (Bug-12)
2. `shell/persistent-runner.mjs`：
   - 时间工具 `get_current_time` 豁免工具调用计数 (Bug-05)
   - 异常轮次或未完成状态时主动从 `agentMap` 驱逐损坏 session (Bug-13, 14)
3. `shell/public/app.js`：
   - 剪贴板 paste 事件支持表格与音视频分流 (Bug-08)
   - 发送按钮放行纯图片/附件 (Bug-17)
   - 媒体授权弹窗精确过滤合格模型，保留流式增量防清空 (Bug-16)
   - 模型菜单区分聊天模型与素材生成模型，点击联动模式 (Bug-18, 19)
   - 选定图片时给出视觉模型友好提示 (Bug-20)
4. `shell/tasks/store.cjs`：
   - `listRuns` 改为按 `created_at DESC, run_id DESC` 稳定排序 (Bug-03)
5. `shell/agent-persona.md`：
   - 人设中增补上传文件只读哈希与产物输出安全边界说明 (Bug-07)

---

## 五、 交付件索引

所有配套交付材料已归档于分支内 `docs/refactor/bugfix-20261104/` 目录：
- `DELIVERY.md`：本交付主报告
- `BUG-MATRIX.md`：20 个 Bug 的 9 字段全景核验与状态矩阵
- `TEST-EVIDENCE.md`：本地与隔离测试全量命令、日志与退出码凭证
- `CONFIG-DELTA.md`：运维环境配置差异单与非敏感示例说明
- `RETEST-CHECKLIST.md`：供独立测试工程师使用的复测步骤与判定标准
- `INTEGRATION-NOTES.md`：主程序集成接入、冲突预防与回退指南
