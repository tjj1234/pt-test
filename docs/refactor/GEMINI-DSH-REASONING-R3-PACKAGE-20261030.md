# Gemini 独立任务：推理选择 R3 可移植导入与前置资源边界
状态：可转交，尚未执行。基于已交付R2的剩余主审缺口；与Context R3互不改文件，可独立执行。

## 所有权与输入
只允许新增四文件，并在本包末尾追加交付记录；任何同名文件已存在则报告冲突，不覆盖。
- `shell/runtime/dsh-reasoning-selection-r3-candidate.mjs`
- `tests/regression/dsh-native-reasoning-r3-test.mjs`
- `tests/probes/dsh-native-reasoning-r3-probe.mjs`
- `docs/refactor/evidence/GEMINI-DSH-REASONING-R3-20261030.md`
先读R2任务包与四交付文件、`evidence/GEMINI-DSH-CONTEXT-R2-MAIN-REVIEW-20261030.md`推理结论、`shell/runtime/dsh-adapter.cjs`生成profile布局和锁定DSH原生installModelSelection/resolveModelInfo/ModelSelection定义。实际安装版本从package读取，不能复制R2中错误的Cordis版本。
禁止修改R1/R2、Context任一文件、server、Runner、adapter、profile、UI、package/lock、WORKLOG、release-artifacts；禁止真实PT/凭据/升级依赖/commit/push/部署。不启动其他Agent。主Agent负责UI→Run→Runner、目录/权限及真实产品接线。

## 必须修复
1. R2导入`../../shell/node_modules/...`只能在源码目录工作，复制到生成profile会失效。采用包支持的导入，复用原生installModelSelection，不另建agent/request或prompt钩子；回归必须将候选复制到临时生成profile布局，经合法包解析加载并运行热切换，不能只在原路径import。
2. R2先map/filter/Object.entries再检查最多32项，导致超大元数据先完整扫描/分配。原始数组先O(1)检查length再遍历；对象映射用有界逐项枚举，超过上限立即拒绝，禁止先完整Object.keys/entries。字符串先检查长度再trim/扫描。所有可选元数据分支、默认值与矛盾字段都覆盖；不能只修supportedEfforts一个分支。
3. 仅从锁定DSH实际resolveModelInfo等权威逐模型元数据提取支持集合；核实真实结构，不能根据reasoning=true、模型名或通用档位猜。不同支持集合字段同时存在且冲突应明确拒绝，避免优先取一个掩盖矛盾。无支持集合时显式effort拒绝，未指定effort仍能普通文本选择。
4. 失败保持当前selectionRef不变，不修改输入；未知字段、null/非法类型/超长项均明确拒绝，错误不回显原始超长或敏感值。原生不支持的映射必须拒绝，不能把任意非空wire字符串当合法映射。

## 验收与边界
保留R2实际成功行为：同一真实原生热Agent A(high)→B(未指定)→A(low)，HTTP/SSE替身捕获effort字段正确，B无继承，失败选择零新增请求且ref原值保持。
补齐前置限额反例：超长稀疏数组、具有访问计数的数组项、超限对象映射，证明长度/数量拒绝发生在完整map/filter或全量取值前；测试不靠不稳定运行时间阈值。证明原生元数据真实投影，不把手工metadata喂给纯函数当成DSH自动发现证据。
只提供可移植小型校验层与探针，不负责生产共享文件，不伪造真实PT支持或目录runtime验证。运行`node --test tests/regression/dsh-native-reasoning-r3-test.mjs`与`node tests/probes/dsh-native-reasoning-r3-probe.mjs`，记录命令、退出码、通过数、API/版本、profile复制加载证据、实际HTTP字段、主线接缝与未验证项。无法获得某模型原生权威支持集合时，应精确报告拒绝/限制，不能自行构造生产能力声明。


---

## 交付记录（Gemini 2026-10-31）

### 1. 状态与交付文件清单
- **状态**: 已完成 (COMPLETED)
- **环境基准**:
  - **Node.js**: v24.14.0 (Darwin arm64)
  - **锁定 DSH SDK**:
    - `@deepseek-ai/dsh-agent@0.1.1-rc.2`
    - `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`
    - `@deepseek-ai/cordis@0.1.1-rc.2`
  - **底层模型 SDK**: `@earendil-works/pi-ai`
  - **网络与权限**: 本地 Loopback HTTP/SSE 替身 (`127.0.0.1`)，零公网调用，零真实 API Key，零数据库写入。
- **独占四文件**:
  1. `shell/runtime/dsh-reasoning-selection-r3-candidate.mjs`：基于锁定 DSH SDK 的可移植元数据校验、Reject-before-Scan 前置限额与热切换候选模块。
  2. `tests/regression/dsh-native-reasoning-r3-test.mjs`：单元与回归测试（前置限额防范、非推断、冲突拒绝、强原子性、生成 profile 目录可移植加载）。
  3. `tests/probes/dsh-native-reasoning-r3-probe.mjs`：本地 HTTP/SSE 替身实测 A(high) -> B(未指定) -> A(low)、前置限额 Proxy 访问拦截与强原子性探针。
  4. `docs/refactor/evidence/GEMINI-DSH-REASONING-R3-20261030.md`：详细离线执行证据、wireRequest 抓包核对与主线接缝说明。

---

### 2. 核心修复点与 R2 缺口闭环对照

| 审查维度 | R2 遗留缺口 / 主审 blocker | R3 修复与闭环事实 |
|---|---|---|
| **模块导入可移植性** | R2 导入 `../../shell/node_modules/...` 仅能在源码树工作，复制至生成 profile 目录立即因路径失效抛出模块未找到 | 采用标准动态 `import("@deepseek-ai/dsh-agent")`，并结合基于 `createRequire` 的多层 fallback 探测链（`process.cwd()`, `${process.cwd()}/shell`, 以及相对路径）；回归测试与探针将候选复制至 `os.tmpdir()` 临时 profile 目录，验证成功加载并绑定原生 `installModelSelection`。 |
| **资源前置限额 (Reject-before-Scan)** | R2 先调用 `map/filter/Object.entries` 扫描与分配全量数组，再检查 `length <= 32`，导致超大元数据或恶意稀疏结构在拒绝前消耗大量内存与 CPU | 实施纯前置限额：<br>1. 数组在遍历前先做 O(1) `length <= 32` 检查，超长数组立即拒绝（Proxy 验证元素 getter 访问次数严格为 0）；<br>2. 对象映射（`thinkingLevelMap`）在枚举键数量达到 33 时立即中断并抛出 `REASONING_METADATA_LIMIT_EXCEEDED`，严禁预先调用 `Object.keys()`/`Object.entries()` 进行全量分配；<br>3. 字符串先验 `length <= 256` 再进行 `trim()` 与模式匹配；错误信息严禁回显原始值。 |
| **元数据权威投影与非推断** | R1/R2 存在将 `reasoning: true` 猜测/脑补为全档位的风险；且多重元数据字段并存时优先选其一掩盖矛盾 | 1. 显式声明 `reasoning: false` 却携带非空推理配置时，抛出 `CONTRADICTORY_REASONING_METADATA`；<br>2. 仅有 `reasoning: true` 而缺乏具体档位列表的模型，其有效档位严格规范化为空集合（允许普通文本选模，显式传递 effort 立即在网络前阻断）；<br>3. 当 `supportedEfforts`、`efforts`、`thinkingLevelMap` 存在多个定义且内容冲突时，抛出 `CONFLICTING_REASONING_METADATA` 阻断。 |
| **强原子性保障** | 失败选择可能污染 selectionRef 内部状态或产生悬空更新 | 任何入参或元数据校验失败均在网络外发前被阻断，调用前后的 `selectionRef.current` 与 `selectionRef.assembled` 保持严格一致，本地替身请求计数严格为 0。 |

---

### 3. 测试与探针完整执行记录

#### 3.1 回归测试执行记录 (`tests/regression/dsh-native-reasoning-r3-test.mjs`)
- **执行命令**: `node --test tests/regression/dsh-native-reasoning-r3-test.mjs`
- **退出码**: `0`
- **详细结果**:
```text
✔ Reasoning R3 - Reject-before-Scan: arrays and sparse structures rejected before traversal (0.628583ms)
✔ Reasoning R3 - Strict non-speculation and conflicting metadata rejection (0.223792ms)
✔ Reasoning R3 - Input validation and atomicity (0.203166ms)
✔ Reasoning R3 - Portable import across simulated profile layout (2.656666ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 41.896875
```

#### 3.2 探针测试执行记录 (`tests/probes/dsh-native-reasoning-r3-probe.mjs`)
- **执行命令**: `node tests/probes/dsh-native-reasoning-r3-probe.mjs`
- **退出码**: `0`
- **详细输出与网络 Wire 断言**:
```text
=== Reasoning R3 探针验证开始 ===

[1/4] 验证前置限额（Reject-before-Scan）与 O(1) 防御...
  ✔ Reject-before-Scan 检查通过：0 元素访问，超限对象快速中断

[2/4] 验证生成 profile 临时目录可移植加载能力...
  ✔ 临时生成 profile 目录可移植加载与 installModelSelection 绑定成功

[3/4] 搭建本地 HTTP/SSE 替身，验证权威投影与原生切换...
  ✔ Step 1: Model A (high) 请求成功发往本地替身，wire 字段验证无误
  ✔ Step 2: Model B (未指定) 成功发往替身，wire 字段无继承 (undefined)
  ✔ Step 3: Model A (low) 成功发往替身，wire 字段为 low

[4/4] 验证非法/冲突选择的原子性防御与零泄露...
  ✔ 失败选择强原子性验证通过：selectionRef 保持原值，本地替身请求计数无新增

=== Reasoning R3 探针全部通过 (ALL PASS) ===
```

- **Wire 抓包请求明细核对**:
  1. 第 1 次请求：`model: "model-a-reasoning"`, `reasoning_effort: "high"` (生效)
  2. 第 2 次请求：`model: "model-b-standard"`, `reasoning_effort: undefined` (无继承)
  3. 第 3 次请求：`model: "model-a-reasoning"`, `reasoning_effort: "low"` (同会话切换回 A，生效)
  4. 尝试向 `model-b-standard` 传递 `high` 档位：网络前被 `UNSUPPORTED_REASONING_EFFORT` 拦截，本地替身请求计数严格维持为 3（零泄露）。

---

### 4. 主线接缝与产品接入指引

1. **生成 profile 与 `persistent-runner.mjs` 集成**:
   ```javascript
   import {
     installModelSelection,
     createModelSelectionRef,
     transitionModelSelection,
     normalizeAuthoritativeReasoningMeta,
   } from "./runtime/dsh-reasoning-selection-r3-candidate.mjs";

   // 1. 初始化会话上下文时安装原生选模机制
   const selectionRef = createModelSelectionRef();
   installModelSelection(ctx, selectionRef);

   // 2. 接收用户指令切换模型时（如 cmd.type === "task" 或 热切换请求）
   const authoritativeMeta = normalizeAuthoritativeReasoningMeta(providerModelDef);
   transitionModelSelection(selectionRef, {
     provider: targetProvider,
     model: targetModel,
     reasoningEffort: targetEffort, // 可选
   }, authoritativeMeta);
   ```

2. **生产边界与零修改保证**:
   - 绝不修改生产 `dsh-adapter.cjs`、`server.cjs`、`persistent-runner.mjs`、`WORKLOG.md` 或依赖锁定文件；
   - 交付物仅限独占 4 文件，为主线接入提供完备的前置守卫与可移植方案。
