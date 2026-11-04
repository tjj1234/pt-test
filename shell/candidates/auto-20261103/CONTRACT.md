# CONTRACT: 配置化任务模型路由 (auto-20261103)
修订版本：`2026-11-04-revision-1`（基于主审 AUTO-08-MAIN-REVIEW 闭合 R1-R6）
基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface TaskRouteConfig {
  routes: RouteEntry[];        // 有序路由规则列表
  version: string;             // 配置版本号，用于 pin，深拷贝绑定
}

interface RouteEntry {
  taskType: string;            // 任务类型，对应 capabilities.cjs TASKS
  candidates: string[];        // 有序首选模型 ID 列表（按优先级降序）
  fallback?: string[];         // 后备模型 ID 列表（全路由去重，严禁与 candidates 重复）
  pinVersion?: string;         // 模型版本 pin（非空字符串）
}

interface SelectInput {
  taskType: string;
  eligibilityResults: EligibilityResult[];  // 来自现有门禁的结果，不自行验证
  selection?: { mode: 'auto' | 'manual'; modelId?: string }; // 严格枚举
  dispatchState?: 'pre-dispatch' | 'dispatched';  // 严格枚举，后备仅限 pre-dispatch
}

interface EligibilityResult {
  modelId: string;
  eligible: boolean;
  reason?: string;             // 不可用原因（若含 PAYMENT_UNKNOWN / UNKNOWN_PAYMENT_RESULT 则终止整个路由）
}
```

## 输出 Schema

```typescript
interface SelectSuccessResult {
  ok: true;
  modelId: string;
  taskType: string;
  mode: 'auto' | 'manual';
  source: 'primary' | 'fallback' | 'manual';
  configVersion: string;
  pinVersion?: string;
}

interface SelectErrorResult {
  ok: false;
  code: ErrorCode;
  detail?: string;
}

type SelectResult = SelectSuccessResult | SelectErrorResult;
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `CONFIG_INVALID` | 配置 schema 不合法（缺字段、重复 taskType、空候选列表、非法枚举等）|
| `TASK_NOT_CONFIGURED` | 请求的 taskType 在配置中没有路由规则 |
| `MISSING_ELIGIBLE_MODEL` | 所有候选（含后备）均不可用 |
| `MANUAL_MODEL_NOT_IN_CONFIG` | 手动选择的模型不在配置候选列表中 |
| `FALLBACK_AFTER_DISPATCH` | 在已 dispatch 后尝试改选或切换模型（严格禁止） |
| `UNKNOWN_PAYMENT_RESULT` | 执行或付费结果未知，立即终止整个选择，绝不切换模型重提 |
| `DUPLICATE_CANDIDATE` | 候选列表中有重复模型 ID（包含 candidates 内部、fallback 内部及跨集合重复） |

## 约束 (R1-R6)

1. **R1 未知付费结果立即停止**：显式区分调用前资格拒绝与已有执行结果未知。遇到 UNKNOWN_PAYMENT_RESULT 或 PAYMENT_UNKNOWN 立即终止并返回 UNKNOWN_PAYMENT_RESULT，绝不跳过该模型选次优或 fallback。
2. **R2 统一状态门禁**：在任何选择分支之前执行统一 dispatchState 检查。`dispatched` 状态下严禁改选模型（无论 primary、fallback 还是 manual 均返回安全拒绝）。
3. **R3 严格枚举校验**：非 `pre-dispatch`/`dispatched` 状态与非 `auto`/`manual` 模式返回 `CONFIG_INVALID`，不默认为安全状态。
4. **R4 候选全量去重**：验证整条路由的候选集合，禁止 fallback 自身重复以及 fallback 与 primary 重复，违者返回 `DUPLICATE_CANDIDATE`。
5. **R5 严格版本 pin**：拒绝空/全空白 pinVersion；`selectModel` 成功结果中透传绑定的 pinVersion。
6. **R6 配置快照隔离**：router 创建时通过深拷贝冻结快照，杜绝外部对象未发布修改导致版本漂移。
7. **多阶段路由**：`BLOCKED_MULTI_STAGE` - 未实现，不得声称支持。

## 挂载接口

```javascript
// 主线接缝（由主 Agent 集成）
const { createTaskRouter, validateRouteConfig } = require('./shell/candidates/auto-20261103/index.cjs');
const router = createTaskRouter(config);
// 在 task-router.cjs 调用链之后，将 eligibilityResults 传入选择器
const result = router.selectModel(taskType, eligibilityResults, { dispatchState: 'pre-dispatch' });
```
