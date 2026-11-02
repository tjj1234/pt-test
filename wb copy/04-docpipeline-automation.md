# 第四批实现设计：文档管线 + 自动化调度

> 逆向来源：
> - 文档管线：内置插件 `app-extracted/resources/plugins/workbuddy-builtin/builtin-plugins/tencent-docx/`（全套 SKILL.md / agent / reference 源码，非 bundle）
> - 自动化调度：CLI 内核 `codebuddy.js`（22MB webpack bundle）Cron 模块还原
> 目标：粒度到"可直接照着写代码"。所有类型定义、算法、文件格式均从产物还原，非猜测。

---

# 第一部分：文档管线（tencent-docx 插件）

## 0. 总览：一条"创作→美化→转换"的三段流水线

```
用户意图（"帮我写一份 XX 文档" / "把这份文档美化"）
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ tdoc-orchestrator（Stage 0 意图判定）                         │
│   短篇 <1000 字 → brief-compose 直通                          │
│   编辑/注入类 → 转 tencent-docs-routing（不走本管线）          │
│   空白文档 → 转 tencent-local-office-edit                     │
│   创作 → full_pipeline (S1→S2→S3)                            │
│   美化 → beautify_only (S2→S3)                               │
└──────────────────────────────────────────────────────────────┘
   │
   ├── S1 doc-writer    ：意图/主题 ──→ markdown 终稿
   ├── S2 doc-formatter ：md/内容文档 ──→ 排版后 HTML
   └── S3 doc-converter ：HTML ──→ .docx + 强制 present_files 预览

全程溯源：pipeline-state.yaml（审计）+ trace/pipeline.log（JSON Lines）
```

复刻要点（务必保留）：

1. **合法链硬约束**：前一 stage 的输出格式必须匹配后一 stage 的输入格式；S1 必须经 S2；任何链必须终止于 S3。不允许"跳级"（S1 直接到 S3）。
2. **只有最终 `.docx` 才 `present_files`**：中间产物 `.md` / `.html` 一律不预览。
3. **委派用"角色切换"**：读 agent.md 后必须切到对应 agent 执行，禁止主 agent"顺手自己做"。
4. **pipeline-state.yaml 是审计记录不是锁**：只用于溯源/恢复判断，不用来阻塞执行。

---

## 1. 插件结构（磁盘布局，照着建目录即可）

插件根：`tencent-docx/`

```
tencent-docx/
├── .codebuddy-plugin/plugin.json        # 声明 hooks / skills / agents
├── SKILL.md                             # 插件入口规则
├── hooks/hooks.json                     # SessionStart 预热脚本
├── agents/
│   ├── doc-writer.md                    # S1 执行者
│   ├── doc-formatter.md                 # S2 执行者
│   └── doc-converter.md                 # S3 执行者
├── skills/
│   ├── tdoc-orchestrator/               # ★ 编排中枢（Stage 0）
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── pipeline-state-protocol.md   # YAML 溯源 schema
│   │       └── log-schema.md                # JSONL 日志 schema
│   ├── format-extract/                  # S2 html-imitate 的格式提取（docx→HTML）
│   │   ├── SKILL.md
│   │   ├── run.py
│   │   └── references/{node-install,cli-reference}.md
│   ├── design-token/                    # 设计令牌（主题/规则/编译产物）
│   │   ├── SKILL.md
│   │   ├── scripts/build_tokens.py
│   │   └── tokens/{compiled,themes,rules}/
│   ├── doc-typeset/                     # 排版引擎（模板 + prompt）
│   │   ├── SKILL.md
│   │   ├── templates/*.html             # 每种 genre 一个模板
│   │   ├── prompts/*.md                 # 每种 genre 一个排版 prompt
│   │   └── components/*.html            # section-marker/divider/data-card/callout
│   ├── html-review/                     # HTML 质检门禁（只跑一次）
│   │   ├── SKILL.md
│   │   ├── scripts/review_html.py
│   │   └── references/{typographic-quality,structural-integrity,security-check,genre-fit,design-token-compliance,decoration-usage}.md
│   ├── html-to-docx/                    # S3 转换引擎（Python）
│   │   ├── SKILL.md
│   │   └── scripts/html_to_docx/*.py
│   └── brief-compose/                   # P0 短篇直通
│       └── SKILL.md
├── experts/                             # S1 的 9 类专家
│   ├── general-writer/                  # 兜底
│   ├── legal-contract-expert/
│   ├── stock-research-report-expert/
│   ├── business-copy-expert/
│   ├── tech-blog-expert/
│   ├── academic-paper-expert/
│   ├── science-writing-expert/
│   ├── work-report-expert/
│   └── poetry-prose-expert/
├── core/engines/
│   ├── deep-research/                   # 深度研究引擎
│   └── critic-generator/                # 批评/评审引擎（S1 的 critic）
└── scripts/wb/local/
    ├── setup.sh                          # SessionStart 预热
    ├── setup-html-to-docx.sh             # Python venv 幂等安装
    └── resolve_output_docx_path.py       # 输出路径解析
```

### 1.1 插件入口规则（`SKILL.md` + `hooks/hooks.json`）

- 插件被加载后，必须 `Read tdoc-orchestrator/SKILL.md` 并按其 Stage 0 执行。
- **禁止**直接调用 MCP 编辑工具或 `python-docx`，一切编辑/生成必须经 orchestrator 路由。
- 空白文档例外：转 `tencent-local-office-edit`。
- `hooks.json` 的 `SessionStart` hook（后台预热，timeout 5s）：

```bash
bash "${CODEBUDDY_PLUGIN_ROOT}/scripts/wb/local/setup.sh" </dev/null >/dev/null 2>&1 &
```

---

## 2. Orchestrator：Stage 0 意图判定（`skills/tdoc-orchestrator/SKILL.md`）

### 2.1 路由决策树

| 判定条件 | 路由 |
|---|---|
| 短篇创作 < 1000 字 | `brief-compose`（绕过完整 pipeline） |
| 编辑/注入类（改已有文档的明确目标值、润色文字） | `tencent-docs-routing` |
| 空白文档 | `tencent-local-office-edit` |
| 抽象设计决策（"更好看"）= 美化 | `beautify_only` = S2→S3 |
| 从零创作 | `full_pipeline` = S1→S2→S3 |

**美化 vs 编辑的判别**：目标是"更美观/更好看"这类抽象设计 → 走美化；目标是"明确的目标值或润色" → 走编辑转 `tencent-docs-routing`。

### 2.2 原子能力（stage）与合法链

```
S1 doc-writer    ：意图 ──→ md
S2 doc-formatter ：md/内容文档 ──→ html
S3 doc-converter ：html ──→ docx + 强制 present_files

合法链：
  full_pipeline  = S1 → S2 → S3
  beautify_only  = S2 → S3
  非法：S1 → S3（S1 必须经 S2）；任何链必须终于 S3
```

---

## 3. S1 创作：doc-writer（`agents/doc-writer.md`）

### 3.1 输入/输出契约

输入：`user_query`（原始意图）、`entry_type`（full_pipeline）。

输出（YAML 契约）：

```yaml
created_content: string          # 正文 Markdown
expert_used: string              # 命中的专家名
route_tag: string                # 路由标签
genre: string                    # 题材
final_draft_path: string         # 终稿路径
critic_decision: string          # pass | revise | ...
critic_score: number
critic_unresolved_p0: list       # 未解决的 P0 问题
critic_report_path: string
```

### 3.2 Expert 路由表（L2 题材路由）

| 顺序 | Expert | genre |
|---|---|---|
| 1 | legal-contract-expert | `legal-contract` |
| 2 | stock-research-report-expert | `stock-research` |
| 3 | business-copy-expert | `business-copy` |
| 4 | tech-blog-expert | `tech-blog` |
| 5 | academic-paper-expert | `academic-paper` |
| 6 | science-writing-expert | `science-writing` |
| 7 | work-report-expert | `work-report` |
| 8 | poetry-prose-expert | `poetry-prose` |

未命中 → `general-writer` 兜底。

### 3.3 Critic 风险分档（评审触发频率）

| 风险档 | genre | critic 触发 |
|---|---|---|
| 高风险 | `legal-contract`、`stock-research` | per-section（逐节） |
| 高风险 | `academic-paper` | once |
| 中风险 | `work-report`、`business-copy` | once |
| 低风险 | `science-writing`、`tech-blog`、`poetry-prose`、`general`、未知 | skip |

### 3.4 Markdown 格式门禁

- 正文只允许纯 Markdown；禁止 HTML / LaTeX / RTF / JSON / YAML 正文。
- 不加 frontmatter。

---

## 4. S2 美化：doc-formatter（`agents/doc-formatter.md`）

### 4.1 输入/输出契约

输入（YAML）：

```yaml
user_query: string
entry_type: stage2_flow | standalone
final_draft_path: string          # 来自 S1
created_content: string           # 来自 S1
intermediate_dir: string          # stage2/intermediate/
genre: string
ref_doc_path: string              # 可选，参照文档
content_doc_path: string          # 可选
```

输出（YAML）：

```yaml
formatted_output_path: string
output_format: html
route_used: html-template | html-imitate
skills_invoked: string[]
pipeline_log: PipelineLog
```

### 4.2 路由

```
有 ref_doc → html-imitate
无 ref_doc → html-template
```

### 4.3 两条链

```
html-template 链：
  genre 推断 → design-token → doc-typeset → html-review（只检查一次）→ HTML

html-imitate 链：
  format-extract（提取 ref_doc 风格）→ design-token → doc-typeset(mode=imitate) → html-review
```

### 4.4 genre 推断表（意图 → 模板主题）

公文 / 论文 / 合同 / 研报 / 会议纪要 / 营销 / 报告 / general。

### 4.5 降级原因（fallback_reason 枚举）

`ref_doc_unreadable`、`design_token_failed`、`template_not_found`、`format_extract_failed` 等。

---

## 5. S3 转换：doc-converter（`agents/doc-converter.md`）

唯一执行者。

- 输入：`html_output_path`、`convert_options`、`entry_type`、`user_query`。
- 转换输出路径：读 `pipeline-state.yaml` 顶层 `output_docx_path`。
- 调用 `skills/html-to-docx/SKILL.md`。
- **强约束**：拿到 `.docx` 必须立即 `present_files` 打开预览，否则 S3 视为未完成。
- 失败处理：`success=false`，返回 `markdown_fallback` + 源 HTML 路径，`fallback_reason=html_to_docx_failed`，**不再本地兜底生成 docx**。

---

## 6. 溯源协议

### 6.1 `pipeline-state.yaml`（审计记录，Schema v1）

顶层字段：

```yaml
schema_version: 1
request_id: string
created_at: string
updated_at: string
entry_type: full_pipeline | beautify_only
stage_chain: [1,2,3]
output_docx_path: string
output_docx_user_specified: bool
current_stage: int
stages:
  stage_0:                 # decision
  stage_1:                 # S1
    status: string
    output_path: string
    genre: string
    expert_used: string
    route_tag: string
    critic_decision: string
  stage_2:                 # S2
    route: html
    html_sub: template | imitate
    output_path: string
    output_format: html
    skills_invoked: list
    design_tokens_path: string
    fallback: string
  stage_3:                 # S3
    executor: doc-converter
    input_format: html
    output_path: string
    skill_used: ["html-to-docx"]
    present_files_opened: bool
    fallback: string
consistency_check:
  output_files_exist: bool
  stage_chain_complete: bool
```

### 6.2 输出目录结构

```
<workspace>/output/<request_id>/
├── pipeline-state.yaml
├── stage1/final_draft.md
├── stage2/
│   ├── design_tokens.json
│   ├── formatted-<主题>.html
│   └── intermediate/
├── stage3/<文件名>.docx
├── working/
└── trace/pipeline.log
```

### 6.3 输出路径解析脚本

```bash
python3 <plugin_root>/scripts/wb/local/resolve_output_docx_path.py \
  --workspace <workspace> --request-id <request_id> \
  [--user-path "<路径>"] [--filename "<主题>.docx"]
```

### 6.4 `trace/pipeline.log`（JSON Lines）

每行必填字段：

```json
{
  "request_id": "...",
  "entry": "...",
  "stage": 0,
  "intent_length": 123,
  "has_existing_doc": false,
  "context_signals": {},
  "route": "...",
  "decision_path": "...",
  "target_skill": "...",
  "fallback": null,
  "stage_skipped": false,
  "duration_ms": 1234
}
```

`decision_path` 枚举：`context_signal`、`intent_analysis`、`clarification`、`environment_detect`、`user_confirmation`。

---

## 7. 下游关键技能契约

### 7.1 format-extract（S2 html-imitate 的格式提取）

- 把 `.docx` 转为语义化 HTML + 图片。
- 入口 `run.py`；`artifact_id = <docx_stem>_<md5_8>`。
- **必须传 `--output-dir`**，否则 exit code 2。
- 输出：`reference_format.html`、`format_artifact.json`、`images/`。
- 成功时 stdout 最后一行是 HTML 绝对路径。
- 前置：Node ≥ 18。

### 7.2 design-token

- 已编译令牌 `tokens/compiled/`：`general.json`、`business-report.json`、`government-doc.json`、`academic-paper.json`、`marketing-doc.json` + `index.json`。
- 主题 `tokens/themes/`：`modern-minimal`、`formal-government`、`creative-marketing`、`business-modern`、`academic-paper`。
- 规则 `tokens/rules/`：`gb-t-9704-government`、`gb-t-7714-citation`、`gb-t-7713-academic`。
- 构建脚本：`scripts/build_tokens.py`。

### 7.3 doc-typeset

- 模板 `templates/`：`base`、`government-doc`、`academic-paper`、`legal-contract`、`stock-research`、`business-report`、`annual-report`、`meeting-minutes`。
- 排版 prompt `prompts/` 与模板一一对应。
- 复用组件 `components/`：`section-marker`、`divider`、`data-card`、`callout`。

### 7.4 html-review（质检门禁，每个文档只跑一次）

六大检查维度（`references/`）：typographic-quality、structural-integrity、security-check、genre-fit、design-token-compliance、decoration-usage；执行器 `scripts/review_html.py`。

### 7.5 html-to-docx（S3 转换引擎，Python）

- 托管 venv：默认 `$HOME/.venv-html-to-docx`。
- 幂等安装：`setup-html-to-docx.sh`（首次需外网）。
- CLI：

```bash
"$HTML_TO_DOCX_PY" -m html_to_docx convert input.html -o output.docx [OPTIONS]
```

- 参数：`--page-size`、`--orientation`、`--margin-top/bottom/left/right`。
- 输出 JSON：

```json
{"success": true, "docx_path": "...", "warnings": []}
```

- 支持：CSS 变量、顶层 `<section role>`、`@page` 页眉页脚、`data-component`、`data-docx-field` 书签。
- ConvertOptions 默认：A4、portrait、margin 上下 2.54cm / 左右 3.17cm。

### 7.6 brief-compose（P0 短篇直通）

- 触发：<1000 字短篇，绕过完整 pipeline。
- 工作流：确定输出路径 → 撰稿+生成 HTML → html-to-docx → present_files。
- 不传 `--request-id`，默认输出 `<workspace>/output/<文件名>.docx`。
- 字号建议：正文 12pt、h1 18–22pt、h2 14–16pt；禁止用 px。

---

# 第二部分：自动化调度（Cron）

## 8. 常量与文件（模块 22922）

```typescript
CRON_EXPIRY_MS      = 2592e5            // 3 天（递归任务自动过期）
SCHEDULER_TICK_MS   = 500               // 调度 tick 间隔
LOCK_RETRY_MS       = 5e3               // 抢占锁失败重试间隔
MAX_SCHEDULED_JOBS  = 50                // 单会话任务上限
DEFAULT_LOOP_INTERVAL = "10m"           // /loop 默认间隔
SCHEDULED_TASKS_FILE = "scheduled_tasks.json"
SCHEDULED_TASKS_LOCK = "scheduled_tasks.lock"
DEFAULT_JITTER_CONFIG = {
  recurringFrac: 0.1,        // 递归任务抖动：间隔的 10%
  recurringCapMs: 9e5,       // 抖动上限 15 分钟
  oneShotMaxMs: 9e4,         // 一次性任务抖动上限 90 秒
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30       // 分钟 % 30 == 0 才做前置抖动
}
```

三个 Symbol 服务：`CronSchedulerService`、`CronStateManagerService`、`CronStorageService`。

存储位置：`{projectHomeDir}/scheduled_tasks.json`（durable 任务持久化，跨重启存活）。

---

## 9. Cron 解析器（模块 93163）

字段范围定义：

```typescript
const FIELD_RANGES = [
  {min:0, max:59},   // minute
  {min:0, max:23},   // hour
  {min:1, max:31},   // dayOfMonth
  {min:1, max:12},   // month
  {min:0, max:6},    // dayOfWeek（0=周日，7 归一到 0）
];
```

导出的纯函数：

| 函数 | 说明 |
|---|---|
| `parseField(field, {min,max})` | `*` → 全值数组；`*/N` → 步进；`a-b/N` 区间步进；逗号列表；单值。非法返回 `null` |
| `parseCron(expr)` | 5 字段 → `{minute,hour,dayOfMonth,month,dayOfWeek}`（每字段为允许值数组），非法返回 `null` |
| `getNextFireTime(parsed, date)` | 从 `date` 下一分钟起逐分钟推进匹配，最多 527040 次（≈1 年） |
| `getNextFireTimestamp(cron, ts)` | `parseCron` + `getNextFireTime` → 时间戳 |
| `deterministicFraction(id)` | `parseInt(id.slice(0,8),16) / 0x100000000`（任务 id 前 8 hex → 稳定 [0,1) 分数，用于抖动） |
| `getRecurringFireTime(cron, ts, id, jitter)` | 下一触发 + 基于 id 的确定性抖动（recurringFrac/interval，cap recurringCapMs） |
| `getOneShotFireTime(cron, ts, id, jitter)` | 下一触发；若分钟 `% oneShotMinuteMod == 0` 则前置随机抖动 |
| `humanSchedule(cron)` | cron → 人类可读（"Every 5 minutes" / "Every day at 2:30 PM" / "Weekdays at ..." 等） |
| `isExpired(task, now)` | `task.recurring && !task.permanent && (now - createdAt) >= CRON_EXPIRY_MS` |
| `detectMissedTasks(tasks, now)` | 过滤 `getNextFireTimestamp(lastFiredAt ?? createdAt) < now` 的任务 |

### 9.1 getNextFireTime 匹配逻辑（还原核心）

```typescript
// em = dayOfMonth 是否全量（31），ef = dayOfWeek 是否全量（7）
// 日期匹配规则：
//   若 em && ef：任意日期都行
//   若 em（dayOfMonth 全量）：看 dayOfWeek
//   若 ef（dayOfWeek 全量）：看 dayOfMonth
//   否则：dayOfMonth 或 dayOfWeek 任一命中即可（cron 标准 OR 语义）
```

---

## 10. CronStateManager（模块 71529）+ CronStorage（模块 41559）

### 10.1 CronStateManager（内存态 + 会话隔离）

```typescript
class CronStateManager {           // @Component(CronStateManagerService)
  scheduledTasksEnabled = false;
  sessionCronTasksMap = new Map(); // sessionId -> Task[]
  storageDir: string;

  setEnabled(v) / isScheduledTasksEnabled()
  setStorageDir(dir) / getStorageDir()

  getSessionTasks(sessionId)              // 该会话内存任务
  addSessionTask(sessionId, task)
  removeSessionTasks(sessionId, ids)      // 返回移除数
  clearSessionTasks(sessionId)

  async createTask(sessionId, cron, prompt, recurring, durable) {
    const id = randomUUID().slice(0, 8);          // ★ 8 位 hex
    const task = {
      id, cron, prompt, createdAt: Date.now(),
      ...(recurring ? {recurring: true} : {}),
      ...(durable   ? {durable: true}   : {}),
    };
    if (durable) {                                // 持久化到 scheduled_tasks.json
      const tasks = await CronStorage.readTasks(this.storageDir);
      tasks.push(task);
      await CronStorage.writeTasks(tasks, this.storageDir);
    } else {
      this.addSessionTask(sessionId, task);       // 仅内存，会话结束即失效
    }
    this.setEnabled(true);
    return id;
  }

  async getAllTasks(sessionId) {
    const mem = this.getSessionTasks(sessionId);
    if (!this.storageDir) return mem;
    const durable = (await CronStorage.readTasks(this.storageDir))
      .map(t => ({...t, permanent: true}));       // 跨会话任务标记 permanent
    return [...mem, ...durable];
  }

  async removeTasks(sessionId, ids) {
    let n = this.removeSessionTasks(sessionId, ids);
    if (this.storageDir) await CronStorage.removeTasks(ids, this.storageDir);
    return n;
  }
}
```

### 10.2 CronStorage（文件持久化，纯静态方法）

```typescript
class CronStorage {
  static async readTasks(dir) {
    // 读 scheduled_tasks.json；解析 .tasks 数组
    // 过滤：必须同时有 id && cron && prompt && createdAt && parseCron(cron) 有效
    // 异常 → 返回 []
  }

  static async writeTasks(tasks, dir) {
    // mkdir(dir, {recursive:true})
    // 写入时剔除 durable / permanent 字段（运行时元数据不落盘）
    // JSON.stringify({tasks}, null, 2) + "\n"
  }

  static async removeTasks(ids, dir) { /* 过滤掉匹配 id 的项，数量变化才写回 */ }

  static async updateTaskLastFiredAt(ids, ts, dir) { /* 命中则设 lastFiredAt 并写回 */ }

  static async acquireLock(dir, lockIdentity) {
    // writeFile(lock, JSON.stringify({...identity, acquiredAt}), {flag:"wx"})  // 排他创建
    // 失败（已存在）：
    //   - 读锁，若 sessionId 相同 → 返回 true（同会话重入）
    //   - process.kill(lock.pid, 0) 成功 → 对方还活着 → 返回 false
    //   - kill 抛错（进程已死）→ unlink 锁 → 重试 wx 创建 → true/false
  }

  static async releaseLock(dir, lockIdentity) { /* sessionId 匹配才 unlink */ }

  static watchTasksFile(dir, onChange) {
    // fs.watch(scheduled_tasks.json, {persistent:false}) + 200ms debounce
    // 返回 { close() }；异常返回 { close(){} }
  }
}
```

---

## 11. createCronScheduler（调度核心工厂）

输入解构：`{sessionId, onFire, isLoading, onFireTask, onMissed, dir, lockIdentity, getJitterConfig, isKilled}`。

内部状态：`durableTasks`（缓存）、`nextFireTimes`（Map）、`firedIds`（Set，防重复 fire 一次性任务）、`removedIds`（Set）、`deletedThisTick`（数组）、`schedulerTimer`、`lockTimer`、`fileWatcher`、`stopping`、`hasLock`。

### 11.1 checkMissedTasks(isStartup)

```typescript
async function checkMissedTasks(isStartup) {
  const tasks = await CronStorage.readTasks(dir);
  if (!isStartup && !hasLoaded) { durableTasks = tasks; return; } // 非启动只刷新缓存
  durableTasks = tasks;
  const missed = detectMissedTasks(tasks, Date.now())
    .filter(t => !t.recurring && !firedIds.has(t.id));   // 只补一次性任务
  if (missed.length) {
    for (const t of missed) { firedIds.add(t.id); nextFireTimes.set(t.id, Infinity); }
    onMissed ? onMissed(missed) : onFire(buildMissedNotification(missed));
    CronStorage.removeTasks(missed.map(t => t.id), dir);
  }
}
```

### 11.2 tick（每 500ms）

```typescript
function tick() {
  if (isKilled?.() || isLoading()) return;
  const now = Date.now();
  const jitter = getJitterConfig?.() ?? DEFAULT_JITTER_CONFIG;
  const tasks = [...stateManager.getSessionTasks(sessionId), ...durableTasks];
  const fired = []; const lastFired = [];

  for (const t of tasks) {
    if (removedIds.has(t.id)) continue;
    let next = nextFireTimes.get(t.id);
    if (next === undefined) {
      next = t.recurring
        ? getRecurringFireTime(t.cron, t.lastFiredAt ?? t.createdAt, t.id, jitter)
        : getOneShotFireTime(t.cron, t.createdAt, t.id, jitter);
      if (next === null) continue;
      nextFireTimes.set(t.id, next);
    }
    if (next !== undefined && now >= next) {
      onFireTask ? onFireTask(t) : onFire(t.prompt);   // 触发
      if (t.recurring && !isExpired(t, now)) {
        const n2 = getRecurringFireTime(t.cron, now, t.id, jitter);
        n2 !== null ? nextFireTimes.set(t.id, n2) : nextFireTimes.delete(t.id);
        (t.permanent || t.durable) && lastFired.push(t.id);  // 记录 lastFiredAt
      } else {
        // 一次性任务：删；递归已过期：删除并记日志
        removedIds.add(t.id);
        stateManager.removeSessionTasks(sessionId, [t.id]);
        nextFireTimes.delete(t.id);
        fired.push(t.id);
      }
    }
  }
  // 异步落盘：删除 fired，更新 lastFired
  (async () => {
    try {
      fired.length && await CronStorage.removeTasks(fired, dir);
      lastFired.length && await CronStorage.updateTaskLastFiredAt(lastFired, now, dir);
    } finally {
      fired.forEach(id => removedIds.delete(id));
    }
  })();
}
```

### 11.3 initialize（锁 + 启动补漏 + 文件监听）

```typescript
async function initialize() {
  const ok = await CronStorage.acquireLock(dir, lockIdentity);
  if (ok) {
    hasLock = true;
    await checkMissedTasks(true);
    fileWatcher = CronStorage.watchTasksFile(dir, () => checkMissedTasks(false));
  } else {
    // 锁被别的会话持有 → 每 LOCK_RETRY_MS 重试，成功后同样补漏+监听
    lockTimer = setInterval(async () => { /* acquireLock 成功 → 初始化 */ }, LOCK_RETRY_MS);
  }
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
}
```

返回接口：`{ start(), stop(), getNextFireTime() }`。`getNextFireTime()` 遍历 `nextFireTimes` 取最小非 Infinity 值。

---

## 12. CronSchedulerService（会话生命周期，Symbol 服务）

```typescript
class CronSchedulerService {        // @Component(CronSchedulerService)
  schedulers = new Map();           // sessionId -> scheduler

  start(session) {
    if (process.env[ENV_KEY_CODEBUDDY_DISABLE_CRON] === "1") return;
    if (this.schedulers.has(session.id)) return;   // 已运行
    this.stateManager.setStorageDir(PathUtils.getProjectHomeDir());

    const scheduler = createCronScheduler({
      sessionId: session.id,
      onFire: (task) => {
        // 注入一条 isMeta:true 且 startsNewUserRequest:true 的 user item
        const msg = user(task, {isMeta: true, startsNewUserRequest: true});
        messageQueue.enqueueMessage(session, msg);
        // 若主 agent 未在运行 → drain：跑一次默认 agent
        if (!isMainAgentRunning(session)) {
          AgentService.run(await AgentManager.getDefault(), [], {context: session});
        }
      },
      isLoading: () => {
        const st = stateMachine.getSnapshot(session).status;
        return st === AGENT_RUNNING || st === MODEL_REQUESTING
            || st === MODEL_STREAMING || st === MODEL_DONE;
      },
      dir: PathUtils.getProjectHomeDir(),
      lockIdentity: {sessionId: session.id, pid: process.pid},
      isKilled: () => session.abortSignal.aborted,
    }, this.stateManager);

    this.schedulers.set(session.id, scheduler);
    scheduler.start();
  }

  stop(session) { /* scheduler.stop() + delete + clearSessionTasks */ }
  getNextFireTime(session) { return this.schedulers.get(session)?.getNextFireTime() ?? null; }
}
```

关键语义：
- **onFire 触发的是"伪用户消息"**（`isMeta:true, startsNewUserRequest:true`），进入消息队列而非直接执行。
- **drain 语义**：若触发时主 agent 空闲，则主动跑一次默认 agent 消化该 prompt（`isLoading` 返回 true 时跳过）。
- 锁按 `sessionId` 隔离，同一会话重入成功；不同会话通过 `pid` 存活检测抢占。

---

## 13. Cron 工具 + /loop 命令

### 13.1 工具 schema（模块 22922）

```typescript
CronCreateFullSchema = z.strictObject({
  cron:     z.string(),    // 5 字段 cron，本地时区 "M H DoM Mon DoW"
  prompt:   z.string(),    // 每次触发入队的 prompt
  recurring: z.boolean().optional(),  // true(默认)=每次匹配都触发，直到删除或 3 天过期
                                      // false=下次匹配触发一次后自动删除（"提醒我 X" 一次性）
  durable:  z.boolean().optional(),   // true=持久化到 scheduled_tasks.json 跨重启；默认 false=仅内存
});
CronCreateModelSchema = CronCreateFullSchema.omit({durable: true});
CronDeleteSchema = z.strictObject({ id: z.string() });
CronListSchema   = z.strictObject({});
```

对应工具 `CronCreateTool` / `CronDeleteTool` / `CronListTool`（模块 hH），分别封装 `CronStateManager.createTask / removeTasks / getAllTasks`，并在 create 时校验 `MAX_SCHEDULED_JOBS = 50`。安全策略中 `CronCreate/CronDelete/CronList` 属于 **CodeBuddy Scheduling 白名单**（不触发"自我修改"类拦截）。

### 13.2 /loop 命令（LoopSkillProductProvider）

- 优先级 `ProductProviderPriority.WORKSPACE - 1`；name `"loop"`；`userInvocable: true`。
- 标记前缀 `LOOP_JOB_MARKER_PREFIX = "[/loop:"`。
- 用法：`/loop [interval] <prompt>`；间隔 `Ns/Nm/Nh/Nd`，最小粒度 1 分钟，默认 10m。

**解析优先级**（还原）：

1. **前导 token**：首个空白分隔 token 匹配 `^\d+[smhd]$`（如 `5m`、`2h`）→ 是间隔，其余为 prompt。
2. **尾部 "every" 子句**：否则若输入以 `every <N><unit>` 或 `every <N> <unit-word>` 结尾 → 提取间隔并剥离。仅当 `every` 后跟时间表达式才匹配（`check every PR` 无间隔）。
3. **默认**：间隔 `10m`，整段输入为 prompt。

**间隔 → cron 转换表**：

| 间隔 | cron | 说明 |
|---|---|---|
| `Nm`（N≤59） | `*/N * * * *` | 每 N 分钟 |
| `Nm`（N≥60） | `0 */H * * *` | 取整到小时（H=N/60，须整除 24） |
| `Nh`（N≤23） | `0 */N * * *` | 每 N 小时 |
| `Nd` | `0 0 */N * *` | 每 N 天本地午夜 |
| `Ns` | 按 `ceil(N/60)m` | cron 最小粒度 1 分钟 |

无法整除时（如 `7m`、`90m`）取最近的干净间隔并告知用户取整结果。

**自调整协议（还原核心）**：

- 生成 `<LOOP_ID>`（6–8 位随机小写字母数字，**不调工具**，内联发明），记录 `<STARTED_DATE>`。
- 将 prompt 包裹为：

```
[/loop:<LOOP_ID>] <PROMPT>

---
[/loop self-adjustment] This prompt is fired by a /loop job (marker `[/loop:<LOOP_ID>]`, started <STARTED_DATE>). ...
```

- 标记必须放在最前面，以在 CronList 的截断预览中存活。
- 首次 `CronCreate` 用 `recurring: true`。
- 每次触发后：要么"继续循环"（CronDelete 旧任务 + CronCreate `recurring:false` 的新一次性任务，自调度下一轮），要么"停止循环"（CronDelete 且不再创建）。
- **安全上限**：距 `<STARTED_DATE>` 超过 3 天则停止（镜像内置递归过期，但一次性任务不会自动过期，需显式自约束）。

---

## 附：关键还原偏移量索引

### codebuddy.js（22955544 chars）

| 偏移 | 内容 |
|---|---|
| @8057691–@8059912 | 模块 22922：Cron 常量 + Schema + Symbol 服务 |
| @8053631–@8057561 | 模块 93163：cron 解析器（parseField/parseCron/getNextFireTime/getRecurringFireTime/getOneShotFireTime/humanSchedule/isExpired/detectMissedTasks） |
| @8059235–@8061418 | 模块 71529：CronStateManager |
| @8060747–@8061500 | 模块 41559：CronStorage（read/write/remove/updateLastFiredAt/acquireLock/releaseLock/watchTasksFile） |
| @8796967 | createCronScheduler（checkMissedTasks / tick / initialize） |
| 相邻 @8796967 | CronSchedulerService（start/stop/getNextFireTime/onFire drain） |
| @8805600–@8809879 | /loop 提示词模板（uN 用法 + uL 解析/转换/自调整协议） |
| @8484623 / @8489555 / @8511139 / @8522454 | CronCreateTool/CronListTool 等工具注册导出映射 |

### tencent-docx 插件（源码，非 bundle）

插件根：`app-extracted/resources/plugins/workbuddy-builtin/builtin-plugins/tencent-docx/`

| 文件 | 内容 |
|---|---|
| `.codebuddy-plugin/plugin.json` | 插件声明（hooks/skills/agents） |
| `SKILL.md` + `hooks/hooks.json` | 插件入口规则 + SessionStart 预热 |
| `skills/tdoc-orchestrator/SKILL.md` | Stage 0 编排中枢 |
| `skills/tdoc-orchestrator/references/pipeline-state-protocol.md` | YAML 溯源 schema |
| `skills/tdoc-orchestrator/references/log-schema.md` | JSONL 日志 schema |
| `agents/doc-writer.md` | S1（expert 路由 + critic 分档 + Markdown 门禁） |
| `agents/doc-formatter.md` | S2（html-template / html-imitate 路由 + genre 推断 + 降级） |
| `agents/doc-converter.md` | S3（html-to-docx + present_files 强约束） |
| `skills/format-extract/SKILL.md` | docx→HTML 格式提取 |
| `skills/html-to-docx/SKILL.md` | Python 转换引擎契约 |
| `skills/brief-compose/SKILL.md` | P0 短篇直通 |
| `skills/design-token/` + `skills/doc-typeset/` + `skills/html-review/` | S2 三下游技能 |
| `experts/*`（9 个）+ `core/engines/{deep-research,critic-generator}` | S1 专家与引擎 |

---

## Web 应用复刻要点

| 原生实现 | Web 复刻建议 |
|---|---|
| `scheduled_tasks.json` + `scheduled_tasks.lock`（flag `wx` + pid 存活检测） | 单机保留原方案即可；多实例改为 DB 行锁（`FOR UPDATE`）+ 心跳租约（TTL），锁语义等价 |
| 500ms tick 遍历内存任务 | 后端定时器轮询 DB 中"到期任务"；或改用 Redis `ZSET` 按 next_fire 排序 + 延迟队列 |
| 会话级调度器（`schedulers Map<sessionId>`） | 按 `(tenant, session)` 分片；调度器生命周期绑定会话 |
| `onFire` 注入 `isMeta` 伪用户消息入队 | 复用第 1 批的 item 协议，`startsNewUserRequest:true` 触发新 user 请求 |
| `getOneShotFireTime`/`getRecurringFireTime` 确定性抖动（id→[0,1)） | 抖动用 `hash(task_id)` 而非随机，保证可复现、多实例不重复触发 |
| tencent-docx 三段流水线（md→html→docx） | 拆成三个可独立调用的 Job；中间产物存对象存储；`pipeline-state.yaml`/`pipeline.log` 直接映射为 `pipelines` 表 + 事件日志表 |
| `format-extract`/`html-to-docx` 本地脚本 | 打包为独立 worker/函数；venv 依赖用容器镜像固化，去掉"首次需外网" |
| `present_files` 强制预览 | Web 侧映射为"生成产物下载/预览入口"，作为 S3 完成的前置条件 |

**必须保留的语义**：
1. 三阶段合法链（S1→S2→S3，S1 必经 S2，链必终于 S3）+ 只有最终 docx 才对外可见。
2. `pipeline-state.yaml` 是审计记录不是锁；`pipeline.log` 每条带 `decision_path` 与 `duration_ms`。
3. Cron 的 `recurring:false` 一次性任务"触发即删"、`recurring:true` 3 天过期、durable 跨重启三态并存。
4. 锁的 `sessionId` 重入 + `pid` 存活检测抢占（单机语义）。
5. `/loop` 的"标记前缀 + 自调整块 + 3 天安全上限"三段式自调度协议。
