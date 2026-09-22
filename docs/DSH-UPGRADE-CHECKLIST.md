# DSH 真实验证报告（B1 · DSH Upgrade Checklist）

> 分支：`feature/base-b1-dsh-live-verify`
> 日期：2026-09-22
> 结论：**真实 DSH Adapter 契约验证 —— 23/26 契约断言通过，3 项失败；冒烟 10/11 通过，1 项失败。**

---

## 1. 验证目标与范围

本任务用一把有余额的真实 PowerTokens key，把 `tests/regression/runtime-contract-test.mjs`
的 26 个契约测试语义，映射到**真实 `shell/runtime/dsh-adapter.cjs`**（不是 `mock-adapter.cjs`）
跑一遍，并追加一轮真实多轮对话冒烟。

- 只新增 `shell/runtime/dsh-live-contract-test.mjs`、`shell/runtime/dsh-live-smoke-test.mjs` 两个 runner。
- **未修改** `tests/regression/runtime-contract-test.mjs`、`shell/runtime/dsh-adapter.cjs`、`shell/runtime/mock-adapter.cjs`、`shell/runtime/contract.cjs`、`shell/persistent-runner.mjs`、对话业务逻辑。
- 未改动任何 `business/`、`analytics/` 下的文件。

---

## 2. 验证环境

| 项 | 值 |
|---|---|
| Node | `D:\trae001\.tools\node-v24.18.1-win-x64\node.exe`（v24.18.1） |
| DSH 入口 | `C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| DSH 版本 | `@deepseek-ai/dsh@0.1.1-rc.2`（复用本机 workbuddy pnpm 已装版本，绕过 shell 本地 npm install） |
| Provider | `powertokens`（`api: openai-completions`，`baseURL: https://api.powertokens.ai/v1`） |
| 默认模型 | `deepseek-v4-pro`（来自 `shell/dsh-settings.yaml` 的 `agent-default-model`） |
| PT key | 通过环境变量 `DSH_LIVE_PT_KEY` 注入 → adapter 转为 `POWERTOKENS_API_KEY`，不落盘 |
| 临时目录 | `os.tmpdir()` 下独立目录，测试结束进程退出，不污染仓库 |

---

## 3. 验证方法

### 3.1 契约测试（26 项）

`shell/runtime/dsh-live-contract-test.mjs` 把源测试的 26 个 `ok()` 断言逐段映射：

| 段 | 内容 | 数量 |
|---|---|---|
| S1 | `contract.cjs` 校验（validateRuntime / assertRuntime / RUNTIME_METHODS） | 5 |
| S2 | `normalize*` 归一化（纯函数） | 4 |
| S3 | 真实 DSH ok / 流式 / fresh（映射 mock ok 模式） | 5 |
| S4 | 热会话：同 `sessionKey` 复用（fresh=false） | 1 |
| S5 | error / 空问题 / timeout 模式映射 | 3 |
| S6 | abort 中途停止（`job.abort()` + `runtime.abort(sessionKey)`） | 3 |
| S7 | `closeSession` 重置会话（冷启动 fresh=true） | 1 |
| S8 | persona 注入路径 | 1 |
| S9 | mock 与真实 adapter 形状可互换 | 3 |

合计 26 项。

### 3.2 冒烟测试（真实多轮对话）

`shell/runtime/dsh-live-smoke-test.mjs` 用单一 `sessionKey=smoke-s1` 跑 4 轮：

1. 冷启动：叫模型记住「我叫小明」。
2. 热会话：问「我叫什么名字？」，断言回复含「小明」（多轮记忆）。
3. 继续追问：一句话总结对话。
4. `closeSession` 后冷启动：再问名字，验证会话重置。

---

## 4. 结果

### 4.1 契约测试结果

**23 通过 / 3 失败（26 项）**

通过项覆盖：
- 契约校验、归一化（S1/S2）全部通过；
- 真实 DSH 冷启动 `fresh=true`、返回非空文本、流式 `delta`（34 个增量回调）通过；
- 热会话复用 `fresh=false` 通过；
- 无效 key → `ok=false + error`（`token_invalid`）通过；
- 空 question 不崩溃通过；
- 极小 `timeoutMs` → `code=TIMEOUT` 通过；
- persona 注入正常返回通过；
- mock 与真实 adapter 方法集一致（可互换）通过。

### 4.2 冒烟测试结果

**10 通过 / 1 失败（11 项，含 1 软观察）**

| 轮 | 结果 |
|---|---|
| 轮 1 冷启动 | `fresh=true`，`delta=63`，`ok=true` ✅ |
| 轮 2 热会话 | `fresh=false`，回复含「小明」，多轮记忆生效 ✅ |
| 轮 3 追问 | `ok=true`，总结正确 ✅ |
| 轮 4 closeSession 后 | `ok=true`，模型确实忘记名字（会话重置生效）✅；但 `fresh=false` ❌ |

---

## 5. 失败项根因分析（3 项契约 + 1 项冒烟，实为 2 类缺陷）

### 缺陷 A：abort 不产生 `stopped=true`

契约失败 2 项：
- `job.abort()` 中途 → 期望 `stopped=true`，实际 `stopped=false ok=true`
- `runtime.abort(sessionKey)` → 期望 `stopped=true`，实际 `stopped=false ok=true`

根因（`shell/runtime/dsh-adapter.cjs` + `shell/persistent-runner.mjs`）：

1. **`runtime.abort(sessionKey)` 未映射真实 sessionId**（`dsh-adapter.cjs` `abort()`，第 371-380 行）：
   `abort(sessionKey)` 直接把 `sessionKey` 当作 DSH `sessionId` 发送，而真实 sessionId 是
   `run()` 冷启动时生成的 `sessionKey + "-" + randomBytes(6)`。DSH 侧 `agentMap.get("abort-2")`
   查不到，只回 `{type:"aborted", note:"no-agent"}`，任务照常跑完。
   → 对比 `closeSession()`（第 382-393 行）已通过 `warmSessions` 映射到真实 `dshSid`，`abort()` 缺失同样的映射。

2. **`job.abort()` 的本地 `stopped` 标志未传导到结果**（`dsh-adapter.cjs` `run()` 第 300-315 行）：
   `job.abort()` 只设置 `this.stopped = true` 并发 `abort`，但该本地标志在 promise 的
   `resolve` 中未被读取；结果 `stopped` 完全依赖 DSH 侧后续 `done` 帧的 `canceled` 字段。

3. **`dispatchFrame` 无 `case "aborted"`**（`dsh-adapter.cjs` 第 154-186 行）：
   `persistent-runner.mjs` 的 `handleAbort` 会回 `{type:"aborted"}`，但 adapter 的
   `dispatchFrame` 没有处理该帧，导致即便取消成功，adapter 也无法据此立即以 `stopped=true` 收尾。

4. **`agent.cancel({kind:"user"})` 未能可靠打断进行中的 turn**（`persistent-runner.mjs`
   `handleAbort`，第 156-165 行）：实测 `done` 帧仍以 `ok=true`、`canceled=false` 返回，
   说明该版本的 `agent.cancel` 对正在 `followup()/whenIdle()` 的流式 turn 未生效。

> 影响：用户点「停止」时，SSE 不会立即结束，模型可能继续把整段回复跑完。

### 缺陷 B：`closeSession` 后 `fresh` 语义错误

契约失败 1 项 + 冒烟失败 1 项（同一根因）：
- `closeSession` 后再次 `run` → 期望 `fresh=true`（冷启动），实际 `fresh=false`

根因（`shell/runtime/dsh-adapter.cjs` `run()`，第 276-368 行）：
`run()` 返回的 `fresh` 直接取自 `getOrSpawnProcess()` 的**进程级** fresh（是否新建进程），
而不是**会话级** fresh（`!warm`）。`closeSession` 后进程仍存活（`fresh=false`），即便
`warmSessions` 已删除、真实 sessionId 已重新生成（DSH 侧确实冷启动），返回的 `fresh` 仍是 `false`。

冒烟第 4 轮佐证了这一点：模型确实忘记了「小明」（DSH 侧会话已重置），但返回的 `fresh=false`
与契约语义（`closeSession 后下次 run 冷启动`）不符。

> 影响：业务壳若依赖 `fresh` 判断是否重放历史，`closeSession` 后可能错误地不注入历史。

---

## 6. DSH 升级检查清单（Upgrade Checklist）

以下为上线前需在 `shell/runtime/` 内修复的项（本任务仅记录，不修复）：

- [ ] **`abort(sessionKey)` 映射真实 sessionId**：复用 `warmSessions` 查 `dshSid`，与 `closeSession()` 对齐。
- [ ] **`job.abort()` 传导 stopped**：让 `job.abort()` 直接以 `stopped=true` resolve waiter，而非依赖 DSH `done` 帧。
- [ ] **`dispatchFrame` 增加 `case "aborted"`**：DSH 回 `aborted` 时，立即 resolve 对应 waiter 为 `stopped=true`。
- [ ] **验证 `agent.cancel` 是否真正打断 turn**：若该版本 DSH 的 cancel 无效，需在 `persistent-runner.mjs` 侧改用可打断的停止机制。
- [ ] **`fresh` 改为会话级语义**：`run()` 返回 `fresh: !warm`，使 `closeSession` 后冷启动正确上报 `fresh=true`。

---

## 7. 结论

真实 `dsh-adapter.cjs` 的核心对话通路（冷/热会话、流式 delta、多轮记忆、错误处理、超时、
persona、进程复用、会话重置）均**真实验证通过**。存在 **2 类契约缺陷**（abort 不停止、
closeSession 后 fresh 语义错误），已在上文定位根因并列入升级检查清单，建议在后续任务
（B4/B2/B3 或专门的 DSH 修复项）中处理。本报告范围内未改动任何实现文件。

## 8. 复现方式

```powershell
# 契约测试（26 项）
$env:DSH_LIVE_PT_KEY = "<真实 PT key>"
node shell/runtime/dsh-live-contract-test.mjs

# 多轮冒烟
$env:DSH_LIVE_PT_KEY = "<真实 PT key>"
node shell/runtime/dsh-live-smoke-test.mjs
```

> 注意：DSH 入口 `bin.js` 默认指向本机 workbuddy 安装路径，可用环境变量 `DSH_LIVE_ENTRY` 覆盖；
> 模型可用 `DSH_LIVE_MODEL` 覆盖（默认 `deepseek-v4-pro`）。
