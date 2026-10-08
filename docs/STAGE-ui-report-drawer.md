# STAGE · U3-report-drawer：report 类型通用抽屉渲染器

> 任务包：做一个**通用**抽屉组件，把 Skill 返回的 `outputType: report` 结构
> （标题 + 评分条 + KV 列表 + 问题清单表格 + 整改建议）渲染成界面抽屉。
> 组件与具体 Skill 解耦——Skill-1/2/3/4 只要返回 `report` 这套结构，都复用同一个渲染器。
> 分支：`feature/ui-report-drawer`（基于 main `381df2f`，已合并 U5）。未 push、未合 main。

## 一、交付物

### 1. 纯渲染层 `shell/public/report-render.js`（无 DOM、可单测）
- `renderReportHTML(report)`：把任意 report 结构渲染成 HTML 片段（标题/meta/schema/评分条/KV/表格/建议）。
- 严格对齐 `analytics/backend/glue/validate.js` 的 `OUTPUT_MOLDS.report`：
  - **required**: `title`, `meta`
  - **optional**: `score`, `stats`, `table`, `suggestions`
- **别名兼容**（用户口语化字段名也能渲染）：`scoreBar→score`、`kv→stats`、`issues→table`、`remediation→suggestions`。
- **包裹形式兼容**：直接 report / `{report, generated_at}`。
- 评分条支持纯数字 / `{value,color,label}`；KV 支持 `[[k,v]]` / `[{key,value}]` / `{k:v}`；表格支持 `{head,rows}` / `[{obj}]` / `{columns,data}`；建议支持 `string`(按 `·`/换行拆) / `string[]` / `{items:[{text,priority}]}`。
- **严重度徽标**：`高/中/低`（含 high/mid/low）自动着色。
- **安全铁律**：所有动态文本 `escapeHtml`；颜色只接受合法色值（`safeColor`），否则兜底灰——report 数据来自 Skill 输出（不可信），零注入风险（验收已覆盖 XSS 用例）。
- 双重导出：浏览器挂 `window.ReportRender`，Node 走 `module.exports`（便于自动化验收）。

### 2. 抽屉外壳 `shell/public/report-drawer.js`（仅浏览器）
- 复用 `key-drawer.js` 范式：overlay + aside，关键布局 inline style，内容样式注入 `<style id="rpt-styles">`（避开 `[hidden]{display:none!important}` 全局规则）。
- 暴露：`window.openReportDrawer(report)`、`window.closeReportDrawer()`、`window.openSampleReportDrawer()`。
- 渲染逻辑全部委托给 `report-render.js`，本文件只负责「装进抽屉 + 开关」。

### 3. 接线 `shell/public/index.html`
- 加载顺序：`report-render.js` → `report-drawer.js`（在 `key-drawer.js` / `app.js` 之前）。
- 首页「埋点质量 AI 分析」chip 改为可点击入口（`id="skill2Chip"`、`预览` 徽标），点击打开样本预览抽屉。
  - 这是**基座「业务工具通用加载入口」就绪前的演示/验收接线**；基座就绪后用真实 Skill-2 输出调用 `openReportDrawer(realOutput)` 即可，无需改本组件。

### 4. 代表性样本
- `report-render.js` 内嵌 `sampleReport`（Skill-2 埋点质量分析的**真实结构**样本），用于演示与验收。组件本身不依赖任何具体 Skill。

## 二、为什么这样设计（通用性）
- **数据驱动，零 Skill 特化**：渲染器只读 report 结构字段，不写任何 Skill-2 专属逻辑。将来 Skill-1/3/4 返回同类型，直接复用。
- **纯函数 + 外壳分离**：渲染逻辑无 DOM 依赖，可用 Node 直接单测；抽屉外壳仅在浏览器执行（DOM 守卫）。
- **沿用既有范式**：评分条/关键指标/风险表格/整改建议的渲染样式，对齐 `analytics/frontend/tabs/health.js`（已有 report 渲染实践），保持设计一致。

## 三、验收结果（`_u_report_accept.cjs`，28/28 PASS）
- 代表性 Skill-2 样本渲染：标题 / meta / schema / 评分条(72) / KV / 问题表格(purchase+高严重度徽标) / 整改建议 全部出现。
- **不是原始 JSON**（无裸 `"outputType"`/`"score"` 键）。
- 别名兼容（scoreBar/kv/issues/remediation）渲染同结构。
- 包裹形式 `{report, ...}` 兼容。
- **XSS 安全**：title/meta/单元格中的 `<script>`/`<a href=javascript>` 均被转义（标签失效）。
- 缺可选字段不崩（仅必填 title/meta 也能渲染）。

## 四、待基座就绪后的真正接入
基座「业务工具通用加载入口」做完后，对话结果/Skill 输出命中 `outputType === "report"` 时，调用 `window.openReportDrawer(output)` 即可在对话结果里弹出抽屉——本组件与接线点已就绪，无需改动。

## 五、提交
- 用 plumbing 配方（绕开本仓库 git loose-ref 老毛病）提交到 `feature/ui-report-drawer`：
  `read-tree main` → `add` 4 文件 → `write-tree` → `commit-tree -p main` → 手写 loose ref → `checkout-index`。
- 改动文件：`shell/public/report-render.js`（新）、`shell/public/report-drawer.js`（新）、`shell/public/index.html`（接线）、`docs/STAGE-ui-report-drawer.md`（新）。
