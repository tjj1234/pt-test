# M1 — 工具调用接线 + 用户隔离落地（阶段报告）

- 分支：`feature/base-m1-tool-wiring`
- 范围：`shell/runtime/`（`dsh-adapter.cjs` / `contract.cjs` / `persistent-runner.mjs`）、`shell/tools/registry.cjs#executeTool()`、新增工具调用日志表 + 接口
- 约束：本轮**不触碰** `business/attribution/`，用与业务无关的 demo 工具验证整条链路。

---

## 1. 交付物完成情况（按顺序）

| # | 交付物 | 状态 | 落点 |
|---|--------|------|------|
| 1 | 探针：确认 DSH 自定义工具接收格式 + 最小 demo 跑通 | ✅ | `shell/runtime/dsh-tool-probe.mjs` |
| 2 | skill 注册格式规范 | ✅ | `docs/SKILL-REGISTRATION-SPEC.md` |
| 3 | demo 工具按规范真实接入对话 | ✅ | DSH 侧 `persistent-runner.mjs` + Shell 侧 `server.cjs` |
| 4 | 工具清单接口 `GET /api/tools` | ✅ | `shell/server.cjs` |
| 5 | 调用日志表 + `GET /api/usage/tool-calls` | ✅ | `shell/db-migrations/007_tool_calls.sql` + `shell/tool-calls.cjs` + `shell/server.cjs` |
| 6 | `executeTool()` 按工具名真实分发 | ✅ | `shell/tools/registry.cjs` |
| 7 | 双 workspace 隔离验收 + 阶段报告 | ✅ | `tests/regression/m1-tool-wiring-test.mjs` + 本文档 |

---

## 2. 关键结论（探针，交付物 1）

- DSH 实际依赖为 `@deepseek-ai/dsh@0.1.1-rc.2`（非 `dsh-agent`），`persistent-runner.mjs` 由 `@deepseek-ai/dsh-base` bundle 加载。
- 自定义工具注册入口：在 `AgentRegistry.create({ sessionId, setup })` 的 `setup(agentCtx)` 回调里调用 `agentCtx.tools.register(defineTool({...}))`；`defineTool` 从 `@deepseek-ai/dsh-tools` 导入。
- `defineTool` 最小字段：`name` / `description` / `parameters` / `output.schema` + `output.render(_args, value)` / `execute(args)`。
- 工具事件轨迹精确形状：
  - `tool/call`：`data = { turn, step, callId, name, arguments }`（`arguments` 为 JSON 字符串）。
  - `tool/result`：`callId` 在 `message.source.callId`；文本在 `block.content[].text`；错误在 `block.isError`。
- 探针实测：**4/4 通过**（`run.ok=true`、真实 `tool/call`、真实 `tool/result`、最终文本非空）。
- 默认模型 `deepseek-v4-pro`，可用 `DSH_LIVE_MODEL=deepseek-v3-2-251201` 覆盖（历史配额/模型名问题已规避）。

---

## 3. skill 注册格式规范（交付物 2）

见 `docs/SKILL-REGISTRATION-SPEC.md`，要点：

- **两层注册**：Shell 侧 `registerTool({...})`（进入工具清单/权限/日志分发）+ DSH 侧 `defineTool({...})`（让模型真正能触发）。
- **Shell 必填字段**：`name / type / version / description / inputSchema / outputType / riskLevel / requiredPermissions`；可选 `requiredCredentials / execute`。
- 字段对齐 `business/attribution/registry/tool.js#attributionToolDefinition()` 与 `contracts/tool-registration.json` 的 required 字段。
- 内置示例 `get_current_time`（完整两层写法 + 字段对照速查表）。

---

## 4. 工具清单接口（交付物 4）

- `GET /api/tools` → 内部调用 `registry.cjs#listToolsForWorkspace(workspaceId, context)`，按调用者 workspace 过滤。
- 返回形状：`[{ name, type, version, description, inputSchema, outputType, riskLevel }]`。

---

## 5. 调用日志（交付物 5，安全红线）

- 表 `tool_calls`：`id / timestamp / tenant_id / workspace_id / user_id / tool_name / input_summary / output_summary / duration_ms / token_count / status`。
- `executeTool()` 分发真实执行前后各写一条（`started` → `completed/failed/skipped`）。
- `GET /api/usage/tool-calls?range=today|week|month`：默认只查当前 workspace；`toolCalls.list()` **永远**带 `workspace_id + tenant_id` 过滤；`range` 为滚动窗口（`today`=当天零点、`week`=近 7 天、`month`=近 30 天）。
- PT key 只经环境变量注入，未写入代码或日志。

---

## 6. executeTool() 真实分发（交付物 6）

- 从“返回硬编码模拟结果”改为：`validateToolCall` → 取 `toolExecutors.get(toolName)` → 写 `started` 日志 → 执行真实 executor（失败写 `failed` 并 rethrow，成功写 `completed`）→ 返回真实结果。
- 未注册 executor 时写 `status='skipped'`，不再伪造“模拟执行成功”。

---

## 7. 验收结果

- 探针：`dsh-tool-probe.mjs` **4/4 通过**（①真实 `tool/call`→`tool/result` 轨迹，非模拟文本）。
- 双 workspace 隔离：`tests/regression/m1-tool-wiring-test.mjs` **12/12 通过**，覆盖：
  - A/B 两个 workspace 各自触发 `get_current_time` 均返回正确 `now`（②）。
  - 各自清单均含该工具。
  - 各自 `toolCalls.list({tenantId, workspaceId, range:"today"})` 恒等于 1 条且 id 不重合（③互相看不到对方记录）。
  - 跨 tenant/workspace 的错误组合查询返回 0 条。

### 角色模型注意事项

- `auth.register()` 首个用户为 `admin`，其余为 `viewer`；`viewer` 默认只有 `WORKSPACE_CREATE`、无 `TOOL_USE`。
- 因此隔离验收改用“两个 tenant 各建一个 `admin` 用户”来验证红线，绕开 `viewer` 缺 `TOOL_USE` 对隔离验证的干扰（角色权限本身不在 M1 范围内）。

---

## 8. 未触碰 business/attribution/ 的证据

- `git diff --stat HEAD`：仅 4 个文件（`shell/permissions/index.cjs`、`shell/persistent-runner.mjs`、`shell/server.cjs`、`shell/tools/registry.cjs`），无 `business/` 路径。
- `git ls-files --others --exclude-standard business/attribution/`：无输出。
- `business/attribution/registry/tool.js` 与 `contracts/tool-registration.json` 仅作参考读取，未修改。

---

## 9. 遗留缺口（非阻塞）

- 旧测试 `tests/regression/tool-registry-test.mjs` 仍用假 UUID（`"test-user"` / `"test-tenant"`）查询 `users` 表，会报 `invalid input syntax for type uuid`。本次未改它，改用 `m1-tool-wiring-test.mjs`（真实临时库 + 真实 UUID）完成验收；该旧测试属技术债，后续需决定重写或跳过。
- `token_count` 目前固定写 `0`（DSH 事件未稳定暴露 token 数），字段已预留。

---

## 10. 本次提交文件清单（9 个）

修改：
- `shell/permissions/index.cjs`（新增 `setDb`，修复权限查询读错库）
- `shell/persistent-runner.mjs`（DSH 侧注册 `get_current_time` + `tool/result` 提取修复）
- `shell/server.cjs`（初始化顺序 + 3 条 M1 路由 + demo 工具注册）
- `shell/tools/registry.cjs`（真实分发 + 前后日志 + `setToolCallLogger`）

新增：
- `shell/tool-calls.cjs`
- `shell/db-migrations/007_tool_calls.sql`
- `shell/runtime/dsh-tool-probe.mjs`
- `tests/regression/m1-tool-wiring-test.mjs`
- `docs/SKILL-REGISTRATION-SPEC.md`
