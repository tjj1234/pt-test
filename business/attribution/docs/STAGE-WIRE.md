# 归因接线（funnel / Collect → Workflow）

| 项 | 内容 |
|---|---|
| 基线 | `96b7b28` |
| A8 | 不做 |
| 改动范围 | 仅 `business/attribution` 与 `tests/attribution` |

`createAnalyticsWorkflows` 调用现有 `analytics/backend/ads/funnel.js` 的 `parseFunnelParams` / `serializeFunnelGroup` / `serializeRoiEntity`，以及 `events/query.js` 的 `parseEventFilters`。平台值交给既有解析器，变成 SQL 参数数组，不在面板里过滤。

面板 `roiSummary.roi` 只在恰好一行时转述该行的 `roi`。花费 10、收入 100、SQL roi 3.5 时，面板仍是 3.5，不会改成 10。

Collect 主干 `ingest.js` 未改。健康查询的 `dlqOpenCount` 来自 A2 持久化仓库。
