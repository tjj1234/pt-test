# 归因业务线 Contract（A0 冻结）

| 项 | 内容 |
|---|---|
| 分支 | `feature/business-attribution-m0` |
| 基线 | `origin/main@4504262`（update PRD） |
| 状态 | **frozen** |
| 下一刀 | A1 Provider Parser（不得发明字段） |
| 日期 | 2026-09-21 |

## 范围

本包只冻结业务线能力契约，**不修改** `shell/`、DSH Adapter、权限核心、Storage Contract。

```
business/attribution/contracts/
  context.json              AttributionContext
  canonical-ad.json         CanonicalAdRecord
  canonical-event.json      CanonicalEvent
  attribution-result.json   AttributionResultRow
  import-job.json           AdImportJob + 状态机
  health-report.json        AttributionHealthReport
  panel-registration.json   Panel 注册
  tool-registration.json    Tool 注册
  workflows.json            Workflow 表面
  invariants.js             铁律与枚举
  validate.js               轻量形状校验 + selfCheck
  freeze.json               冻结元数据
```

## 铁律（摘要）

1. `tenantId` / `workspaceId` 只来自 `AttributionContext`，禁止信任客户端 body / query / 文件行。
2. 禁止第二套数据库连接；仓储经 `base.storage`（A8 前用 Mock）。
3. 生产不得自动 seed 演示数据。
4. ROI / 漏斗人数由 Workflow 返回；前端只渲染，禁止演示数字填空。
5. `(tenantId, eventId)` 幂等；`rawEvent` 与标准化字段分离；非法事件进持久化 DLQ。
6. A1 只解析导出文件，不做官方 Ads API / OAuth。
7. 本分支不改 `shell/server.cjs`、`tenant.cjs`、`persistent-runner.mjs`、auth、DSH。

## 与当前 main 的差距（记入 Gap，不在 A0 实现）

| 能力 | main@4504262 | Contract 要求 |
|---|---|---|
| Collect 三件套 + secret 反查 | 有 | 保留；A2 补 raw 持久化 / DLQ |
| 漏斗 / ROI SQL | 有 | A3 收敛为 Workflow，平台筛选后端化 |
| 五 Tab 面板 | 有 | A4 只消费 Workflow |
| CSV/XLSX 导入（Part-1） | **不在 main**（仅本地未推分支） | A1 按本 Contract 实现 Parser |
| Tool / Panel Registry | 仅 glue 类型空壳 | A6 提交注册 JSON + Mock |
| tests/attribution | 无 | A0 起建夹具目录，A7 统一验收 |

## 自检

```bash
node business/attribution/contracts/validate.js
# 期望 { "ok": true, ... }
```

## 批准边界

- 批准：业务线独立开发 A0–A7
- 暂不批准：A8 基座集成
- 顺序：A0 → A1 → A2 → A3 → A5 → A4 → A6 → A7
