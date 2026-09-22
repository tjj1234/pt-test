# Part-1 处置（不硬合并）

| 项 | 决定 |
|---|---|
| 来源分支 | `pt-test-part1` / `part1-real-data-loop` @ `d0f287a` |
| 动作 | **不 merge** 进 `feature/business-attribution-m0` |
| 基线 | `origin/main@96b7b28` |
| A8 | 未批准，不带回 `shell` 设置页改动 |

## 保留的产品决定（已按 A0 Contract 落在业务线）

1. **导出文件解析**：`business/attribution/parsers` 把 Google / Meta / X CSV 收成 CanonicalAd。不做官方 Ads API。
2. **租户 Collect**：非法事件经 `recordValidationFailure` 进可查 DLQ；`tenantId` 只来自 Context，忽略 body 里的租户。
3. **禁止演示回退**：`policy/seed.js` 的 `productionSeedPolicy`。生产环境即使 `PT_ALLOW_DEMO_SEED=1` 也不允许 seed。未改 `analytics/start.cjs`（那是基座进程；灌数接入留到批准之后）。

## 明确不带回

- `shell/collect-routes.cjs`、设置页上传 UI
- Part-1 对 `analytics/backend/server.js` / `funnel.js` 的补丁
- 第二套数据库连接
