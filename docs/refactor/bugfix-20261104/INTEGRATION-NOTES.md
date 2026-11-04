# 主程序集成与冲突预防指南 (INTEGRATION-NOTES)

**接收人**：Codex 主程序  
**范围**：四批 Bug 修复提交在合入主线时的依赖顺序、潜在冲突分析、与 Gemini 原 8 包的兼容性及回退指引。

---

## 一、 提交依赖与合入顺序

四批提交已经以线性链形式构建完成，**无需进行复杂的挑选或重排，推荐直接基于 Tip Commit 集成**：

```text
基线：r28 (bbd9997)
  └─> Batch 1 (13806fa): 核心阻断与认证 (Bug-10, 02, 06, 11, 15, 05, 09)
        └─> Batch 2 (6b932ce): 输入与交互 (Bug-08, 17, 01)
              └─> Batch 3 (5b941d6): 多模态与媒体 (Bug-16, 18, 19, 20)
                    └─> Batch 4 (27f4731): 呈现与稳定性 (Bug-03, 04, 07, 12, 13, 14)
```

**集成操作建议**：
主程序可直接在干净工作区拉取并审查分支：
```bash
git merge --ff-only candidate/r28-bugfix-full
# 或者基于 27f4731b329a5775eadfd14b0b26bed6b653d47e 创建集成 MR / PR
```

---

## 二、 与 Gemini 原 8 包及主线潜在冲突分析

本次修复严格遵循隔离规范，**未修改任何任务包文件（未触及 `docs/refactor/GEMINI-*` 候选包）**。与共享入口文件的冲突风险评估如下：

### 1. `shell/server.cjs` (中等关注度)
- **改动点**：
  - CSP 响应头：第 127 行将 `'none'` 调整为 `'self'`。
  - 模型缓存：`ensureModelCatalog` 默认取消 `{ force: true }`。
  - 聊天收尾：`persistSteps` 异常处理、HTML 代码块物化为 `report.html`、以及失败时 `closeDshSession` 调用。
- **潜在冲突预防**：
  若 Gemini 候选包有扩展新的路由或中间件，合并时只需保留本补丁中的 CSP 同源放行、模型走缓存逻辑，以及 HTML 物化逻辑即可，两者在逻辑上正交。

### 2. `shell/persistent-runner.mjs` (低关注度)
- **改动点**：
  - 仅在 `get_current_time` 工具调用时豁免计数，并在 turn 错误及 catch 块中增加了 `agentMap.delete(sid)` 坏态驱逐。
- **潜在冲突预防**：
  若上下文压缩（R4）或媒体生成对 `handleTurn` 有改动，确保在任何错误返回点保留 `agentMap.delete(sid)` 即可，防止 Cordis session 残留。

### 3. `shell/public/app.js` (中等关注度)
- **改动点**：
  - 剪贴板 paste 事件放行非图片。
  - 媒体授权下拉框精准过滤 `taskType`。
  - 模型下拉菜单区分展示聊天与生成模型。
- **潜在冲突预防**：
  前端改动均为局部逻辑加固，与业务流库、看板渲染无代码重叠。

### 4. `shell/tasks/store.cjs` (低关注度)
- **改动点**：
  - `listRuns` 中将 `ORDER BY run_id` 增强为 `ORDER BY created_at DESC, run_id DESC`。
- **潜在冲突预防**：
  完全向下兼容 `afterRunId` 游标分页契约，不会破坏任务状态迁移或外部算子对账逻辑。

---

## 三、 回退与防灾指南

1. **单批次回退能力**：
   由于四批改动各司其职，若测试发现某一功能需要进一步调整，可单独 revert 对应 commit：
   - 若文生图模型展示需再微调：可单独 cherry-pick / revert `5b941d6`。
   - 若 HTML 产物预览需调整：仅需针对 `server.cjs` 中的物化块调整，不影响前序多模态与认证功能。
2. **外部依赖故障隔离**：
   若生产环境未配置 `PT_DASH_INTERNAL_KEY`，广告导入接口将安全返回规范的 403 错误，系统其它 Agent 核心对话、媒体生成等模块完全不受影响（Fail-Closed）。
