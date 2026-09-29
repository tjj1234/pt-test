# A0 Stage Report — Contract Freeze

| 项 | 内容 |
|---|---|
| 阶段 | A0 |
| 分支 | `feature/business-attribution-m0` |
| 基线 | `origin/main` @ `4504262` |
| 日期 | 2026-09-21 |
| 结果 | **PASS — Contract frozen** |

## 变更清单

| 路径 | 动作 |
|---|---|
| `business/attribution/contracts/*` | 新增：ad/event/attribution/import/health/panel/tool/workflows/context + invariants/validate/freeze |
| `business/attribution/docs/CONTRACT.md` | 新增：冻结说明 |
| `business/attribution/docs/BASE-CONTRACT-GAP.md` | 新增：BG-01…BG-09 |
| `business/attribution/docs/STAGE-A0.md` | 本报告 |
| `business/attribution/index.js` | 新增：包入口 |
| `business/attribution/package.json` | 新增：本地 scripts |
| `tests/attribution/fixtures/**` | 新增：夹具目录 + minimal.json |
| `shell/**` | **未修改** |
| `packages/**` DSH / auth | **未修改** |

## 测试结果

```text
node business/attribution/contracts/validate.js
→ ok: true
```

## Base Contract Gap（摘要）

见 `BASE-CONTRACT-GAP.md`。阻塞 A8 的项：Workspace Context、Permission、Panel/Tool Registry、统一 storage/audit。A1–A7 用 Mock / analytics Repository 临时绕过。

## 未决风险

1. **Part-1 CSV 导入不在 main**：A1 需按 A0 CanonicalAd 重写 Parser，不能直接合并未推的 part1 工作树而不经 Contract 对齐。
2. **双库现状**：analytics PGlite vs shell 身份库 — A0 记为 BG-05，禁止再开第三连接。
3. **平台筛选未后端化**：现有漏斗/ROI 若读 query 平台参数，A3/A5 必须收口到 Workflow。
4. **生产 seed**：`start.cjs` 仍可能 seed — A2/A5 阶段用 env 关掉，不改 shell。

## 下一阶段门禁

- A0 frozen = true（本报告）
- 允许开始 **A1**：Google / Meta / X 导出文件 Parser → CanonicalAdRecord
- 禁止：官方 API/OAuth、改 shell、A8、生产 seed、客户端租户注入
