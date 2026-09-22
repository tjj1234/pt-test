# A2 Stage Report — Raw Event + DLQ Persistence

| 项 | 内容 |
|---|---|
| 阶段 | A2 |
| 分支 | `feature/business-attribution-m0` |
| 日期 | 2026-09-21 |
| 结果 | **PASS** |

## 变更清单

| 路径 | 动作 |
|---|---|
| `business/attribution/schema/a2_raw_dlq.sql` | `attribution_raw_events` + `attribution_event_dlq` |
| `business/attribution/persistence/*` | Mock / SQL repo + Collect 队列包装 |
| `tests/attribution/a2-persistence.test.js` | 验收 |
| `analytics/backend/collect/ingest.js` | **未修改** |
| `shell/**` | **未修改** |

## 设计要点

- **不重写 Collect 主干**：通过 `wrapIngestQueueWithPersistence` 包装既有 `enqueue` / `moveToDlq`。
- enqueue 时持久化 raw；失败路径持久化 DLQ；`listDlq(context)` 可查。
- `tenantId`/`workspaceId` 来自 Context；body 内 `tenant_id` 忽略。
- SQL repo 复用调用方传入的 pool，禁止自建连接。

## 测试结果

```text
node tests/attribution/a2-persistence.test.js → ok: true
```

## Base Contract Gap

| ID | 说明 |
|---|---|
| BG-05 | SQL repo 待 A8 换 `base.storage`；现复用 analytics pool |
| — | `deps.cjs` 尚未改接线；生产启用需一行替换 `moveToDlq`/`enqueue` 为包装后队列（仍不改 ingest.js） |

## 未决风险

1. 部分唯一索引 `ON CONFLICT ... WHERE` 在 PGlite 上可能降级为查重插入（已做 fallback）。
2. 成功 ingest 后 raw 的 `parse_status` 尚未自动翻成 `ingested`（需可选 after-hook；非阻塞）。
3. 生产接线未做：本地/测试用 Mock；接入 `createCollectWiring` 记入 A5/A8 前运维清单。

## 下一阶段

允许 **A3**：漏斗 / ROI / 事件查询收敛为 Workflow，平台筛选后端生效。
