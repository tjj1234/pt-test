# 离线证据：DSH 原生推理选择 R2 严格元数据与接线候选验证（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**: `@deepseek-ai/dsh-agent@0.1.1-rc.2`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`, `@deepseek-ai/cordis@0.1.1-rc.2`
- **底层 SDK**: `@earendil-works/pi-ai`
- **测试环境**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零公网访问，零真实凭据。

---

## 2. R2 关键修复与增强事实

### 2.1 彻底消除元数据推断
- **R1 缺陷核查**：R1 在元数据仅包含 `reasoning: true` 时，自动推断并构造了 `["minimal", "low", "medium", "high"]`。主审明确指出该布尔值不能证明每档均被真实 PT 网关支持。
- **R2 严格闭环**：
  - 仅有 `reasoning: true` 而缺乏具体 `supportedEfforts`、`efforts` 或 `thinkingLevelMap` 列表的模型，其支持集合严格为空；
  - 允许作为普通文本模型选择，但任何显式指定 `reasoningEffort` 的尝试一律在网络前以 `UNSUPPORTED_REASONING_EFFORT` 拒绝；
  - 只有明确提供了逐模型支持列表或非空映射时，才允许通过对应档位。

### 2.2 严格复用锁定 DSH 原生 `installModelSelection`
- R2 **完全不再重写任何第二套 agent/request 或 prompt assembly 钩子**；
- 直接从 `@deepseek-ai/dsh-agent` 导入并重新导出原生的 `installModelSelection`，保持底层瀑布流拦截与 prompt 变量同步逻辑 100% 原生。

### 2.3 原子性切换与防篡改约束
- `transitionModelSelection(selectionRef, input, meta)` 在校验失败时直接抛出异常，**原 selectionRef 的 `current` 与 `assembled` 保持原样不变**；
- 对所有输入字段实施 O(1) 长度防范（<= 256 字符），拒绝未知额外字段、null 值与矛盾元数据（如 `reasoning: false` 却携带档位）；
- 严格保证调用方传入的入参对象不被篡改。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-reasoning-r2-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-reasoning-r2-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Reasoning R2 - Strict metadata normalization without speculation`: PASS
  2. `Reasoning R2 - Validation and boundary protections`: PASS
  3. `Reasoning R2 - Atomic transition failure leaves current ref intact`: PASS
  4. `Reasoning R2 - Hot session sequence A(high) -> B(unspecified) -> A(low) using native installModelSelection`: PASS

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-reasoning-r2-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-reasoning-r2-probe.mjs`
- **退出码**: `0`
- **探针执行指标**:
  - `wireRequestsCount`: `3`
  - 请求序列核对：
    1. `model-a-reasoning`: `reasoning_effort: "high"` (生效)
    2. `model-b-standard`: 无 `reasoning_effort` 字段 (确认 B 绝无继承 A 的 effort)
    3. `model-a-reasoning`: `reasoning_effort: "low"` (同会话切换回 A，指定 low 生效)
  - 仅带 `reasoning: true` 的模型（无具体支持列表）在尝试显式传递 effort 时被网络前严格阻断（抛出 `UNSUPPORTED_REASONING_EFFORT`），本地请求计数严格保持为 3（零外发）。

---

## 4. 主线接缝与产品接入说明

1. **`shell/persistent-runner.mjs` 接缝**:
   - 在处理 `cmd.type === "task"` 选模时，调用 R2 的 `validateAndBuildModelSelection`：
     ```javascript
     const { validateAndBuildModelSelection, installModelSelection } = require("./runtime/dsh-reasoning-selection-r2-candidate.mjs");
     // 从权威元数据注册表获取 targetMeta（若无精确列表则传空对象，防止盲目开启 effort）
     selection.current = validateAndBuildModelSelection({
       provider: cmd.provider || defaults.provider,
       model: cmd.model || defaults.model,
       ...(cmd.reasoningEffort ? { reasoningEffort: cmd.reasoningEffort } : {}),
     }, targetMeta);
     selection.assembled = void 0;
     ```
   - 现有的 `installModelSelection(agentCtx, selection)` 继续负责生命周期内的无缝流转。
2. **`shell/runtime/dsh-adapter.cjs` 接缝**:
   - 在 `run(spec)` 入参中允许传入合规校验后的 `spec.reasoningEffort` 并写入 `taskFrame`。

---

## 5. 未验证项声明
- 本次验证基于本地 localhost HTTP/SSE 替身与锁定环境。
- **未验证项**：真实 PT 网关 (`api.powertokens.ai`) 对不同推理模型具体思考档位（off/minimal/low/medium/high/xhigh/max）的线上接收与生效表现。真实产品级发布与全链路验收由主 Agent 完成。不得宣称 reasoningEffort 已在生产上线。
