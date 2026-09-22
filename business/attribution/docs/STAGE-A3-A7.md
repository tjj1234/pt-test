# Stages A3 / A5 / A4 / A6 / A7

| 阶段 | 结果 | 要点 |
|---|---|---|
| A3 | PASS | `queryAttributionFunnel` / `queryCreativeRoi` / `queryEvents`；`platform` 后端过滤 |
| A5 | PASS | `queryAttributionHealth`（含 dlqOpenCount，无生产 seed） |
| A4 | PASS | `panel/projector` 只消费 Workflow；无演示 ROI |
| A6 | PASS | Mock Registry 注册 Panel/Tool Contract；`dshConnected=false` |
| A7 | PASS | `a7-acceptance.test.js` 串联 A0–A6 |
| A8 | **未做** | 批准范围外 |

## 变更清单（相对 A2）

| 路径 | 阶段 |
|---|---|
| `business/attribution/workflows/index.js` | A3/A5 |
| `business/attribution/panel/projector.js` | A4 |
| `business/attribution/registry/mock.js` | A6 |
| `tests/attribution/a3-a6-workflows.test.js` | A3–A6 |
| `tests/attribution/a7-acceptance.test.js` | A7 |
| `shell/**` / DSH / Collect 主干 | **未修改** |

## 测试

```bash
node tests/attribution/a7-acceptance.test.js
```

## Base Contract Gap（仍开放）

BG-01…BG-09 见 `BASE-CONTRACT-GAP.md`。Workflow 现用内存 store 验收逻辑；接真库需 Repository + A8 Context 注入。

## 未决风险

1. Workflow 与现有 `funnel.js` SQL 尚未接线——A8 / 运维清单项：用 adapter 调用 `queryFunnelScoped`，平台过滤已在 SQL 侧存在，需验证 token→context 路径。
2. Panel projector 未替换 `analytics/frontend`——前端接线属展示层，可后续只改调用点，仍禁止前端算 ROI。
3. A8 未批准：禁止改 shell / 接 DSH。

## 批准边界复核

- 生产自动 seed：禁止
- 客户端租户注入：禁止（Context 门禁）
- 第二套 DB：禁止
- A8：暂不批准
