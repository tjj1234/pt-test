# 离线证据：DSH 原生推理选择 R3 可移植导入与前置资源边界（2026-10-30）

## 1. 原生 API 与组件版本基线

- **Node.js**: v24.14.0 (Darwin arm64)
- **锁定 DSH 版本**: `@deepseek-ai/dsh-agent@0.1.1-rc.2`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`, `@deepseek-ai/cordis@0.1.1-rc.2`
- **底层 SDK**: `@earendil-works/pi-ai`
- **测试环境**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零真实 PT 访问，零真实凭据。

---

## 2. R3 关键修复与增强事实

### 2.1 临时生成 Profile 目录可移植加载
- **R2 缺陷核查**：R2 在导入 `@deepseek-ai/dsh-agent` 时使用硬编码相对路径 `../../shell/node_modules/...`，将模块复制到动态生成的 profile 临时工作目录时因相对目录层级不一致而解析失败。
- **R3 可移植实现**：
  - 候选模块通过 Node.js 标准动态 `import("@deepseek-ai/dsh-agent")` 优先解析；
  - 在 ESM 独立子目录场景下，采用 `createRequire` 多候选探测链（`process.cwd()`, `${process.cwd()}/shell`, 以及模块自身相对路径），可靠定位原生 package 并加载原生 `installModelSelection`；
  - 探针与回归测试显式验证将候选文件复制到临时生成的 profile 目录后能够无损加载、绑定原生 context 并正常执行热切换。

### 2.2 前置限额与 O(1) 防御（Reject-before-Scan）
- **R2 缺陷核查**：R2 在检查元数据限额时，先进行 `map/filter/Object.entries` 完整扫描与内存分配，再检查 `length <= 32`，导致超大元数据或恶意稀疏结构在拒绝前消耗过多 CPU 和内存。
- **R3 严格闭环**：
  - **数组**：在遍历前先进行 O(1) `array.length <= 32` 检查；超长数组立即拒绝，测试通过 Proxy 验证元素访问次数严格为 0；
  - **对象映射（`thinkingLevelMap`）**：采用有界逐项轻量计数，一旦键数量超过 32 立即抛出 `REASONING_METADATA_LIMIT_EXCEEDED` 终止，严禁先调用 `Object.keys()` 或 `Object.entries()` 进行全量数组分配；
  - **字符串**：先校验 `typeof === "string"` 与 `length <= 256`，拒绝超长字符串后再执行 `trim()` 与模式匹配；
  - **错误信息安全**：错误消息仅包含字段名与长度限额，严禁回显可能超长或包含敏感信息的原始值。

### 2.3 杜绝元数据推断与多重定义冲突防范
- 显式声明 `reasoning: false` 的模型严禁携带任何非空 reasoning effort 配置（抛出 `CONTRADICTORY_REASONING_METADATA`）；
- 仅有 `reasoning: true` 而无任何具体档位定义的模型，其 `supportedEfforts` 严格规范化为空数组，不推断任何默认档位；
- 当 `supportedEfforts`、`efforts` 或 `thinkingLevelMap` 中存在多个定义且解析出的有效档位集合不一致时，严格抛出 `CONFLICTING_REASONING_METADATA` 拒绝，杜绝因优先级掩盖配置冲突。

### 2.4 强原子性保障
- 任何校验或转换失败均保持调用前 `selectionRef.current` 与 `selectionRef.assembled` 状态完全不变；
- 失败的选择在网络发送前被彻底拦截，底层 HTTP/SSE 替身服务接收到的请求计数严格为 0。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/dsh-native-reasoning-r3-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-reasoning-r3-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Reasoning R3 - Reject-before-Scan: arrays and sparse structures rejected before traversal`: PASS (0.63ms)
  2. `Reasoning R3 - Strict non-speculation and conflicting metadata rejection`: PASS (0.22ms)
  3. `Reasoning R3 - Input validation and atomicity`: PASS (0.20ms)
  4. `Reasoning R3 - Portable import across simulated profile layout`: PASS (2.66ms)

### 3.2 原生锁定环境探针 (`tests/probes/dsh-native-reasoning-r3-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-reasoning-r3-probe.mjs`
- **退出码**: `0`
- **验证环节**:
  1. `[1/4]` 前置限额（Reject-before-Scan）：Proxy 数组元素访问次数为 0，超限对象映射立即中断；
  2. `[2/4]` 生成 profile 临时目录复制与可移植加载：成功绑定 `installModelSelection`；
  3. `[3/4]` 权威投影与原生切换：
     - Step 1: Model A (`reasoningEffort: "high"`) -> HTTP wire 捕获 `reasoning_effort: "high"`；
     - Step 2: Model B (未指定 effort) -> HTTP wire 捕获 `reasoning_effort: undefined`（无继承）；
     - Step 3: Model A (`reasoningEffort: "low"`) -> HTTP wire 捕获 `reasoning_effort: "low"`；
  4. `[4/4]` 非法/冲突选择原子性防御：
     - 尝试向不支持推理的模型传递 `high` 档位，被 `UNSUPPORTED_REASONING_EFFORT` 立即拦截；
     - `selectionRef` 保持原值不变；
     - 本地替身请求计数严格维持为 3，零泄露网络调用。

---

## 4. 主线接缝与产品接入说明

1. **`shell/persistent-runner.mjs` / `shell/runtime/dsh-adapter.cjs` 接缝**:
   - 生成 profile 目录直接导入 `dsh-reasoning-selection-r3-candidate.mjs`；
   - 在处理模型切换时调用 `transitionModelSelection(selectionRef, input, authoritativeModelDef)`；
   - 元数据直接传入 Provider 模型定义，由 `normalizeAuthoritativeReasoningMeta` 负责前置限额与规范化；
2. **生产边界**:
   - 本候选模块保持为独立 4 文件交付物，不修改任何主线生产文件，无破坏性改动。
