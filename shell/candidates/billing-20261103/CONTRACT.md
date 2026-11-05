# CONTRACT: 真实消费查询与账单核对 (billing-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface BillingClientConfig {
  baseUrl?: string;                // 默认 https://powertokens.ai/api
  token?: string;                  // 登录令牌 Authorization
  tenantId: string;
  httpTransport?: HttpTransport;   // 可注入的受限传输层
}

interface QueryConsumeParams {
  runId: string;
  consumeId?: string;
  signal?: AbortSignal;
}

interface QueryBalanceParams {
  runId: string;
  forceFresh?: boolean;
  signal?: AbortSignal;
}

interface QueryUsageSummaryParams {
  runId: string;
  startDate?: string;              // YYYY-MM-DD
  endDate?: string;                // YYYY-MM-DD
  signal?: AbortSignal;
}

interface QueryAgreementStatusParams {
  runId: string;
  signal?: AbortSignal;
}
```

## 输出 Schema

```typescript
interface AgreementStatusResult {
  ok: true;
  accountId: string;
  agreementAccepted: boolean;
  assetLibraryEnabled: boolean;
  queryAt: number;
}

interface BalanceResult {
  ok: true;
  balance: number;
  currency: 'credits';
  keyId: string;
  isCached: boolean;
  dataAsOf: string;
  queryAt: number;
}

interface ConsumeRecordResult {
  ok: true;
  consumeId: string;
  requestId: string;
  modelId: string;
  status: string;
  consumeTime: number;
  quota: number;
  inputTokens: number;
  outputTokens: number;
  formula: string;
  reconciled: boolean;
}

interface UsageSummaryResult {
  ok: true;
  currency: 'credits';
  keyId: string;
  periodStart: string;
  periodEnd: string;
  totalQuota: number;
  items: Array<{
    modelId: string;
    modelType: string;
    totalQuota: number;
    requestCount: number;
  }>;
}

interface BillingErrorResult {
  ok: false;
  code: ErrorCode;
  detail?: string;
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `TOKEN_REQUIRED` | 未配置或缺少 Authorization 登录令牌 |
| `AUTH_UNAUTHORIZED` | 401 令牌失效或未认证 |
| `AUTH_FORBIDDEN` | 403 权限不足 |
| `RATE_LIMIT_EXCEEDED` | 429 频率超限 |
| `RECORD_NOT_FOUND` | 消费记录不存在，标记 unknown |
| `NETWORK_BLOCKED` | 离线环境无 HTTP 传输通道 |
| `DATE_RANGE_INVALID` | 日期格式非法或开始时间晚于结束时间 |
| `CROSS_TENANT_REJECTED` | 租户隔离校验失败 |
| `BILLING_CANCELLED` | 外部信号取消 |

## 约束原则

1. **凭据隔离**：严格区分用户登录 Token 与底层模型 BYOK Key，Token 仅用于协议头鉴权，不透传给模型。
2. **核对与幂等**：已知消费记录只查询不重复扣除；无法核对的记录状态标记为 `unknown`，绝不虚构数据。
3. **Fail-Closed 与离线安全**：无有效令牌或处于离线隔离状态时，安全返回相应错误码，不尝试未经授权的外部网络请求。
