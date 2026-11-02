# 离线证据：DSH 原生推理强度接线候选验证（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**: `@deepseek-ai/dsh-agent@0.1.1-rc.2`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`, `@deepseek-ai/cordis@0.1.1-rc.2`
- **底层推理 SDK**: `@earendil-works/pi-ai`
- **验证协议**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零公网调用、零真实凭据，零持久化入侵。

---

## 2. 原生接口与行为核查事实

1. **`installModelSelection(agentCtx, selectionRef)`**：
   - 位于 `@deepseek-ai/dsh-agent` 核心包中。
   - 挂载两个核心 Waterfall 监听器：
     - `system-prompt/assemble`: 在组装系统提示词时快照 `selection.current` 至 `selection.assembled`，并注入 `assembled.variables.provider` 与 `assembled.variables.model`。
     - `agent/request`: 在分派请求前，解构 `resolved` 丢弃任何 `reasoningEffort: _inheritedEffort`，严格重新组装 `provider`, `model`，且仅在 `selected.reasoningEffort !== undefined` 时追加 `reasoningEffort`。
2. **`PiAiAdapter` 与 `pi-ai` 协议传输**：
   - 在 `dsh-llm-pi-ai/PiAiAdapter.prototype.streamWithSnapshot` 中调用 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`。
   - 若模型未声明 reasoning 能力或请求了不支持的档位，直接抛出 `LlmError("... does not support reasoning effort ...", "UNSUPPORTED_REASONING_EFFORT")`，在发起任何网络请求前直接阻断。
   - 对于 `openai-completions` 协议且支持 reasoning 的模型，PiAiAdapter 将 `high/low/medium` 档位正确序列化到 HTTP POST 请求体顶层 `reasoning_effort`。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-reasoning-selection-candidate-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-reasoning-selection-candidate-test.mjs`
- **退出码**: `0`
- **通过测试数**: `5 / 5`
  1. `Reasoning Effort Candidate - Basic metadata normalization`: PASS
  2. `Reasoning Effort Candidate - Validation & input enforcement`: PASS (拒绝未知字段、非法值、不支持模型等)
  3. `Reasoning Effort Candidate - Hot session switching A -> B clears reasoningEffort`: PASS
  4. `Reasoning Effort Candidate - Model switch between different providers with identical model names`: PASS
  5. `Reasoning Effort Candidate - bindModelSelectionToContext parity with DSH installModelSelection`: PASS

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-reasoning-selection-candidate-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-reasoning-selection-candidate-probe.mjs`
- **退出码**: `0`
- **网络替身接收请求序列**:
  1. `model-reasoning`: `reasoning_effort: "high"` (生效)
  2. `model-standard`: `reasoning_effort: undefined` (切换后旧 effort 彻底清除，不泄漏)
  3. `model-reasoning`: `reasoning_effort: "low"` (同会话切换回 reasoning 模型，指定 low 生效)
  4. `model-standard` + 强传 `high`: 被原生适配器捕获抛出 `UNSUPPORTED_REASONING_EFFORT`，本地服务器接收请求计数保持为 3，未发出非法请求。

---

## 4. 主 Agent 最小接缝说明（生产入口接入建议）

现阶段本候选完全独立于生产文件。后续由主 Agent 接入主线时，建议最小修改点如下：

1. **`shell/persistent-runner.mjs` 接缝**:
   - 在 `RPC_CAPABILITIES` 中追加声明（如需要），并在 task frame 校验中支持接收可选字段 `reasoningEffort?: string`。
   - 在为 session 设置 `selection.current` 时：
     ```javascript
     selection.current = {
       provider: cmd.provider || defaults.provider,
       model: cmd.model || defaults.model,
       ...(cmd.reasoningEffort ? { reasoningEffort: cmd.reasoningEffort } : {}),
     };
     ```
   - 现有的 `installModelSelection(agentCtx, selection)` 即可自动负责 prompt variables 与 request config 的无缝同步与清理。
2. **`shell/runtime/dsh-adapter.cjs` 接缝**:
   - 在 `createDshRuntime` 的 `run(spec)` 中，允许 `spec.reasoningEffort` 传递到 `taskFrame` 发送给 runner。
3. **前端 UI 与会话快照**:
   - 前端选模卡片依据 `/v1/models` 或静态能力表展示可选思考强度；未选择或不支持时不输出 `reasoningEffort` 字段。

---

## 5. PT 生产网关未验证项声明

- 本离线验证使用本地模拟 HTTP/SSE 替身，仅验证了锁定 DSH 与 pi-ai 的接口行为和协议序列化。
- **未验证项**：真实 PT 网关 (`api.powertokens.ai`) 上各个具体模型对 `reasoning_effort` 字段的支持与接受情况（例如是否所有带思考的模型都接受顶层 `reasoning_effort`，抑或部分方言需要 `thinking: { type }`）。这些需要主 Agent 结合 PT 网关接口规范做最终线上验收。
