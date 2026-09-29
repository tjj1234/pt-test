# A1 Stage Report — Provider Export Parsers

| 项 | 内容 |
|---|---|
| 阶段 | A1 |
| 分支 | `feature/business-attribution-m0` |
| 基线 | `origin/main` @ `4504262` + A0 frozen |
| 日期 | 2026-09-21 |
| 结果 | **PASS** |

## 变更清单

| 路径 | 动作 |
|---|---|
| `business/attribution/parsers/tabular.js` | CSV 内置；XLSX 可选 `xlsx` |
| `business/attribution/parsers/mapping.js` | 规则列映射 → Canonical 字段 |
| `business/attribution/parsers/index.js` | `parseExportFile` / Google / Meta / X |
| `tests/attribution/fixtures/providers/*.csv` | 三平台夹具 |
| `tests/attribution/a1-parsers.test.js` | 验收 |
| `business/attribution/docs/STAGE-A1.md` | 本报告 |
| `shell/**` | **未修改** |
| 官方 Ads API / OAuth | **未接入** |

## 测试结果

```text
node tests/attribution/a1-parsers.test.js
→ ok: true（meta 3 / google 3 / x 2 行；缺 workspaceId → CONTEXT_REQUIRED）
```

## Base Contract Gap（本阶段新增/确认）

| ID | 说明 | 状态 |
|---|---|---|
| BG-05 | Parser 仅产出 CanonicalAd；入库仍经 Repository（A2/后续） | 沿用 |
| BG-07 | 上传入口不扩 shell；本阶段纯函数 + 夹具验收 | 确认 |
| — | XLSX 需可选依赖 `xlsx`；无依赖时要求 CSV | 记为运维注意，非基座 Gap |

## 未决风险

1. 列名方言极多：仅规则映射，无 AI；冷门表头需人工 mapping 覆盖（后续可接可选 AI，非 A1 必须）。
2. Google `cost_micros`：当前夹具用 `Cost` 美元；真实 micros 列靠列名启发，需更多夹具覆盖。
3. 缺 campaign/ad id 时合成 `campaign:` / `creative:` / `daily:` id — 归因匹配可能偏弱，属预期。
4. **不写库**：A1 不持久化；A2 起补事件侧，导入落库可在 A1 收尾或紧随 Workflow 前加 Repository（仍不改 shell）。

## 下一阶段

- 允许 **A2**：raw event 持久化、DLQ、失败可查；不重写 Collect 主干。
- 禁止：OAuth、改 shell、生产 seed、客户端租户注入、A8。
