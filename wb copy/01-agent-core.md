# 第一批实现设计：Agent 循环引擎 + 工具系统 + 会话格式

> 逆向来源：WorkBuddy CLI 内核 `codebuddy.js`（22MB webpack bundle）+ 本机 `~/.workbuddy` 运行时数据。
> 目标：粒度到"可直接照着写代码"。所有类型定义、算法、文件格式均从产物还原，非猜测。
> 适用场景：Web 应用复刻（架构与存储设计同样适用于任何形态）。

---

## 0. 总览：三模块如何咬合

```
用户输入 (ACP session/prompt)
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│ Agent 循环引擎 (Runner / AgentRunScope)                  │
│  RunState ←→ LLM 流式响应(OpenAI风格事件)                │
│    │ 每产生 item → persistRunItemsToSession              │
│    │ 遇 tool_calls → 挂起等工具结果 → 下一轮              │
│    ▼                                                    │
│ 工具系统 (ToolPermissionService + SandboxOrchestrator)   │
│  needsApproval? → classifySafety? → invoke()             │
│    │ 执行前后 → FileTrackService 记录文件变更             │
│    ▼                                                    │
│ 会话存储 (SessionStore + CheckpointService)              │
│  JSONL 追加写 + file-history 版本化备份 + rewind 支持     │
└─────────────────────────────────────────────────────────┘
```

关键设计决策（复刻时保留）：

1. **单一事实源**：`history`（item 数组）是唯一状态。UI、重放、压缩、回退全部从它派生。
2. **append-only**：JSONL 只追加不修改；"回退"= 移动 `lastMessageId` 指针 + 注入 notice item，历史永不删除。
3. **item 即协议**：RunState._generatedItems、JSONL 行、ACP 事件流，三者是同一 item 格式的不同投影。
4. **权限与沙箱解耦**：权限（问不问用户）和沙箱（允不允许执行）是两个独立判定，都通过后才执行。

---

## 1. Agent 循环引擎

### 1.1 分层调用链

```
AcpView.executePrompt(msg)          // 入口：取 sessionId，构造 cancel barrier
  → AgentService.runDefault(session, input)
    → resolveAgentForSession()      // 根据 session 选择 Agent（主 agent / 子 agent）
    → new AgentRunScope(...)
      → runPipeline() / runPhysical()
        → Runner.run(agent, input, options)   // 内嵌魔改版 OpenAI Agents SDK
```

复刻要点：
- **AgentService 是无状态门面**，真正的运行上下文（scope）每次创建、用完即弃。
- **Runner 内部循环**负责 turn 计数、guardrails、工具调度、结果聚合——见 1.3。

### 1.2 RunState（核心数据结构，逐字段）

```typescript
class RunState {
  _currentTurn = 0;                    // 当前轮次（从 0 计）
  _currentTurnInProgress = false;      // 上次运行是否在 turn 中途被打断（恢复判定用）
  _currentAgent: Agent;                // 当前活跃 agent（handoff 可切换）
  _originalInput: string | Item[];     // 本轮 run 的原始输入
  _modelResponses: ModelResponse[];    // 每次模型调用的原始响应
  _conversationId: string;
  _previousResponseId?: string;        // 支持响应链（OpenAI Responses API 风格）
  _reasoningItemIdPolicy: 'auto' | ...;
  _lastModelSettings: ModelSettings;
  _currentAgentSpan?: Span;            // 可观测性 span
  _context: RunContext;                // 依赖注入容器（服务定位器）
  _toolUseTracker: ToolUseTracker;     // 追踪工具调用配额/重复
  _pendingAgentToolRuns: AgentToolRun[]; // as_agent 工具的挂起子运行
  _generatedItems: Item[];             // ★ 本次 run 新产生的 items（持久化的增量单位）
  _currentTurnPersistedItemCount = 0;  // 本 turn 已持久化 item 数（断点续传游标）
  _maxTurns: number;                   // 超限抛 MaxTurnsExceededError
  _noActiveAgentRun = true;
  _lastTurnResponse?: ModelResponse;
  _inputGuardrailResults: GuardrailResult[];   // 输入护栏
  _outputGuardrailResults: GuardrailResult[];  // 输出护栏
  _toolInputGuardrailResults: GuardrailResult[];  // 工具入参护栏
  _toolOutputGuardrailResults: GuardrailResult[]; // 工具出参护栏
  _currentStep?: RunStep;
  _finalOutputSource: 'llm' | 'handoff' | 'tool';
  _lastProcessedResponse?: ModelResponse;
  _trace?: Trace;
}
```

### 1.3 主循环（伪代码，照抄结构）

```typescript
async *runStream(agent, input, options) {
  const state = new RunState(agent, input, context);
  state._maxTurns = agent.maxTurns ?? 10;

  // 输入护栏（在进循环前）
  state._inputGuardrailResults = await runInputGuardrails(agent, input);

  while (true) {
    // ① turn 开始：计数或恢复
    const { isResumingFromInterruption } = beginTurn(state, options);

    // ② 调模型（流式）
    const stream = await callModel(state._currentAgent, buildMessages(state));
    for await (const event of stream) {
      // OpenAI 风格事件: delta.tool_calls / delta.content / finish_reason
      const newItems = accumulateItems(state, event);   // 聚合成 item
      yield* emitStreamEvents(newItems);                // 转换层: → Anthropic 块协议
      await persistRunItemsToSession(state, newItems);  // ★ 增量持久化（不等 turn 结束）
    }

    // ③ 无工具调用 → 结束
    if (!hasPendingToolCalls(state)) {
      await runOutputGuardrails(agent, state);
      return buildFinalOutput(state);
    }

    // ④ turn 上限
    if (state._currentTurn >= state._maxTurns) throw new MaxTurnsExceededError();

    // ⑤ 执行工具（可并行）
    const toolResults = await executeTools(state);   // 权限→沙箱→invoke，见 §2
    await persistRunItemsToSession(state, toolResults); // function_call_result items
    // 循环继续 → ②
  }
}
```

### 1.4 beginTurn：中断恢复的核心（还原代码）

```javascript
function beginTurn(state, options) {
  // 恢复条件 A：会话是恢复态且明确要求续跑被打断的 turn
  const resuming = options.isResumedState && options.continuingInterruptedTurn;
  // 恢复条件 B：恢复态且上次 turn 未完成（_currentTurnInProgress 落盘过）
  const inProgress = options.isResumedState && state._currentTurnInProgress === true;

  if (!resuming && !inProgress) {
    state._currentTurn++;
    // preserveTurnPersistenceOnResume: 恢复场景下已持久化计数若超前于实际 items，
    // 重置持久化游标避免重复写入
    if (options.isResumedState && options.preserveTurnPersistenceOnResume) {
      if (state._currentTurnPersistedItemCount > state._generatedItems.length)
        state.resetTurnPersistence();
    } else {
      state.resetTurnPersistence();
    }
  }
  state._currentTurnInProgress = true;
  return { isResumingFromInterruption: resuming };
}
```

复刻要点：
- **崩溃恢复的关键**是 `_currentTurnInProgress` 与 `_currentTurnPersistedItemCount` 两个游标随会话落盘；重启后据此判断"接着跑"还是"开新 turn"。
- `_generatedItems` 增量持久化 + 游标去重 = 工具调用不会因崩溃而重复执行已完成的调用（幂等恢复）。

### 1.5 流式协议转换（双协议桥）

内部事件（OpenAI 风格）→ 对外事件（Anthropic 块协议），用于 ACP/UI 消费：

```
message_start
content_block_start   {content_block: {type: "tool_use", id, name, input:{}}}
content_block_delta   {delta: {type:"input_json_delta", partial_json}}
content_block_delta   {delta: {type:"text_delta", text}}
content_block_stop
message_delta         {delta: {stop_reason: "tool_use"|"end_turn"|"max_tokens"}}
message_stop
```

同时包装为 ACP 会话事件：

```json
{ "type": "stream_event", "event": {...},
  "session_id": "...", "parent_tool_use_id": null, "uuid": "..." }
```

复刻要点：工具调用参数是**流式 JSON 分片**（`input_json_delta`），UI 端需要增量拼接渲染。

### 1.6 持久化钩子（CodeBuddy 对 Agents SDK 的增强层）

| 钩子 | 触发时机 | 作用 |
|---|---|---|
| `persistRunItemsToSession(state, items)` | 每批 item 产生后 | 增量写入 JSONL（见 §3.3） |
| `saveStreamResultToSession` | 流结束 | 兜底持久化 + meta 更新 |
| `runCompactionOnSession` | 上下文超阈值 | 触发历史压缩（§3.6） |
| `saveToSession` | 显式保存 | 全量 save |

---

## 2. 工具系统

### 2.1 BaseTool 契约（还原代码）

```typescript
abstract class BaseTool<IArgs, IOutput> {
  name: string;
  aliases?: string[];          // 权限判定时 name+aliases 都参与匹配
  description = "";
  strict = true;               // JSON Schema strict 模式
  isEnabled = true;
  abstract parameters: JSONSchema;

  // ★ 权限判定统一走全局 ToolPermissionService（策略模式），工具自身不实现判定逻辑
  needsApproval = async (args, context, signal) =>
    ContainerUtil.get(ToolPermissionService)
      .needsApproval(this, args, context, () => this.resolveNeedPermissionArgs(args));

  // 供权限判定的参数摘要（字符串化，喂给敏感目录检查等）
  resolveNeedPermissionArgs(args) {
    return [{ type: ToolArgType.Unknown,
              value: typeof args === 'string' ? args : JSON.stringify(args.value) }];
  }

  // ★ 工具类别判定：按名称子串匹配（name+aliases 小写化后 includes）
  resolveToolType(names: string[]): ToolPermissionType {
    if (names.some(n => n.includes('read')))   return 'Read';
    if (names.some(n => n.includes('bash')))   return 'Bash';
    if (names.some(n => n.includes('edit')))   return 'Edit';
    return 'Unknown';
  }

  abstract invoke(args, signal): Promise<ToolOutput>;

  // 自动分类器输入（sandbox 侧安全分级用）
  abstract toAutoClassifierInput(args): string;
  // 敏感出口解析（网络/数据外发审计）
  abstract resolveSensitiveEgress(args): string[];
  // 后台执行阻断：print 输出且非 stream-json 的工具不许后台跑
  isBackgroundExecutionBlocked(context) {
    return context?.options?.print === true
        && context?.options?.inputFormat !== 'stream-json';
  }
}
```

内建工具清单（从真实会话 JSONL 观测）：`Bash`、`PowerShell`、`Read`、`Edit`、`Write`、`Grep`、`Glob`、`TaskCreate/TaskUpdate/TaskOutput`、`AskUserQuestion`、`present_files`、`show_widget`、`read_me`、`DeferExecuteTool`、`ToolSearch`。

### 2.2 权限判定：PermissionMode × Strategy

每个权限模式一个 Strategy 类，`needApproval(tool, args, ctx)` 返回 boolean：

```typescript
// Default 模式（还原代码）
class DefaultStrategy {
  mode = 'Default';
  async needApproval(tool, args, ctx) {
    const names = [tool.name, ...tool.aliases ?? []].map(s => s.toLowerCase());
    switch (tool.resolveToolType(names)) {
      case 'Read':
        // ★ 唯一自动放行路径：读参数全部落在受信任目录
        return !(await PermissionUtils.isArgsInTrustedDirectories(ctx.args));
      case 'Edit':
      case 'Bash':
      default:
        return true;   // 一律询问
    }
  }
}

// AcceptEdits 模式：Edit 类自动放行，Bash 仍询问
// Plan 模式：委托给 prePlan 策略（计划模式下只读）delegateToPrePlanStrategy
// Work 模式：Edit + 信任 Bash 白名单自动放行（高频开发循环不打断）
// DontAsk 模式：全部自动放行（危险，需显式开启）
```

复刻要点：
- **模式切换是热切换**（ACP `session/set_mode`），无需重建会话。
- 判定入参是 `resolveNeedPermissionArgs` 的**字符串摘要**而非结构化参数——简化实现但意味着受信任目录检查是字符串匹配级别。

### 2.3 MCP 集成：Proxy 重命名

```javascript
// MCP 工具统一包装为 Proxy，name 重写为 mcp__{server}__{tool}
const proxy = createToolProxy(mcpTool, serverName);
proxy.name = `mcp__${serverName}__${toolName}`;
// invoke 转发到 MCP client.callTool，参数/结果做 JSON Schema ↔ MCP 协议转换
```

复刻要点：命名空间前缀避免跨 server 工具名冲突，同时让权限层可以按 `mcp__{server}__` 前缀做 server 级策略（如整个 server 标记受信任/不受信任）。

### 2.4 沙箱分类（风险隔离第二道闸）

```typescript
// SandboxOrchestrator
const verdict = await classifySafety(commandOrToolCall);
// → 'auto-approve' | 'needs-approval' | 'block-listed'   （三态）
```

执行链：`needsApproval`(权限层) && `classifySafety`(沙箱层) 都通过 → `invoke()`。
沙箱拒绝对应 toolResult.rawResponse.sandboxDenied = true（JSONL 中可见该字段）。

---

## 3. 会话格式与存储

### 3.1 磁盘布局（实测）

```
~/.workbuddy/
├── projects/
│   └── {compressPath(cwd)}/              # cwd 转义，如 d-trae001-pt-test
│       ├── {sessionId}.jsonl             # ★ 对话转录（append-only，一行一 item）
│       ├── {sessionId}.meta.json         # 会话元数据（标题、fork 信息等）
│       └── {parentSessionId}/
│           └── subagents/
│               └── agent-{xxx}.jsonl     # 子 agent 独立转录（id 以 agent- 开头）
├── file-history/
│   └── {sessionId}/
│       └── {pathHash}@v{N}               # ★ 文件版本备份（N=版本号，从 v1 起）
├── file-tree-manifests/
│   └── {sessionId}.json                  # 会话级文件树清单（大，~17MB 级）
├── traces/{pid}/trace_{uuid}.json        # OTel 风格 trace
└── sessions/{port}.json                  # daemon 注册表（pid/url/endpoint/heartbeat）≠转录
```

### 3.2 Item wire 格式（JSONL 每行）

**通用字段**（所有 item 共有）：
```typescript
interface ItemBase {
  id: string;           // uuid（function_call 用无连字符 hex；notice 用 notice-{ts}-{rand}）
  parentId?: string;    // ★ 树状链：指向触发它的上游 item（message/reasoning）
  timestamp: number;    // ms
  sessionId?: string;   // 所属会话
  cwd?: string;         // 当时工作目录（随行冗余，会话可在多 cwd 间迁移）
  providerData?: {      // ★ 侧车元数据（非模型数据全放这）
    messageId?: string;          // 一次模型请求的 id（同一请求的多个 item 共享）
    model?: string;              // 实际模型（"hy3"）
    requestModelId/Name?: string;
    traceId?: string;            // == conversationRequestId（观测关联）
    agent?: string;              // "cli" | AgentNames.COMPACT | ...
    reasoning?: string;          // function_call 附带的上轮思考
    argumentsDisplayText?: string; // 工具参数的展示态文本
    toolResult?: {...};          // function_call_result 的丰富结果（见下）
    rawUsage?/usage?: {...};     // token 用量（双格式并存）
    skipRun?: boolean;           // 注入的历史不触发执行
    isSessionSeparator?: boolean;
    isMeta?: boolean;            // 框架注入的伪用户消息（system-reminder 等）
  };
}
```

**7 种 item 类型**（真实样本统计：4713 行 = 1350 function_call + 1350 function_call_result + 872 reasoning + 723 message + 414 file-history-snapshot + 3 ai-title + 1 resend-fork-notice）：

```typescript
// ① message
{ type: "message", role: "user"|"assistant"|"system",
  status?: "completed",
  content: Array<
    | { type: "input_text",  text }               // user
    | { type: "output_text", text, providerData?: {annotations:[]} }  // assistant
  >,
  __codebuddyLocal?: { sensitiveUserInputReviewed: boolean } }

// ② reasoning（思考链独立成 item，非 message 的一部分）
{ type: "reasoning",
  content: ReasoningTextBlock[],        // 结构化（可为空）
  rawContent: [{ type: "reasoning_text", text }] }  // 原始思考文本

// ③ function_call
{ type: "function_call",
  callId: "chatcmpl-tool-{uuid}",       // ★ callId 关联调用与结果
  name: "Bash",
  arguments: '{"command":"..."}' }      // JSON 字符串

// ④ function_call_result
{ type: "function_call_result",
  callId: "chatcmpl-tool-{uuid}",       // 与 function_call.callId 对应
  name: "Bash",
  status: "completed" | "failed",
  output: { type: "text", text },       // 给模型看的结果
  providerData: { toolResult: {
    content,                            // 展示内容
    renderer: { type, value },          // UI 渲染提示
    rawResponse: {                      // ★ 原始执行元数据
      exitCode, signal, interrupted,
      sandboxDenied,                    // 沙箱拒绝标记
      stderrBytesTruncated, stdoutBytesTruncated,
      tool_error_code, is_error, error
    }}}}

// ⑤ file-history-snapshot（checkpoint 快照，见 §3.4）
{ type: "file-history-snapshot",
  isSnapshotUpdate: boolean,
  snapshot: { messageId,
    trackedFileBackups: { [相对路径]: {
      backupFileName: "{pathHash}@v{N}",  // file-history/ 下的备份文件名
      version: N,
      backupTime: ms } } } }

// ⑥ ai-title（AI 生成的会话标题）
{ type: "ai-title", aiTitle: "..." }

// ⑦ resend-fork-notice（编辑重发产生的分叉通知，UI 渲染分叉点）
{ type: "resend-fork-notice", editedUserItemId: "..." }
```

**自定义 item 类型全集**（`CUSTOM_INPUT_ITEM_TYPES`）：
`custom-title, ai-title, file-history-snapshot, summary, topic, goal-result, goal-progress, resend-fork-notice`

### 3.3 SessionStore：读写算法（还原代码）

**写入（appendHistory）**——per-session 互斥 + 批量追加：

```typescript
async appendHistory(sessionId, items, parentSessionId?, options?) {
  if (isSessionPersistenceDisabled(options)) return;
  // ① promise 链式写锁：同一 session 的写操作严格串行
  const prev = this.writeLocks.get(sessionId) ?? Promise.resolve();
  let release; const gate = new Promise(r => release = r);
  this.writeLocks.set(sessionId, prev.then(() => gate));
  try {
    await prev;                               // 等前一个写完成
    if (parentSessionId && sessionId.startsWith('agent-'))
      await mkdir(join(storageDir, parentSessionId, 'subagents'), {recursive: true});
    const file = this.getSessionFilePath(sessionId, parentSessionId);
    // ② 每行 JSON.stringify + '\n'，一次 join 后单次 appendFile（减少系统调用）
    const buf = (await Promise.all(items.map(i =>
      transformItemForSaveAsync(i).then(x => JSON.stringify(x) + '\n')))).join('');
    await appendFile(file, buf, 'utf-8');
  } finally {
    release();
    if (this.writeLocks.get(sessionId) === gate) this.writeLocks.delete(sessionId);
  }
}
```

`transformItemForSaveAsync`：usage 归一化（camelCase → snake_case 的 OpenAI 格式）；message/assistant/function_call 的 usage 从 providerData 提升到 `message.usage`。

**读取（deserializeSessionFromPath）**——**从尾部逆序读 + 边界截断**：

```typescript
// 每行 64KB 缓冲，从文件尾向前 eachLine：
// - 有 historyLimit：读满 N 条即停
// - 无 limit：读满 resolveSessionMaxItems()（默认 1000，env CODEBUDDY_SESSION_MAX_ITEMS）
//   且停在下一条 user message 边界（或超出 limit+100 强制停）
// 读到的数组是"新→旧"，reverse() 恢复时间正序
// 会话 id：取前 10 行的 sessionId 字段；若 != 文件名 id → 文件名 id 记为 storeId（迁移场景）
// meta：读同名 .meta.json
// hasCompactedHistory = history 中存在 (logicalParentId && !parentId) 的 item
```

**查找顺序**（get）：`preferredProjectDir(cwd 规范化压缩)` → `legacyProjectDir（旧路径压缩格式）` → `当前 workDir 的 projectDir`。

### 3.4 Checkpoint（文件版本化）

**备份创建**（编辑工具触发，EDIT/WRITE/MULTI_EDIT）：

```typescript
// FileTrackService.trackFile：文件首次被编辑时登记（此时无备份=文件已存在）
checkpoint.fileSnapshots[absPath] =
  { filePath, backupFileName: undefined, version: N, backupTime: Date.now() };

// FileVersionStore.save：写前先备份
// backupFileName = {computePathHash(absPath)}@v{version}
// 备份 = copyFile(原文件, ~/.workbuddy/file-history/{sessionId}/{backupFileName})
```

**快照落盘**：每个 user message 后追加一条 `file-history-snapshot` item（`isSnapshotUpdate` 标识是否增量更新），key 是**相对 cwd 的路径**。

**checkpoint ↔ snapshot 双向转换**：

```typescript
// CheckpointUtils.convertSnapshotToCheckpoint：JSONL item → 内存 checkpoint
//   相对路径 → 绝对路径（normalizeCheckpointPath），补 filePath 字段
// CheckpointService.convertCheckpointToSnapshot：内存 → JSONL item
//   绝对路径 → 相对 cwd；剔除 artifact index 内部文件

// getRewindableCheckpoints(history)：遍历 history，每个"真实 user message"
//   （isRealUserMessageItem，排除 isMeta/system-reminder）构建一个可回退 checkpoint，
//   后续 file-history-snapshot 累积进该 checkpoint 的 fileSnapshots

// getActiveHistory(session)：取 lastMessageId 之后的有效段，
//   并把每个 active user message 关联的 snapshot item 重新插回其后的位置
```

**恢复（revertToCheckpoint）**：

```typescript
for (const [absPath, snap] of Object.entries(target.fileSnapshots)) {
  const current = latestCheckpoint.fileSnapshots[absPath];
  if (!current) {                       // 目标有、现在无 → 用 v1 备份恢复或删除
    restore(file-history/{sessionId}/{pathHash}@v1, absPath) ?? deleteFile(absPath);
  } else if (current.version === snap.version
          && current.backupFileName === snap.backupFileName) continue;  // 无变化
  else if (snap.backupFileName) restore(备份, absPath);   // copyFile 备份→原路径
  else deleteFile(absPath);            // 目标无备份=当时是新建文件 → 删除
}
// compareWithCurrentFiles：恢复前对每文件算 diff（addLineCount/removedLines）供 UI 预览
```

### 3.5 回退与分叉（rewind 语义）

**对话回退**（ACP `_codebuddy.ai/session/rollback`）：

```typescript
async function rewindTo(session, forkPointId, reason, opts) {
  session.lastMessageId = forkPointId;      // ★ 只移指针，不删历史
  session.conversationReverted = true;      // 后续 prompt 从 forkPoint 重放
  if (reason === 'checkpoint_revert')
    session.historyReloadSubject.next({reason: 'checkpoint-revert'});  // 通知 UI 重载
  if (reason === 'resend_edit' && opts?.addHistory && opts.editedUserItemId) {
    // 注入分叉通知 item（UI 据此渲染"从这里分叉"标记）
    await opts.addHistory(session, [createResendForkNotice(forkPointId, opts.editedUserItemId)]);
  }
}
// fork point 解析：resolveResendForkPoint(history, {userMessageId | forkFromRequestId})
```

**其他历史操作**：
- `session/inject_history`：注入 `skipRun: true` 的 message items（不触发执行，仅填充上下文）。
- `handleClearSession`：写入 `role:"system"` + `providerData.isSessionSeparator` 的分隔 item——单文件多"会话"。
- 回放（replayHistoryItems）：跳过 `agent === COMPACT` 的 item、`isMeta` 伪用户消息、分隔符、notice；ai-title/topic 转为独立 ACP 事件。

### 3.6 历史压缩（compaction）

```typescript
// HistoryEngineeringCompactor.compact(history)：
//   取压缩边界段 → 生成压缩内容 → 包裹为:
//   <cb_summary>\n{summaryHeader + compressed}\n</cb_summary>
//   返回 { compactContent, estimatedTokens, originalItemCount }
// 压缩时可安全跳过的 item 类型：
//   ["function_call_result","reasoning","custom-title","topic","ai-title",
//    "summary","file-history-snapshot"]
// 压缩产物作为新的 summary item 写入；压缩会话 isForkedCompactionSession 标记，
// logicalParentId 指向原历史（回退时用 logicalParentId 兜底）
```

---

## 4. Web 应用复刻要点

| 原生实现 | Web 复刻建议 |
|---|---|
| JSONL 文件 + writeLocks | 后端保持 JSONL（可观测、可 grep）；或 Postgres `session_items` 表 + `(session_id, seq)` 唯一索引，append 语义相同 |
| `~/.workbuddy` 目录 | 用户级 workspace 卷挂载；file-history 版本化直接保留（copyFile 方案简单可靠） |
| ACP over stdio | 同一套 item 协议走 WebSocket/SSE；`stream_event` 包装结构照搬 |
| daemon 注册表 sessions/*.json | k8s/容器场景改为 Redis 或 DB 心跳表（原实现是单机假设） |
| CheckpointService | 多实例部署需把 file-history 移到对象存储或共享卷，按 `{sessionId}/{pathHash}@v{N}` 键直接映射 |
| trace JSON 文件 | 接 OTel collector |

**必须保留的五个语义**（丢了就无法对齐体验）：
1. item 追加写 + `lastMessageId` 指针回退（不删历史）。
2. `parentId` 树状链——UI 的消息分组、分叉、重放全依赖它。
3. `providerData` 侧车——模型无关数据（usage/traceId/renderer）与模型数据严格分离。
4. turn 中断恢复游标（`_currentTurnInProgress` + `_currentTurnPersistedItemCount`）。
5. 权限与沙箱双层判定（§2.2 + §2.4），且互不越权。

---

## 附：关键还原偏移量索引（codebuddy.js，22955544 chars）

| 偏移 | 内容 |
|---|---|
| @7155932 | AgentService.runDefault |
| @17769199 | RunState 类字段 |
| @17845925 / @17847055 | Runner 主循环 / beginTurn |
| @17799033 | saveToSession / persistRunItemsToSession |
| @12230116 | BaseTool（模块 57712） |
| @12275740–@12281943 | ToolPermissionStrategy 五种模式 |
| @9945757 | MCP Proxy（mcp__ 命名） |
| @10437352 | SandboxOrchestrator.classifySafety |
| @11624035 / @11637274 | SessionStore（readLock/writeLocks/appendHistory） |
| @7476599–@7486187 | CheckpointService / FileVersionStore / 回退 API |
| @14214353 | CheckpointUtils（snapshot↔checkpoint） |
| @6578031 | rewindTo + createResendForkNotice |
| @7900293 | HistoryEngineeringCompactor |
| @7212481 | CUSTOM_INPUT_ITEM_TYPES |
| @7622372 / @7638825 | ACP 流转换 / replayHistoryItems |
