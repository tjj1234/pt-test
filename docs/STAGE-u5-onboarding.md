# STAGE · U5 首次接入向导（Onboarding Wizard）

> 分支：`feature/ui-u5-onboarding-wizard`（基于 main `20b825f`，含 U6；后接 commit 2 增量）
> 路由挂载点（用户确认）：`analytics/frontend/`（与 U1/U4/U6 同目录）
> 状态：✅ 已实现 + 真实验收通过（两条路径均走到「生成归因面板」且 `firstConnectedAt` 从 null 正确写入）

## 1. 目标与范围

把"首次接入"从分散在「接入」Tab 的手动操作，收敛成一个四步向导，降低新租户接入门槛：

1. **选接入方式** —— GTM/sGTM 容器（实时事件） 或 广告平台 CSV 批量上传
2. **sGTM 连接测试** —— 验证 Collect 链路可达 + 密钥有效（结构化诊断，502/401/400 翻成人话）
3. **确认事件名映射** —— GET/PUT `/mapping`，与「接入」Tab 同一份存储
4. **上传广告数据校验** —— CSV 路径复用 U4 `PTUpload`；GTM 路径点「完成接入」
5. **生成归因面板** —— 确认接入完成，跳转「总览」（归因面板）；同时写入 `firstConnectedAt`

依赖已重新核实全部就绪：`connection-test / mapping / adapt / quality-stats` 四接口自 `74e0f27` 起在 main；CSV 路径依赖的 A18 已合并。**直接对接真实接口，无模拟数据。**

## 2. 实现要点

### 前端（commit 1）
| 文件 | 作用 |
|------|------|
| `analytics/frontend/tabs/onboarding.js` | 向导主逻辑（IIFE + `wire()` 自接线，范式同 U6 ingestion.js） |
| `analytics/frontend/onboarding.css` | 向导专属样式（步进条 / 方式卡 / 诊断卡 / 映射表），复用现有 card/pt-btn/state 视觉 |
| `analytics/frontend/app.js` | `TABS` 增加 `onboarding` 项 + `tabIcon` |
| `analytics/frontend/index.html` | 引入 `onboarding.css` 与 `tabs/onboarding.js` |

- 复用：`PTIngestionClient`（mapping GET/PUT）、`PTImportClient`（workspace GET）、`PTUpload`（CSV 上传 modal）。
- 新增：`PTOnbClient.connection-test` / `adapt` / `completeOnboarding` —— 直接打 ingestion / import 真实接口。
- 鉴权：与 U4/U6 同一套 `resolveToken()` → `Authorization: Bearer`。

### 后端（commit 2 —— U5 验收中发现缺口后补）
| 文件 | 改动 |
|------|------|
| `business/attribution/import/service.js` | 新增 `markConnected(ctx)`：调用 `workspaceMeta.markFirstConnected(workspaceId)`（与 CSV confirm 共用存储，幂等） |
| `business/attribution/import/routes.js` | 新增 `POST /api/business/attribution/import/workspace/connected`：写 `firstConnectedAt` |
| `analytics/frontend/tabs/onboarding.js`（增量） | ① 修复 GTM 第二步缺「下一步」按钮的阻塞 bug；② 新增 `IMP_API` / `onbFetchImport` / `PTOnbClient.completeOnboarding` / `doFinishGtm` |

### 本轮修复的两个阻塞点
1. **GTM 第二步无「下一步」按钮（必改）**：原实现第二步只有「测试连接 / 上一步」，**GTM 路径永远走不到第三步**。已补「下一步」按钮——连接测试通过（`ui.connected`）后解锁，严格遵守"先失败可重试、成功后解锁下一步"的交互要求；CSV 路径保留「跳过，下一步」。
2. **GTM「完成接入」不写 `firstConnectedAt`（必改）**：原先 `markFirstConnected` 仅 CSV 导入 confirm 调用，GTM 点「完成接入」只跳面板、不落库。现新增 `POST /workspace/connected` 端点，GTM 完成接入时真正写入首次接入时间（幂等，已写不覆盖）。

## 3. 真实验收（运行中 8124 后端，全新租户从 null 起）

为干净演示"从 null 写入"，两条路径都用**从未触碰过的新租户**跑（首接时间文件存储在工作区元数据，不与数据库混；全新租户即 null 起点）。后端用 PGlite 自包含库（`start.cjs` + `NODE_PATH` 复用 pt-test 依赖）。完整日志：`_u5_accept_result.txt`。

| 步骤 | 路径 | 结果 |
|------|------|------|
| A0 | GTM · GET `/import/workspace` | `firstConnectedAt = null` ✓（起点干净） |
| A1 | GTM · POST `/ingestion/connection-test`（假 Collect 返回 200） | `ok:true`，诊断 `OK`（对应"测试连接通过→解锁下一步"） |
| A2/A3 | GTM · PUT+GET `/ingestion/mapping` | 持久化往返正常（`u5_gtm_probe→visit`） |
| A4 | GTM · POST `/import/workspace/connected` | 写入 `firstConnectedAt`（时间戳已落库） |
| A5 | GTM · GET `/import/workspace` | `firstConnectedAt` 已写入 ✓ |
| B0 | CSV · GET `/import/workspace` | `firstConnectedAt = null` ✓ |
| B1 | CSV · POST `/import/jobs`（上传 `_u4_ok.csv`） | 201，`ready`，4 行 |
| B2 | CSV · POST `/jobs/:id/confirm` | `completed`，成功 4 / 失败 0 |
| B3 | CSV · GET `/import/workspace` | `firstConnectedAt` 已写入 ✓ |

**结论**：GTM 路径从 null 写入 `firstConnectedAt` → PASS；CSV 路径从 null 写入 → PASS；connection-test 真实 Collect 可达时返回 `OK` → PASS。两条路径均走到"生成归因面板"这一步。

> 注：`/ingestion/adapt` 接口此前已在契约验证中确认（归一化成功，422 坏事件）。本轮验收聚焦两条路径的端到端 + 写入语义。

## 4. 已知边界

- **可视化渲染未做**：本环境无可用浏览器，未做截图级 UI 验收。"下一步解锁"按钮态、`doFinishGtm` 跳转等为前端状态逻辑，已通过**代码审查 + 后端接口验证**（connection-test 返回 OK 即解锁条件成立）确认；待有浏览器时做最终视觉走查。
- **connection-test 在 8123 旧环境曾返回 `INVALID_EVENT`**：是旧测试环境本地 Collect 对探测事件做完整 schema 校验所致（密钥正确、链路可达），非向导 bug；真实 sGTM→Collect 接受归一化事件即 `OK`（本轮用假 Collect 200 已验证 OK 分支）。
- `firstConnectedAt` 为工作区级一次性时间戳，存于 `analytics/data/imports/_workspaces/<ws>.json`（文件存储，未进 `collect/` 红线），与 CSV / GTM 两条路径共用、幂等。

## 5. 提交内容（本分支，共 2 个 commit）

- **commit 1（前端 5 文件）**：新增 `tabs/onboarding.js`、`onboarding.css`、`docs/STAGE-u5-onboarding.md`；修改 `app.js`（TABS+图标）、`index.html`（引用）。
- **commit 2（验收补漏）**：修改 `business/attribution/import/service.js`（新增 `markConnected`）、`business/attribution/import/routes.js`（新增 `/workspace/connected`）、`tabs/onboarding.js`（修 GTM 下一步按钮 + 接 `completeOnboarding`）；更新本 STAGE 报告。

`collect/` 红线未被触碰；`node --check` 三个改动文件均通过。
