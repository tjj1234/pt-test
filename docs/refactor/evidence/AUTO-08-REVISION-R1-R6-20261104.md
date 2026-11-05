# 原08配置化任务模型路由局部修正报告 (R1-R6)
2026-11-04｜结论：**REVISION_DELIVERED / READY_FOR_RE_REVIEW**。
根据主审报告 [`AUTO-08-MAIN-REVIEW-20261104.md`](AUTO-08-MAIN-REVIEW-20261104.md) 的独立审核反例与门禁要求，已在独立隔离修复分支 `fix/auto-08-r1-r6` 完成对 R1–R6 的精确修正、契约澄清与测试预期纠正。当前共享工作区被冻结待审的原文件未直接覆盖，08 任务包正文未重写。

---

## 1. 独立修复分支与补丁信息

| 项目 | 记录 |
|---|---|
| 独立修复分支 | `fix/auto-08-r1-r6` |
| 基础提交 (Base) | `bbd9997` (与主线交接点完全一致) |
| 修复提交 (Tip) | `0c8841c` (`fix(auto-08): resolve R1-R6 review defects in isolated fix branch`) |
| 独立补丁文件 | [`docs/refactor/evidence/AUTO-08-REVISION-R1-R6-20261104.patch`](AUTO-08-REVISION-R1-R6-20261104.patch) |
| 机器执行结果 | [`docs/refactor/evidence/AUTO-08-REVISION-R1-R6-20261104.json`](AUTO-08-REVISION-R1-R6-20261104.json) |

### 修复分支文件 SHA256

```
552ff787b097c0b54de266c0bed3bebcf236ff6bd96e262215faca3ac46e848b  shell/candidates/auto-20261103/CONTRACT.md
a138f98ba63e40317cff7e0fe5c496f3c62f224820cdd0a48e43bf17cbd3f73c  shell/candidates/auto-20261103/index.cjs
2f2ecc12ca53b197b0a181f075cc703b403a9a81ca8dd7bf342fe1d78de07276  tests/probes/auto-delivery-20261103.mjs
6bd219f6f8ab442935cabf598123c6a4e4923d30d38bb9ee17e10aa252361b6b  tests/probes/auto-08-main-review-20261104.mjs
```

---

## 2. 逐项回应与修复细节 (R1–R6)

| 审核项 | 级别 | 缺陷表现与主审要求 | 修复落地措施 | 独立探针复测验证 |
|---|---|---|---|---|
| **R1** | **P1阻断** | 未知费用被跳过选次优或 fallback；CONTRACT 承诺未产生 UNKNOWN_PAYMENT_RESULT；原探针把跳过当 PASS | 显式区分调用前资格拒绝与执行结果未知。在遍历前置先探测 `reason`：若匹配 `PAYMENT_UNKNOWN` 或 `UNKNOWN_PAYMENT_RESULT`，立即终止并返回 `{ ok: false, code: 'UNKNOWN_PAYMENT_RESULT' }`。修正原探针第12组断言为终止 | **R1-01 / R1-02 PASS** |
| **R2** | **P1阻断** | dispatched 检查不全，primary 数组内后续模型及 manual 模式仍可被选中 | 在任何选择分支前执行统一状态门禁：`dispatchState === 'dispatched'` 时，一律返回 `{ ok: false, code: 'FALLBACK_AFTER_DISPATCH' }`，严禁已发尝试改选模型 | **R2-01 / R2-02 PASS** |
| **R3** | **P1门禁** | dispatchState=unknown 被当 pre-dispatch，未识别 selection.mode 被当 auto | 严格枚举校验：`dispatchState` 仅允许 `'pre-dispatch' \| 'dispatched'`；`selection.mode` 仅允许 `'auto' \| 'manual'`。非法显式值返回 `CONFIG_INVALID`，不默认放行 | **R3-01 / R3-02 PASS** |
| **R4** | **P2配置** | 仅验证 candidates 自身，fallback 自身重复及与 primary 重复未被拦截 | `validateRouteConfig` 建立全路由候选集合；检测 fallback 自身重复以及 fallback 与 candidates 交集重复，违者返回 `DUPLICATE_CANDIDATE` | **R4-01 / R4-02 PASS** |
| **R5** | **P2版本pin** | 空/全空白 `pinVersion: ""` 被接受；未透传绑定 | 校验非空非全空白；`selectModel` 成功结果中透传绑定的 `pinVersion`，为外部版本协调与模型 revision 校验提供可验证接缝 | **R5-01 PASS** |
| **R6** | **P2版本漂移** | 闭包持有外部 config 引用，外部对象突变改变 router 版本 | `createTaskRouter` 入口执行深度克隆与不可变绑定 (`JSON.parse(JSON.stringify(config))`)，router 内部逻辑及 `configVersion` 均读取隔离快照，外部突变不影响已绑定版本 | **R6-01 PASS** |

---

## 3. 测试与验证实证

### 独立主审探针 (`tests/probes/auto-08-main-review-20261104.mjs`)

```
PASS CTRL-01 原正常pre-dispatch选择首选
PASS CTRL-02 原pre-dispatch资格预筛可选fallback
PASS CTRL-03 原dispatched后的fallback分支确实被拦
PASS CTRL-04 所有资格false时不选模型
PASS R1-01 PAYMENT_UNKNOWN不能被跳过后选其他primary
PASS R1-02 显式UNKNOWN_PAYMENT_RESULT不能变成fallback
PASS R2-01 dispatched不能改选第二个primary
PASS R2-02 dispatched不能改选manual模型
PASS R3-01 未知dispatchState不能视为pre-dispatch
PASS R3-02 非法selection.mode不能默认为auto
PASS R4-01 重复fallback应被严格配置校验拒绝
PASS R4-02 primary与fallback重复模型应拒绝
PASS R5-01 空pinVersion不能被当有效版本pin
PASS R6-01 外部config突变不能使router与选择结果版本不同

评审探针结果: 14 项，14 通过，0 失败，退出码: 0
```

### 纠偏后的原交付探针 (`tests/probes/auto-delivery-20261103.mjs`)

```
执行结果: 26/26 项全部通过，0 项失败，退出码: 0
（第12组已从错误跳过预期纠正为未知付费终止拦截断言）
```

---

## 4. 主程序复审与集成建议

1. **主线接入**：主程序可随时通过 `git apply docs/refactor/evidence/AUTO-08-REVISION-R1-R6-20261104.patch` 或合入 `fix/auto-08-r1-r6` 分支落位修正。
2. **零费用外部确认**：如主审报告所述，真实执行失败后的重试协调（下一 attempt 的创建与零费用确认）由外层持久化协调器负责，选择器自身已实现 fail-closed 保护。
