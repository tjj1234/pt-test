# 第三批实现设计：模型调度 + 记忆架构 + 技能系统

> 逆向来源：WorkBuddy CLI 内核 `codebuddy.js`（22MB webpack bundle）+ 本机 `~/.codebuddy` 运行时数据。
> 覆盖模块：模型调度（variant/fallback/configure）/ 记忆架构（规则文件 + Agent 持久记忆 + 相关记忆 + 记忆提取）/ 技能系统（目录发现 + SKILL.md 解析 + skill_manage 工具）。
> 粒度：可直接照着写代码。所有常量、枚举、文件格式、prompt 模板均从产物还原。

---

## 0. 总览：三条纵向管线

```
┌─ 管线 A：模型调度 ─────────────────────────────────────┐
│  请求模型字符串（"auto"/"lite"/"reasoning"/自定义 id）  │
│    → resolveModel() 归一化为具体 model id              │
│    → computeRelatedModel() 解析变体 fallback 链        │
│    → configureModelConfig() 落到 agent 上的 model/     │
│      maxTokens/temperature/handoffs                    │
├─ 管线 B：记忆架构 ─────────────────────────────────────┤
│  ① 规则文件（CODEBUDDY.md/.mdc + AGENTS.md/.mdc）      │
│     加载→解析→验证→缓存→条件规则→注入 prompt           │
│  ② Agent 持久记忆（MEMORY.md + snapshots 快照同步）    │
│  ③ 相关记忆（扫描→AI 选择） + 记忆提取（后台子 agent）  │
├─ 管线 C：技能系统 ─────────────────────────────────────┤
│  目录发现（project/user/connector/session/bundled）    │
│    → scanSkillsDirectory 扫描 SKILL.md                 │
│    → parseSkillFile 解析 frontmatter + product meta    │
│    → 注册进工具目录 + skill_manage 增删改查            │
└────────────────────────────────────────────────────────┘
```

关键设计决策（复刻时保留）：

1. **模型请求用"变体名"而非具体 id**：上层说"要一个 lite 模型"，`computeRelatedModel` 把变体翻译成具体 model id，并带一整条 fallback 链兜底。
2. **记忆的单一事实源是文件系统**：规则文件按 `CODEBUDDY.md → .mdc → AGENTS.md` 优先级逐级向上收集祖先目录，Parser/Validator/Cache 都是围绕"文件"的纯变换。
3. **记忆写入是 append-only + 去重**：`MemoryManagerImpl.addFact` 先去重再插入到 `##` 分节里，绝不破坏已有内容。
4. **技能以 SKILL.md 为中心**：一个技能 = 一个目录 + 一份 `SKILL.md`（YAML frontmatter + Markdown body），元数据优先 frontmatter，缺失时回退到 `_*_meta.json`。

---

# 第一部分：模型调度

## 1. 常量与类型（@模块 variants，完整还原）

```typescript
const MODEL_ID_AUTO            = "auto";              // 让系统自动选择主模型
const MODEL_TAG_CUSTOM         = "custom";            // 自定义模型的 tag
const MODEL_TAG_LITE           = "lite";              // lite 模型的 tag
const CUSTOM_MODEL_ID_PREFIX   = "custom:";           // 自定义模型 id 前缀
const CUSTOM_LOCAL_MODEL_PREFIX = "custom-local:";    // 本地自定义模型 id 前缀

// 合法的 reasoning 强度枚举
const VALID_REASONING_EFFORTS = ["minimal","low","medium","high","xhigh","max"];

// 模型可信度分级
const ModelTrustLevel = {
  UNVERIFIED: "unverified",   // 未验证
  CUSTOM:     "custom",       // 用户自定义
  CERTIFIED:  "certified",    // 官方认证
};

// ★ 变体类型集合：这些字符串会被识别为"模型变体"而非具体 id
const MODEL_VARIANT_TYPES = new Set([
  "lite",          // 轻量模型
  "builtin-lite",  // 内置轻量模型
  "reasoning",     // 推理模型
  "vision",        // 视觉模型
  "longContext",   // 长上下文模型
  "subagent",      // 子 agent 用模型
]);
```

复刻要点：`MODEL_VARIANT_TYPES` 是调度器的核心分叉点。输入字符串先判断"是变体类型吗？"——是则走"主模型 + 关联模型"路径，否则按 id/name 直接查模型注册表。

## 2. resolveModel（归一化入口）

### 2.1 主模型解析（@6992439）

```typescript
async function resolveModel(modelRequest: string): Promise<Model> {
  // ① 等待模型目录就绪（readyDeferred / modelsReadyDeferred）
  await waitForModelsReady();

  // ② 变体类型 → 解析会话主模型 + 关联模型
  if (isModelVariantType(modelRequest)) {
    const primaryId = await resolveSessionPrimaryModel();          // 见 2.2
    return getRelatedModel(primaryId, modelRequest);               // 见 3
  }

  // ③ 非变体 → 直接按 id 或 name 查模型注册表
  return findModelByIdOrName(modelRequest);
}
```

`isModelVariantType(s)` = `MODEL_VARIANT_TYPES.has(s)`。
`findModelByIdOrName(s)`：先按 id 精确匹配，未命中再按 name（displayName）匹配。

### 2.2 resolveSessionPrimaryModel

```typescript
async function resolveSessionPrimaryModel(): Promise<string> {
  // session.requestOptions.model 优先，其次 session.options.model
  const requested = session?.requestOptions?.model || session?.options?.model;

  // 非变体 → 查模型注册表；查不到就返回 { id, name } 字面量
  if (!isModelVariantType(requested)) {
    return findModelByIdOrName(requested) ?? { id: requested, name: requested };
  }

  // 变体 → 取默认主模型
  return getPrimaryModel();
}
```

复刻要点：会话的"主模型"是后续所有变体解析的锚点。`lite`/`reasoning` 等变体最终都相对这个主模型去解析关联关系。

### 2.3 图像 / 视频模型专用解析

图像模型（@12752507）和视频模型（@12764821）各自有独立的解析函数，但 fallback 链结构一致：

```
textToImageModel / imageToImageModel：
  session options → env 变量 → settings 配置 → 按 tag 查询 → 默认模型
  默认值：hunyuan-image-v3.0（文生图） / hunyuan-image-v2.0-general-edit（图生图）

textToVideoModel / imageToVideoModel：
  同样 fallback 链，默认指向视频生成模型
```

复刻要点：图像/视频模型不走 `MODEL_VARIANT_TYPES` 分叉，而是独立的"配置项 → 环境变量 → settings → 默认"优先级链，因为它们和文本对话模型不在同一个注册表语义里。

## 3. computeRelatedModel（变体 fallback 链，@6989474 完整还原）

这是整个调度器最核心的函数——把"变体名"翻译成"具体 model id"，并带一整条从近到远的 fallback。

```typescript
async function computeRelatedModel(primaryId: string, variant: string): Promise<Model> {
  // ① builtin-lite → 环境变量指定 → settings.variantModels → 模型自身声明 → 默认关联 → 主模型
  if (variant === "builtin-lite") {
    return envModel("builtin-lite")
        ?? settingsVariantModel("builtin-lite")
        ?? modelSpecificRelated(primaryId, "builtin-lite")
        ?? defaultRelatedModel("builtin-lite")
        ?? primaryModel(primaryId);
  }

  // ② lite → env → settings → model-specific → 默认关联 → 主模型
  if (variant === "lite") {
    return envModel("lite")
        ?? settingsVariantModel("lite")
        ?? modelSpecificRelated(primaryId, "lite")
        ?? defaultRelatedModel("lite")
        ?? primaryModel(primaryId);
  }

  // ③ 自定义/外部模型跳过默认关联链（避免把官方默认强加到用户模型上）
  const isCustomOrExternal = isCustomModel(primaryId) || isExternalModel(primaryId);

  // ④ 通用变体（reasoning/vision/longContext/subagent）
  //    fallback 顺序：env → settings → model-specific → （非 custom/external 才走）默认关联 → 主模型
  return envModel(variant)
      ?? settingsVariantModel(variant)
      ?? modelSpecificRelated(primaryId, variant)
      ?? (isCustomOrExternal ? undefined : defaultRelatedModel(variant))
      ?? primaryModel(primaryId);
}
```

**fallback 优先级总结（从近到远）**：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | env 变量 | 环境变量直接指定变体模型 |
| 2 | settings.variantModels | 用户配置里的变体模型映射 |
| 3 | model-specific | 主模型自身声明的关联模型（如某模型自带 reasoning 搭档） |
| 4 | defaultRelatedModels | 产品默认关联表（custom/external 跳过） |
| 5 | 主模型本身 | 最终兜底：用主模型顶替变体 |

复刻要点：**第 4 层对 custom/external 模型是跳过的**——用户自定义模型不应该被强制套上官方默认的关联模型，这是防止"配了自定义模型却莫名带上官方副模型"的关键分支。

## 4. resolveDefaultRelatedModel

```typescript
function resolveDefaultRelatedModel(variant: string): Model | undefined {
  // 读产品 manager 配置 defaultRelatedModels[variant]
  const configured = productManager.config.defaultRelatedModels?.[variant];
  if (!configured) return undefined;

  // 在 modelMap 中找到且未 disabled（或 requireEnabled=false）→ 返回
  const found = findInModelMap(configured);
  if (found && (!found.disabled || !requireEnabled)) return found;

  // 否则 warn 回退
  warn(`default related model for ${variant} not found or disabled`);
  return undefined;
}
```

## 5. configureModelConfig（落到 agent 上，@7077676 完整还原）

`resolveModel` 只是找到"哪个模型"，`configureModelConfig` 把模型的实际运行参数写进 agent 对象。

```typescript
async function configureModelConfig(agent: Agent) {
  // ① 决定模型：优先 requestOptions，其次 CLI options，再回退 requestOptions
  let ec = requestOptions?.model
    ? await getModelByRequestOptions(agent, session)
    : await getModelByCliOptions(agent, session);
  ec || (ec = await getModelByRequestOptions(agent, session));

  // ② 写入 model id
  agent.model = ec.id;
  agent.modelSettings ||= {};

  // ③ maxTokens：custom 模型无显式值时 omit
  let eu = ec.tags?.includes(MODEL_TAG_CUSTOM) === true;
  let ed = ModelUtils.getMaxOutputTokens(ec.id, ec.maxOutputTokens, { useCatalogFallback: !eu });
  if (ed) {
    agent.modelSettings.maxTokens = ed;
  } else {
    delete agent.modelSettings.maxTokens;   // custom 无显式值 → 不设置
  }

  // ④ temperature：显式值优先，custom 无显式则 delete，否则 DEFAULT_TEMPERATURE
  if (ec.temperature != null) {
    agent.modelSettings.temperature = ec.temperature;
  } else if (eu) {
    delete agent.modelSettings.temperature;
  } else {
    agent.modelSettings.temperature = DEFAULT_TEMPERATURE;   // = 1
  }

  // ⑤ 递归处理 handoffs（子 agent 也各自配置）
  for (const h of (agent.handoffs ?? [])) {
    const target = h.agent ?? h.handoff?.agent;
    if (target) await configureModelConfig(target);
  }

  // ⑥ 推理强度配置（thinking settings）
  await configureThinkingSettings(agent, ec);
}
```

复刻要点：`maxTokens`/`temperature` 对 custom 模型的"无显式值就删除"语义，是为了让自定义模型使用服务端默认值，而不是被 CLI 的 `DEFAULT_TEMPERATURE` 污染。

---

# 第二部分：记忆架构

## 6. 规则文件常量（模块 9162，完整还原）

```typescript
// 规则文件名候选（优先级从高到低）
const MEMORY_FILENAME         = `${PRODUCT_UPPERCASE_NAME}.md`;        // CODEBUDDY.md
const MEMORY_FILENAME_MDC     = `${PRODUCT_UPPERCASE_NAME}.mdc`;       // CODEBUDDY.mdc
const MEMORY_FILENAME_LOCAL   = `${PRODUCT_UPPERCASE_NAME}.local.md`;  // CODEBUDDY.local.md
const MEMORY_FILENAME_LOCAL_MDC = `${PRODUCT_UPPERCASE_NAME}.local.mdc`;
const AGENTS_FILENAME         = "AGENTS.md";
const AGENTS_FILENAME_MDC     = "AGENTS.mdc";

// 记忆作用域
const MemoryScope = {
  MANAGED:       "managed",        // 托管规则（由 agent 写）
  USER:          "user",           // 用户级
  PROJECT:       "project",        // 项目级
  PROJECT_LOCAL: "project-local",  // 项目本地（不进版本控制）
};

// 记忆类型
const MemoryType = {
  ALWAYS: "always",   // 始终注入
  MANUAL: "manual",   // 仅在触发器命中时注入
};

// 单个记忆文件大小上限（字节）
const MAX_MEMORY_FILE_SIZE = 40000;
```

复刻要点：`PRODUCT_UPPERCASE_NAME` 是模板变量——WorkBuddy 用 `CODEBUDDY`，复刻时可换成自己的产品名（如 `WORKBUDDY`）。`.mdc` 和 `.md` 是同义候选，前者是带 frontmatter 的 Markdown 变体。

## 7. 记忆 prompt 模板（模块 60709，完整原文字符串）

这是注入到系统提示里的"记忆使用说明"，完整原文（复刻时可直接作为字符串常量）：

```
## Memory

Use the memory system to remember facts about the user and the project that
help you provide better assistance over time. There are four categories of
memory:

- **User memories** — preferences, goals, and constraints the user tells you
  about, either directly or that you observe.
- **Feedback memories** — corrections or preferences the user expresses about
  your work.
- **Project memories** — project-specific conventions, architecture decisions,
  and constraints.
- **Reference memories** — facts you looked up and want to retain.

Save to memory when:
- The user explicitly asks you to remember something.
- You learn a stable, reusable fact about the user or project.
- You receive feedback you should apply in the future.

How to use memory:
- Prefer the dedicated memory tools to store facts.
- Keep entries concise and self-contained.

WHAT_NOT_TO_SAVE:
- Ephemeral or one-off details.
- Anything that would be invalid or confusing later.

MEMORY_DRIFT_CAVEAT:
- Memories can become stale. Verify memory against current facts before acting
  on it, especially for anything that affects safety or permissions.

WHEN_TO_ACCESS:
- Access relevant memories at the start of a task and when the context changes.

TRUSTING_RECALL:
- Prefer current context over memory when they conflict.

FRONTMATTER_EXAMPLE:
- Memories may carry frontmatter fields such as agent_created to mark origin.
```

复刻要点：这是给 LLM 的"记忆使用说明书"，直接决定模型什么时候写、什么时候读、怎么处理过期记忆。复刻时保留四类记忆语义（user/feedback/project/reference）和 `MEMORY_DRIFT_CAVEAT`（stale 验证）是行为对齐的关键。

## 8. 核心实现（模块 14064）

### 8.1 MemoryManagerImpl.addFact（写入去重 + 分节插入）

```typescript
async addFact(fact: string): Promise<void> {
  // ① 去掉开头的 "- " / "---" 等列表前缀，统一为纯内容
  let normalized = fact.trim().replace(/^(-+\s*)+/, "");

  // ② 加回单个 "- " 前缀（记忆条目是 markdown 列表项）
  const line = `- ${normalized}`;

  // ③ 读文件，若已包含该条目（ep.includes(line)）则跳过（去重）
  const existing = await readFile();
  if (existing.includes(line)) return;

  // ④ 插入到记忆分节（见 8.2）
  await insertIntoMemorySection(line);
}
```

### 8.2 insertIntoMemorySection（分节定位）

```typescript
async function insertIntoMemorySection(fact: string): Promise<void> {
  const header = MEMORY_SECTION_HEADER;   // 形如 "## Memory"

  if (content.includes(header)) {
    // 有 header：插到 header 之后、下一个 "\n## " 之前
    const idx = content.indexOf(header) + header.length;
    const nextSection = content.indexOf("\n## ", idx);
    const insertAt = nextSection === -1 ? content.length : nextSection;
    content = content.slice(0, insertAt) + "\n" + fact + content.slice(insertAt);
  } else {
    // 无 header：先补换行分隔，再追加 header + fact
    content = ensureNewlineSeparation(content) + header + "\n" + fact;
  }
  await writeFile(content);
}
```

复刻要点：记忆文件被组织为多个 `## Section`，`addFact` 只往 "Memory" 节里追加，绝不动其他节。去重用"整行 includes"判断，简单但能避免重复写入同一条。

### 8.3 MemoryLoaderImpl（项目记忆加载）

```typescript
async loadProjectMemories(): Promise<Memory[]> {
  // ① 从 workDir 逐级向上收集所有祖先目录
  const dirs = collectAncestorDirs(workDir);   // [workDir, parent, ..., root]

  // ② 从根往下遍历（保证父目录规则先于子目录加载）
  for (const dir of dirs.reverse()) {
    await loadProjectMainFiles(dir);
  }
}

async loadProjectMainFiles(dir): Promise<void> {
  // ① 先试目录根：CODEBUDDY.md → CODEBUDDY.mdc → AGENTS.md → AGENTS.mdc
  for (const name of [MEMORY_FILENAME, MEMORY_FILENAME_MDC, AGENTS_FILENAME, AGENTS_FILENAME_MDC]) {
    if (await loadFile(join(dir, name), scope)) break;   // 第一个成功即 break
  }
  // ② 再试 <dir>/.codebuddy/ 下同名文件
  for (const name of [...]) {
    if (await loadFile(join(dir, ".codebuddy", name), scope)) break;
  }
}
```

### 8.4 loadFile（返回 boolean：是否加载成功）

```typescript
async function loadFile(path, scope): Promise<boolean> {
  // ① realpath 归一化 → 去重（loadedMemories.has 跳过已加载）
  // ② canLoad 检查：循环导入检测 + MAX_IMPORT_DEPTH 限制
  // ③ parse → validate（imported 文件不强制 enabled/alwaysApply）
  // ④ loadedMemories.set 标记已加载
  // ⑤ loadImports 递归加载 import 指向的文件
  return true;   // 或 false（不存在/不可加载）
}
```

复刻要点：**父目录优先加载**（`dirs.reverse()` 从根往下），这样子目录规则可以"继承 + 覆盖"父目录规则。`loadFile` 返回 boolean，让调用方能"第一个成功即 break"。

### 8.5 SubdirectoryMemoryLoader.resolveGlobs（子目录规则匹配）

```typescript
function resolveGlobs(globs: string[], relativeDir: string): string[] {
  if (!globs || globs.length === 0) {
    return [`${relativeDir}/**`];              // 无 globs 默认匹配该子目录下所有文件
  }
  return globs.map(g => {
    if (isAbsolute(g)) return g;               // 绝对路径原样
    if (g.startsWith("!")) return g;           // 排除前缀保留
    return join(relativeDir, g);               // 相对路径加目录前缀
  });
}
```

### 8.6 ConditionalRulesServiceImpl.consume（条件规则消费）

```typescript
async consume(): Promise<string> {
  // ① pendingTriggers 为空 → 直接返回空（无触发）
  if (this.pendingTriggers.length === 0) return "";

  // ② 取出 triggers → findMatchingRules（MANUAL 全局 + 子目录规则，排除 processedRules）
  const triggers = this.pendingTriggers.splice(0);
  const rules = await this.findMatchingRules(triggers);

  // ③ buildInjectionContent 包装为标准结构
  return buildInjectionContent(rules);   // 见下
}

// 输出结构：
// <system-reminder>
//   <rules>
//     <conditional_workspace_rules>
//       ...匹配到的规则内容...
//     </conditional_workspace_rules>
//   </rules>
// </system-reminder>
```

复刻要点：条件规则（`MemoryType.MANUAL`）平时不注入，只有 `pendingTriggers` 被触发时才消费并注入。`consume` 一次性清空触发器，避免同一条规则被反复注入。

### 8.7 MemoryController（HTTP 路由）

```typescript
GET  /memory/profile     // 读记忆画像
PUT  /memory/profile     // 写记忆画像
POST /memory/suggestion  // 记忆建议
POST /memory/import      // 导入记忆（content < 20 字符 → 400）
GET  /memory/status      // 返回 { isUpdating: false }
```

复刻要点：`memory/import` 对 content 长度有硬校验（≥ 20 字符），低于阈值直接 400，防止把噪声导进长期记忆。

## 9. Agent 持久记忆（模块 67853）

这是"agent 自己记住东西"的机制，和 `CODEBUDDY.md` 规则文件是两套系统。

### 9.1 文件与常量

```typescript
const MEMORY_MD             = "MEMORY.md";               // agent 持久记忆入口
const SNAPSHOTS_DIR         = "agent-memory-snapshots";  // 快照目录
const SNAPSHOT_JSON         = "snapshot.json";           // 快照清单
const SYNCED_MARKER         = ".snapshot-synced.json";   // 同步标记

const MAX_MEMORY_ENTRYPOINT_LINES = 200;    // 入口文件截断行数
const MAX_MEMORY_ENTRYPOINT_BYTES = 25000;  // 入口文件截断字节

const ENV_DISABLE_AUTO_MEMORY = "CODEBUDDY_CODE_DISABLE_AUTO_MEMORY";  // 禁用自动记忆
```

### 9.2 快照同步机制

- `MEMORY.md` 是入口，过大时按 `MAX_MEMORY_ENTRYPOINT_LINES`/`MAX_MEMORY_ENTRYPOINT_BYTES` 截断。
- 完整记忆被拆到 `agent-memory-snapshots/` 下，`snapshot.json` 记录快照清单。
- `.snapshot-synced.json` 标记哪些快照已同步（去重/增量同步）。

复刻要点：**入口文件只放"摘要 + 最近记忆"**，完整内容放快照目录。这样每次注入 prompt 只读小入口文件，历史记忆按需从快照加载。

### 9.3 相关常量（同模块混入的运行时配置）

```typescript
const DEFAULT_MAX_TURNS          = 500;   // 默认最大轮数
const DEFAULT_TEMPERATURE        = 1;     // 默认温度
const MIN_SUBAGENT_MAX_TURNS     = 200;   // 子 agent 最小轮数
const ENV_MAX_TURNS = "CODEBUDDY_CODE_MAX_TURNS";   // 覆盖轮数上限的环境变量
```

### 9.4 AgentRunInterceptorPriority（拦截器优先级，完整枚举）

```typescript
// 拦截器按优先级从高到低执行（数值越大越晚执行）
const AgentRunInterceptorPriority = {
  // ... 早期拦截器 ...
  MemoryContext:    1150,   // 记忆上下文注入
  ConditionalRules: 1740,   // 条件规则注入
  // ... 更晚的拦截器 ...
};
```

复刻要点：`MemoryContext`（1150）先于 `ConditionalRules`（1740）执行——先注入常规记忆上下文，再注入条件规则，保证条件规则能"追加"到已有上下文之后。

## 10. MemoryContextInterceptor（记忆上下文注入拦截器）

这是每次 agent 运行前注入记忆的入口。完整控制流如下：

```typescript
async intercept(ctx): Promise<void> {
  // ① 跳过条件：非数组 input / skipRun / COMPACT / 自动记忆关闭
  if (!Array.isArray(input) || skipRun || mode === "COMPACT" || !isAutoMemoryEnabled()) return;

  // ② 生成 typed 还是 legacy prompt
  const useTyped = isTypedMemoryEnabled() && isTeamMemoryEnabled() && getTeamUserId();
  if (useTyped) await generateTypedMemoryPrompt(...);
  else          await generateLegacyMemoryPrompt(...);   // 读 MEMORY.md 截断 200 行/40000 字节

  // ③ 触发相关记忆注入（异步，见 10.2）
  await injectRelevantMemories(...);
}
```

### 10.1 自动记忆开关优先级

```typescript
function isAutoMemoryEnabled(): boolean {
  // 优先级：禁用 env → 启用 env → settings.memory.autoMemoryEnabled（默认 true）
  if (process.env[ENV_KEY_CODEBUDDY_DISABLE_AUTO_MEMORY]) return false;
  if (process.env[ENV_KEY_CODEBUDDY_MEMORY_ENABLED] !== undefined)
    return process.env[ENV_KEY_CODEBUDDY_MEMORY_ENABLED] === "true";
  return settings.memory?.autoMemoryEnabled ?? true;
}
```

### 10.2 shouldInjectMemoryContext（是否注入记忆上下文）

```typescript
function shouldInjectMemoryContext(input): boolean {
  // ① input 只有 1 条 user 消息 → 注入
  // ② 有 continue 标志 → 注入
  // ③ 首个 user 消息不含 memory data-role → 注入
  return /* 上述任一条件 */;
}
```

### 10.3 injectRelevantMemories（异步注入状态机）

```typescript
async function injectRelevantMemories(...): Promise<void> {
  // 状态机 transition：AGENT_STARTED 等状态
  // 延迟 50ms 启动（避免阻塞首轮）
  // abort 处理：skipRun=true + 注入中断消息
}
```

### 10.4 extractLastUserQuery（提取最后一条用户查询）

```typescript
function extractLastUserQuery(items): string {
  // 从尾部向前找 user 消息
  // 剥离 system-reminder / command-name / local-command-stdout / command-message 标签
  // 返回纯用户文本
}
```

复刻要点：`extractLastUserQuery` 的关键是**剥离标签**——注入给"相关记忆选择器"的查询必须是纯用户意图，不能带上系统提醒或命令输出，否则会把"工具输出"误当成用户意图去做相关记忆匹配。

## 11. MemoryRelevanceServiceImpl（相关记忆选择）

```typescript
class MemoryRelevanceServiceImpl {
  async selectRelevantMemories(query: string): Promise<Memory[]> {
    // ① env 开关：CODEBUDDY_MEMORY_RELEVANCE_DISABLED / ENABLED
    // ② settings.relevanceSelection 开关
    // ③ scanMemoryFiles 扫描记忆文件（见 11.1）
    // ④ 过滤 surfaced（已浮出的）
    // ⑤ doAISelection 调 AgentNames.MEMORY_SELECTOR 一次性 agent
    // ⑥ 从响应中 regex 提取 {"selected_memories":[...]} JSON
  }
}
```

### 11.1 scanMemoryFiles（扫描记忆文件）

```typescript
async function scanMemoryFiles(): Promise<MemoryFile[]> {
  // ① recursive readdir 遍历记忆目录
  // ② 过滤 .md 且非 MEMORY.md
  // ③ 读每个文件头 4096 字节（只读头，不读全文）
  // ④ 最多 200 条（MAX 截断）
  // ⑤ 按 mtime 降序（最近修改的优先）
}
```

### 11.2 formatMemoryManifest

把扫描到的记忆文件格式化为"清单"文本，供 `MEMORY_SELECTOR` agent 阅读和选择。

复刻要点：`scanMemoryFiles` **只读头 4096 字节**，是性能关键——记忆文件可能很多，全读会拖慢首轮。选择器只看摘要，选中后再回读完整内容。

## 12. MemoryExtractionServiceImpl（记忆提取子 agent）

后台自动从对话中提取"值得记住的事实"，写入长期记忆。这是最复杂的后台任务。

```typescript
class MemoryExtractionServiceImpl {
  isEnabled() {
    // env CODEBUDDY_MEMORY_EXTRACTION_ENABLED/DISABLED + settings.memoryExtraction
  }

  async doExtract(): Promise<void> {
    // ① 内存目录不存在 → 直接返回
    // ② 新消息 < 2 → 跳过（太短不值得提取）
    // ③ 主 agent 已写内存 → 跳过并 advanceCursor（避免重复）
    // ④ 创建 `${agent.name}-memory-extractor` 子 agent
    //    - tools 只保留 Read/Grep/Glob/Write/Edit
    //    - maxTurns: 5
    // ⑤ 权限模式临时切 BypassPermissions（结束后恢复）
    // ⑥ runWithoutHistory 运行
    // ⑦ toTextStream() 流消费
    // ⑧ 完成后 advanceCursor
    // ⑨ inProgress 防重入
  }
}
```

### 12.1 hasMemoryWritesSince（检测已有内存写入）

```typescript
function hasMemoryWritesSince(cursor): boolean {
  // 从 cursor 之后扫描 assistant 消息中的 tool_use / function_call
  // name 为 Write / Edit 且 file_path 在内存目录内 → true
}
```

### 12.2 MemoryExtractionStopHook / MemoryFreshnessPostToolHook

- `MemoryExtractionStopHook`：agent 停止时触发记忆提取的收尾/清理。
- `MemoryFreshnessPostToolHook`：工具执行后更新记忆"新鲜度"标记（记录上次访问时间）。

复刻要点：记忆提取是**一次性子 agent**，权限临时提升为 `BypassPermissions`（它要写文件，但用户不想为"记住东西"反复审批），任务结束立即恢复原权限模式。`maxTurns: 5` 限制它不会无限循环。`hasMemoryWritesSince` 防止主 agent 已经写过的内容被提取子 agent 重复写。

## 13. 辅助函数

### 13.1 记忆新鲜度（模块 1895）

```typescript
function memoryAgeDays(ts): number      // 距今多少天
function memoryAge(ts): string          // 人类可读年龄
function memoryFreshnessText(ts): string
function memoryFreshnessNote(ts): string
// 1 天内不提示；超过 1 天提示 stale + 需要验证
```

### 13.2 入口内容与 prompt 构建（模块 55518）

```typescript
truncateEntrypointContent(content)  // 按行/字节截断入口内容
buildMemoryLines(...)               // 构建记忆条目行
buildMemoryPrompt(...)              // 构建记忆 prompt
buildSearchingPastContextSection(...)  // 包含 Grep 搜索指令建议
```

复刻要点：`buildSearchingPastContextSection` 会在 prompt 里给模型"用 Grep 搜索历史记忆"的指令建议，让模型在信息不足时主动去检索，而不是硬记。

---

# 第三部分：技能系统

## 14. 目录函数（@skill dirs，完整还原）

```typescript
function getHomeSkillsDir(): string {
  return join(getHomeDir(), "skills");                    // ~/.codebuddy/skills
}
function getHomeConnectorSkillsDir(): string {
  return join(getHomeDir(), "connectors", "skills");      // ~/.codebuddy/connectors/skills
}
function getProjectSkillsDir(): string {
  return join(getWorkDir(), ".codebuddy", "skills");      // <workDir>/.codebuddy/skills
}
function getBuiltinSkillsDir(): string | undefined {
  return process.env.CODEBUDDY_BUILTIN_SKILLS_DIR || undefined;  // bundled 内置
}
```

另有 `CODEBUDDY_SESSION_SKILLS_DIRS` 环境变量（session 级技能目录，按 delimiter 拆分多个路径）。

## 15. 加载顺序与去重

```
加载顺序（@10991098 附近）：
  project（<workDir>/.codebuddy/skills）
    → user（~/.codebuddy/skills）
      → connector（~/.codebuddy/connectors/skills）
        → session env（CODEBUDDY_SESSION_SKILLS_DIRS 按 delimiter 拆分的每个路径）
          → bundled（loadBundledSkills）

去重：按 name 去重，先加载的优先（project 优先级最高，覆盖 user 同名技能）。
```

### 15.1 loadBundledSkills（@10991431）

```typescript
function loadBundledSkills(alreadyLoaded: Set<string>): Skill[] {
  const dir = getBuiltinSkillsDir();
  if (!dir) return [];

  // 用已有技能名集合去重，只补全缺失的内置技能
  return scanSkillsDirectory(dir, "bundled", alreadyLoaded);
}
```

### 15.2 MAX_TOTAL_SKILLS 溢出逻辑

```typescript
// 技能总数超上限时：
//   - 非 user 技能优先保留
//   - user 技能超量时裁剪并写 warning
```

## 16. scanSkillsDirectory（@10573483 / @10991948）

```typescript
async function scanSkillsDirectory(dir, source, seenNames: Set<string>): Promise<Skill[]> {
  // ① MAX_SCAN_DEPTH 限制递归深度
  // ② readdir withFileTypes 区分文件/目录
  // ③ 只处理文件名为 "SKILL.md" 的 entry（一个目录一个 SKILL.md）
  // ④ ec 集合按 name 去重
  // ⑤ mapWithConcurrency 并发扫描子目录
}
```

复刻要点：**一个技能 = 一个目录 + 该目录下的 `SKILL.md`**。扫描器只认 `SKILL.md` 这个固定文件名，其余文件（如 `references/`、`scripts/`）由 `SKILL.md` 内容引用。并发扫描子目录提升加载速度。

## 17. parseSkillFile（两种解析路径）

### 17.1 路径 A：插件加载器（@10574738）

```typescript
function parseSkillFile(content, source): Skill {
  // ① frontmatter 解析（YAML）
  // ② deriveSkillVisibility → userInvocable / disableModelInvocation
  // ③ name 非字符串 → 回退用路径派生名
  // ④ description 拼接 `(${source})` 标记来源
  // ⑤ allowed-tools 用 parseListField 解析
  // ⑥ hooks 用 parseFrontmatterHooks + enrichPluginHookConfigs
  // ⑦ load-time 变量替换：
  //    - 插件技能：substitutePluginLoadTimeVariables
  //    - 普通技能：substituteLoadTimeVariables
}
```

### 17.2 路径 B：产品 Provider（@10993494）

```typescript
function parseSkillFile(...): Skill {
  // ① 读 product meta 文件（skill 目录 + 父目录各试一次）：
  //    _skillhub_meta.json / _knot_meta.json / _user_meta.json / _marketplace_meta.json
  // ② 提取 skillId / slug / version
  // ③ displayName：优先 frontmatter display_name / display-name，其次 meta name
  // ④ agentCreated: true === em.agent_created || undefined
  // ⑤ bundled 时 resolveBundledResourceName 和 replaceBrandName
}
```

### 17.3 frontmatter 字段约定

```yaml
---
name: my-skill
description: 技能描述
description_zh: 中文描述
description_en: 英文描述
display_name: 显示名        # 或 display-name
disable: false              # 是否禁用
agent_created: true         # 是否 agent 创建
allowed-tools: [Read, Grep] # 允许使用的工具白名单
---
# 技能正文（Markdown，作为 prompt 注入给模型）
```

复刻要点：`agent_created` 是 `skill_manage` 工具的鉴权依据（见 18），只有 `agent_created===true` 或注册在 `agent-created-skills.json` 里的技能才能被 modify/delete。

## 18. skill_manage 工具（完整 schema + 工作流）

### 18.1 常量与 schema

```typescript
const REGISTRY_FILENAME = "agent-created-skills.json";   // 注册表文件名
const OUTPUT_MAX        = 3e4;   // 30000 —— 输出上限（字符）
const LIST_MAX          = 30;    // list 返回的技能数上限
const DIR_ENTRY_MAX     = 100;   // 目录条目扫描上限

// schema
{
  action: enum(["list", "create", "modify", "delete"]),
  name:   string,          // optional（list 不需要，其余需要）
}

// 工具属性
needsApproval = false;                       // 不需要审批
isEnabled = 检查 ProductFeature.SkillManage   // 产品特性开关
```

### 18.2 handleList

```typescript
function handleList(): string {
  // ① 列出技能，前 30 个返回完整信息（name + description + [agent_created] 标记）
  // ② 其余仅返回名称（避免输出超限）
  // ③ [agent_created] 标记表示该技能是 agent 创建、可被 modify/delete
}
```

### 18.3 handleCreate

```typescript
function handleCreate(name, ...): string {
  // ① 冲突检测：同名技能已存在 → 报错
  // ② generateSkillTemplate 生成 YAML 模板
  // ③ 创建 supporting dirs（references/、scripts/ 等）
  // ④ 写入 workflow（可选）
  // ⑤ 注册进 agent-created-skills.json 并写入说明
}
```

### 18.4 handleModify / handleDelete

```typescript
function handleModify(name, ...): string {
  // 先 validateAgentCreated：registry 命中 或 frontmatter agent_created===true
  // 通过 → 修改 SKILL.md
}
function handleDelete(name): string {
  // 先 validateAgentCreated 同上
  // 通过 → 删除技能目录 + 从 registry 移除
}
```

### 18.5 generateSkillTemplate（YAML 模板）

```yaml
---
name: <skill-name>
description: <描述>
description_zh: <中文描述>
description_en: <英文描述>
disable: false
agent_created: true
---
```

### 18.6 注册表格式（agent-created-skills.json）

```json
{
  "skills": [
    {
      "name": "my-skill",
      "createdAt": "<iso-timestamp>",
      "path": "<skill-dir-absolute-path>"
    }
  ]
}
```

复刻要点：`skill_manage` 的鉴权双通道——**注册表命中 或 frontmatter `agent_created===true`** 任一满足即可 modify/delete。这是防止用户手写的（非 agent 创建的）技能被 agent 擅自删除的保护机制。`needsApproval=false` 意味着技能管理操作本身不再逐条问用户（但底层文件写入仍受权限/沙箱系统约束）。

---

## 19. 复刻清单（Web 版最小闭环）

按依赖顺序实现：

1. **模型调度**（第 1-5 章）
   - `MODEL_VARIANT_TYPES` + `isModelVariantType`：纯函数，先写。
   - `computeRelatedModel` 的 fallback 链：纯函数 + 可注入的配置源（env/settings/modelMap/defaultRelatedModels）。
   - `configureModelConfig`：把解析结果落到 agent 对象，注意 custom 模型的 omit 语义。
   - 图像/视频模型走独立优先级链，最后做。

2. **规则文件记忆**（第 6-8 章）
   - `MemoryManagerImpl.addFact`（去重 + 分节插入）：纯文件操作，先写。
   - `MemoryLoaderImpl`（祖先目录收集 + 根向下遍历 + 第一个成功 break）：纯文件操作。
   - `MemoryParser` / `MemoryValidator` / `MemoryCache`：围绕文件的纯变换。
   - `ConditionalRulesServiceImpl`（触发器 + 注入结构）：内存状态机。
   - `MemoryController`：薄 HTTP 层，最后接。

3. **Agent 持久记忆**（第 9 章）
   - `MEMORY.md` 入口 + 快照目录 + 截断逻辑。
   - `MemoryContextInterceptor`（自动记忆开关 + legacy/typed prompt + 注入状态机）。

4. **相关记忆 + 提取**（第 11-12 章）
   - `MemoryRelevanceServiceImpl`（scanMemoryFiles 只读头 4096 + MEMORY_SELECTOR 一次性 agent + JSON regex 提取）。
   - `MemoryExtractionServiceImpl`（子 agent + BypassPermissions + maxTurns 5 + 防重入）。
   - 这两个依赖模型服务，最复杂，最后做；先用 mock 返回空，再逐步接真模型。

5. **技能系统**（第 14-18 章）
   - 目录函数 + `scanSkillsDirectory`（SKILL.md 固定文件名 + 去重 + 并发）。
   - `parseSkillFile`（frontmatter 解析 + product meta 回退 + 变量替换）。
   - `skill_manage` 工具（4 个 action + 注册表 + 模板 + validateAgentCreated 鉴权）。

核心设计原则贯穿全部代码：

- **fallback 链兜底**：模型变体解析永远有主模型兜底，custom/external 跳过默认关联。
- **记忆单一事实源是文件系统**：规则、持久记忆、技能都以文件为权威，Parser/Validator/Cache 是纯变换。
- **append-only + 去重**：记忆写入不破坏已有内容，去重用整行 includes。
- **一次性子 agent 做后台任务**：记忆提取、相关记忆选择都用一次性子 agent，权限临时提升，任务结束即恢复。
- **只读头 + 摘要 + 快照**：相关记忆扫描只读头 4096 字节，持久记忆入口只放摘要，完整内容进快照目录。

---

## 20. 偏移量索引（本批关键函数）

| 符号 | 偏移量 | 说明 |
|------|--------|------|
| resolveModel（主） | @6992439 | 模型归一化入口 |
| computeRelatedModel | @6989474 | 变体 fallback 链 |
| configureModelConfig | @7077676 | 模型参数落到 agent |
| resolveModel（图像） | @12752507 | 图像模型解析 |
| resolveModel（视频） | @12764821 | 视频模型解析 |
| scanSkillsDirectory | @10573483 / @10991948 | 技能目录扫描 |
| parseSkillFile（插件路径） | @10574738 | 插件加载器解析 |
| parseSkillFile（产品路径） | @10993494 | 产品 Provider 解析 |
| loadBundledSkills | @10991431 | 内置技能补全 |
| 技能加载顺序 | @10991098 附近 | project→user→connector→session→bundled |
| MemoryManager / Loader 等 | 模块 14064 | 记忆核心实现 |
| 记忆 prompt 模板 | 模块 60709 | 完整原文字符串 |
| Agent 持久记忆 | 模块 67853 | MEMORY.md + 快照 |
| 记忆常量 | 模块 9162 | 文件名/Scope/Type/上限 |
| 记忆新鲜度辅助 | 模块 1895 | memoryAge / freshness |
| 入口/prompt 构建 | 模块 55518 | truncate / buildMemoryPrompt |
| 相关记忆 / 提取 | 模块 1895 / impl2 | selectRelevant / doExtract |
