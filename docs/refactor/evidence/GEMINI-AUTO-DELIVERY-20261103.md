# GEMINI-AUTO-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/auto-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**26/26 PASS, 0 FAIL**

| # | 测试项 | 结果 |
|---|--------|------|
| 1 | 正常路由：首选有资格选首选(model-a, source=primary) | ✔ PASS |
| 2 | 后备路由：首选无资格，选后备(model-c, source=fallback) | ✔ PASS |
| 3 | 无资格失败 (MISSING_ELIGIBLE_MODEL) | ✔ PASS |
| 4 | dispatch 后禁止切换后备 (FALLBACK_AFTER_DISPATCH) | ✔ PASS |
| 5 | 未配置 taskType (TASK_NOT_CONFIGURED) | ✔ PASS |
| 6 | 手动选择：在配置候选中且有资格 (source=manual) | ✔ PASS |
| 7 | 手动选择：模型不在配置中 (MANUAL_MODEL_NOT_IN_CONFIG) | ✔ PASS |
| 8 | 稳定性：相同输入5次调用相同输出 | ✔ PASS |
| 9 | 配置验证：重复 taskType 检测 | ✔ PASS |
| 10 | 配置验证：重复候选 ID (DUPLICATE_CANDIDATE) | ✔ PASS |
| 11 | 配置验证：空候选列表 | ✔ PASS |
| 12 | 付费结果未知 (QUOTA_EXHAUSTED)：跳过该模型选次优 | ✔ PASS |
| 13 | 非法配置 createTaskRouter 抛出 CONFIG_INVALID | ✔ PASS |

## 实现说明

- **配置驱动**：路由规则完全由 config 对象决定，代码无需修改
- **不验证资格**：只接收调用方提供的 `eligibilityResults`，不调用 capabilities.cjs
- **稳定选择**：按候选数组顺序线性扫描，无随机性
- **付费拦截**：eligibilityResult.reason 匹配 PAYMENT/BILLING/QUOTA_EXHAUSTED 时跳过
- **后备语义**：dispatchState='dispatched' 时后备路径直接返回 FALLBACK_AFTER_DISPATCH
- **多阶段路由**：`BLOCKED_MULTI_STAGE` - 未实现，不声称支持

## 文件 SHA256

```
1e2ebfe0efad5cecb20ecff151bc891aaeed738dfe6eb70ceba39377a0e9df2f  shell/candidates/auto-20261103/CONTRACT.md
d8875ac8a9fd2ee2427b81edc633a53b24a15b5a39c7c940f1798bfc9591fea9  shell/candidates/auto-20261103/index.cjs
795b2074afb736797f33d03724f758afaba480f1c16394494324ffe1026d5002  tests/probes/auto-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_MULTI_STAGE`: 多阶段路由（需显式预算/恢复契约）未实现

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (26/26 PASS)
- **INTEGRATION_PENDING** — 主线接缝：在 task-router.cjs 调用链之后，使用本候选 selectModel 叠加配置化选择层（由主 Agent 集成）
