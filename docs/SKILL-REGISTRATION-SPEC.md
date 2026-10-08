# Skill / 工具注册格式规范

> 本文定义「一个新 skill（工具）要声明哪些字段、调用哪个函数注册」的标准做法。
> 这是"上架"能力的落地形态，不是做一个 skill 商店 UI。
> 基准实现参考 `business/attribution/registry/tool.js` 的 `attributionToolDefinition()`。

---

## 1. 两个注册层

一个 skill 要真正能被对话链路调用，需要同时落在两个层：

| 层 | 落点 | 作用 | 调用函数 |
|----|------|------|----------|
| **Shell 目录层** | `shell/tools/registry.cjs` | 上架目录 / 权限校验 / 调用日志 / 工具清单接口（`GET /api/tools`） | `registerTool(toolDefinition)` |
| **DSH 运行时层** | `shell/persistent-runner.mjs` 的 `setup(agentCtx)` | 暴露给模型，真正触发 `tool/call → tool/result` 轨迹 | `agentCtx.tools.register(defineTool({...}))` |

两层用 **同一个 `name`** 对齐。Shell 层负责"谁能用、怎么记账、清单怎么展示"；DSH 层负责"模型怎么调、参数怎么校验、结果怎么渲染"。

---

## 2. Shell 层：`registerTool(toolDefinition)`

签名：`registerTool(toolDefinition) → boolean`（注册失败会 `throw`）。

### 2.1 必填字段

`toolDefinition` 必须包含以下 8 个字段，缺一即抛 `工具定义缺少必要字段`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 全局唯一工具名，建议 `域.动作`，如 `attribution.query` / `get_current_time` |
| `type` | `string` | 工具类型，如 `workflow` / `utility` |
| `version` | `string` | 语义化版本，如 `1.0.0` |
| `description` | `string` | 一句话说明用途（会进工具清单，也建议写进 DSH `defineTool` 给模型看） |
| `inputSchema` | `object` | JSON Schema，描述入参 |
| `outputType` | `string` | 输出类型，目前约定 `data` |
| `riskLevel` | `string` | 风险级别，如 `read` / `write` |
| `requiredPermissions` | `string[]` | 调用所需权限（见 §4），如 `[PERMISSIONS.TOOL_USE]` |

### 2.2 可选字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `requiredCredentials` | `string[]` | 额外凭证声明，如 `["attribution-data:read"]` |
| `execute` | `async (args, context) => any` | 真实执行函数。注册时直接内联，等价于注册后再调 `registerToolExecutor(name, fn)` |

### 2.3 绑定执行函数

两种等价方式：

```js
// 方式一：注册时内联 execute
registry.registerTool({
  name: "get_current_time",
  /* ...其余必填字段... */
  execute: async (args, ctx) => ({ now: new Date().toISOString() }),
});

// 方式二：注册后单独绑定（先 registerTool 再 registerToolExecutor）
registry.registerTool(toolDef);                 // toolDef 里不带 execute
registry.registerToolExecutor("get_current_time", async (args, ctx) => ({ now: new Date().toISOString() }));
```

> 执行函数签名统一为 `async (args, context) => 可序列化结果`。`context` 由 `executeTool` 透传，包含 `userId / tenantId / workspaceId`。

---

## 3. DSH 层：`defineTool({...})`

注册位置：`agents.create({ ..., setup: (agentCtx) => { agentCtx.tools.register(defineTool({...})) } })`。

`defineTool` 从 `@deepseek-ai/dsh-tools` 导入。

### 3.1 最小必要字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 与 Shell 层 `name` 一致 |
| `description` | `string` | 给模型看的触发说明（何时用这个工具） |
| `parameters` | `object` | JSON Schema（DSH 用 `parameters`，Shell 层叫 `inputSchema`，语义一致） |
| `output.schema` | `object` | 输出的 JSON Schema |
| `output.render` | `(args, value) => ContentBlock[]` | 把执行结果渲染成文本块，如 `[{ type: "text", text: String(value.now) }]` |
| `execute` | `async (args) => value` | 真实执行，返回 canonical value（会交给 `output.render` 渲染） |

### 3.2 可选字段

`timeoutMs`（超时）、`isConcurrencySafe`（是否并发安全）、`presentCall`（展示定制）。

---

## 4. 权限模型

- `requiredPermissions` 里的每个权限，在 `executeTool()` / `listToolsForWorkspace()` 里经 `checkPermission({userId, tenantId}, permission)` 校验。
- `checkPermission` 查 `users.role`，映射到 `ROLE_PERMISSIONS`（`shell/permissions/index.cjs`）。
- 若声明的权限不在 `PERMISSIONS` 里，`registerTool` 会自动登记并默认授予 `owner` / `admin`。
- 常用权限常量：`PERMISSIONS.TOOL_USE`（`"tool.use"`）、`PERMISSIONS.ATTRIBUTION_READ`（`"attribution:read"`）等。

---

## 5. 完整示例：`get_current_time`（M1 demo）

### Shell 层（`shell/server.cjs` 里注册）

```js
const { PERMISSIONS } = require("./permissions/index.cjs");
toolsRegistry.registerTool({
  name: "get_current_time",
  type: "utility",
  version: "1.0.0",
  description: "返回当前精确时间（ISO 8601）。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputType: "data",
  riskLevel: "read",
  requiredPermissions: [PERMISSIONS.TOOL_USE],
  execute: async () => ({ now: new Date().toISOString() }),
});
```

### DSH 层（`shell/persistent-runner.mjs` 的 `setup` 里注册）

```js
import { defineTool } from "@deepseek-ai/dsh-tools";

agentCtx.tools.register(defineTool({
  name: "get_current_time",
  description: "返回当前精确时间（ISO 8601 字符串）。当用户询问「现在几点 / 当前时间」时使用此工具。",
  parameters: {},
  output: {
    schema: { type: "object", properties: { now: { type: "string" } }, additionalProperties: false },
    render: (_args, value) => [{ type: "text", text: String(value.now) }],
  },
  async execute() {
    return { now: new Date().toISOString() };
  },
}));
```

---

## 6. 字段对照速查

| 概念 | Shell `registerTool` | Contract（`tool-registration.json`） | DSH `defineTool` |
|------|----------------------|--------------------------------------|------------------|
| 名称 | `name` | `name` | `name` |
| 类型 | `type` | `type` | — |
| 版本 | `version` | `version` | — |
| 描述 | `description` | `description` | `description` |
| 入参 Schema | `inputSchema` | `inputSchema` | `parameters` |
| 输出类型 | `outputType` | `outputType` | — |
| 风险级别 | `riskLevel` | `riskLevel` | — |
| 所需权限 | `requiredPermissions` | `requiredPermissions` | — |
| 所需凭证 | `requiredCredentials` | `requiredCredentials` | — |
| 输出 Schema | — | — | `output.schema` |
| 输出渲染 | — | — | `output.render` |
| 执行函数 | `execute` / `registerToolExecutor` | — | `execute` |

> Contract（`business/attribution/contracts/tool-registration.json`）的 `required` 字段与 Shell 层必填字段一致，可作为业务线工具定义的 JSON Schema 校验来源。
