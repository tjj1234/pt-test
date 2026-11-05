# CONTRACT: 配置化任务模型路由 (auto-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface TaskRouteConfig {
  routes: RouteEntry[];        // 有序路由规则列表
  version: string;             // 配置版本号，用于 pin
}

interface RouteEntry {
  taskType: string;            // 任务类型，对应 capabilities.cjs TASKS
  candidates: string[];        // 有序首选模型 ID 列表（按优先级降序）
  fallback?: string[];         // 后备模型 ID 列表（仅限首次 dispatch 前）
  pinVersion?: string;         // 模型版本 pin（可选）
}

interface SelectInput {
  taskType: string;
  eligibilityResults: EligibilityResult[];  // 来自现有门禁的结果，不自行验证
  selection?: { mode: 'auto' | 'manual'; modelId?: string };
  dispatchState?: 'pre-dispatch' | 'dispatched';  // 后备仅限 pre-dispatch
}

interface EligibilityResult {
  modelId: string;
  eligible: boolean;
  reason?: string;             // 不可用原因
}
```

## 输出 Schema

```typescript
interface SelectResult {
  ok: true;
  modelId: string;
  taskType: string;
  mode: 'auto' | 'manual';
  source: 'primary' | 'fallback' | 'manual';
  configVersion: string;
} | {
  ok: false;
  code: ErrorCode;
  detail?: string;
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `CONFIG_INVALID` | 配置 schema 不合法（缺字段、重复 taskType、空候选列表等）|
| `TASK_NOT_CONFIGURED` | 请求的 taskType 在配置中没有路由规则 |
| `MISSING_ELIGIBLE_MODEL` | 所有候选（含后备）均不可用 |
| `MANUAL_MODEL_NOT_IN_CONFIG` | 手动选择的模型不在配置候选列表中 |
| `FALLBACK_AFTER_DISPATCH` | 在已 dispatch 后尝试切换后备（禁止） |
| `UNKNOWN_PAYMENT_RESULT` | 付费结果未知，绝不切换模型重提 |
| `DUPLICATE_CANDIDATE` | 候选列表中有重复模型 ID |

## 约束

1. **配置驱动**：配置变化无需改代码，仅替换 config 对象即可生效
2. **不验证资格**：只接收 `eligibilityResults`，不自行执行 capabilities/permission 检查
3. **配置不能授予权限**：若 eligibilityResult.eligible=false，即使配置有该模型也不选
4. **后备语义**：仅限 dispatchState='pre-dispatch' 时，首选均不可用才进入后备；dispatched 后禁止切换
5. **未知付费结果**：若 reason 包含 PAYMENT/BILLING 类，绝不切模型重提
6. **稳定选择**：相同输入必须相同输出（无随机性）
7. **多阶段路由**：`BLOCKED_MULTI_STAGE` - 未实现，不得声称支持

## 挂载接口

```javascript
// 主线接缝（由主 Agent 集成）
const { createTaskRouter, validateRouteConfig } = require('./shell/candidates/auto-20261103/index.cjs');
const router = createTaskRouter(config);
// 在 task-router.cjs 调用链之后，将 eligibilityResults 传入选择器
const result = router.selectModel(taskType, eligibilityResults, { dispatchState: 'pre-dispatch' });
```

## FILES_PRESENT 标记

- `shell/candidates/auto-20261103/CONTRACT.md` ← 本文件
- `shell/candidates/auto-20261103/index.cjs` ← 实现
- `tests/probes/auto-delivery-20261103.mjs` ← 探针
- `docs/refactor/evidence/GEMINI-AUTO-DELIVERY-20261103.md` ← 报告
