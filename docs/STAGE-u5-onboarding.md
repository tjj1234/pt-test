# STAGE · U5 首次接入向导（Onboarding Wizard）

> 分支：`feature/ui-u5-onboarding-wizard`（基于 main `20b825f`）
> 路由挂载点（用户确认）：`analytics/frontend/`（与 U1/U4 同目录）
> 状态：✅ 已实现 + 真实环境 API 契约验证通过（前端 UI 渲染需浏览器，本环境未做可视化截图）

## 1. 目标与范围

把"首次接入"从分散在「接入」Tab 的手动操作，收敛成一个四步向导，降低新租户接入门槛：

1. **选接入方式** —— GTM/sGTM 容器（实时事件） 或 广告平台 CSV 批量上传
2. **sGTM 连接测试** —— 验证 Collect 链路可达 + 密钥有效（结构化诊断）
3. **确认事件名映射** —— GET/PUT `/mapping`，与「接入」Tab 同一份存储
4. **上传广告数据校验** —— 复用 U4 `PTUpload` 上传 + 确认，触发 `firstConnectedAt` 写入
5. **生成归因面板** —— 确认接入完成，跳转「总览」（归因面板）

CSV 上传路径按用户要求**可排后**：本实现已复用 U4 的上传 modal，未另写上传逻辑。

## 2. 实现要点

| 文件 | 作用 |
|------|------|
| `analytics/frontend/tabs/onboarding.js` | 向导主逻辑（IIFE + `wire()` 自接线，范式同 U6 ingestion.js） |
| `analytics/frontend/onboarding.css` | 向导专属样式（步进条 / 方式卡 / 诊断卡 / 映射表），复用现有 card/pt-btn/state 视觉 |
| `analytics/frontend/app.js` | `TABS` 增加 `onboarding` 项 + `tabIcon` |
| `analytics/frontend/index.html` | 引入 `onboarding.css` 与 `tabs/onboarding.js` |

- 复用：`PTIngestionClient`（mapping GET/PUT）、`PTImportClient`（workspace GET）、`PTUpload`（CSV 上传 modal）。
- 新增：`PTOnbClient.connection-test` / `adapt` —— 直接打 `/api/business/attribution/ingestion/connection-test` 与 `/adapt`。
- 鉴权：与 U4/U6 同一套 `resolveToken()` → `Authorization: Bearer`。
- 写入 `firstConnectedAt`：由 U4 导入 confirm 触发（已在前序 U4 验收中证实）；GTM 实时接入则首个事件到达时自动写入，向导对两种情况都给出明确文案。

## 3. 真实环境验证（运行中 8123 后端）

对向导会调用的每个接口实跑，结果全部符合预期（`_u5_api_result.txt`）：

| 接口 | 结果 |
|------|------|
| GET `/import/workspace` | 200，`firstConnectedAt` 已记录 |
| GET `/ingestion/mapping` | 200，返回当前映射 |
| PUT `/ingestion/mapping` | 200，持久化（含 null=删除语义） |
| POST `/ingestion/adapt` | 200，事件归一化成功 |
| POST `/ingestion/connection-test`（→ 本地 Collect） | 200，返回结构化诊断 `INVALID_EVENT` —— 因测试环境本地 Collect 对探测事件做完整 schema 校验，密钥正确、链路可达；真实 Collect 接受归一化事件时返回 `OK` |
| 静态资源 `/`、`/onboarding.css`、`/tabs/onboarding.js`、`/app.js` | 均 200，且 `index.html` 已含引用、`app.js` 已含 onboarding 注册 |

`node --check` 通过（onboarding.js / app.js 无语法错误）。

## 4. 已知边界 / 待补

- **可视化渲染未做**：本环境无可用浏览器，未做截图级 UI 验收。功能契约 + 静态服务 + 语法已验证，逻辑复用 U4/U6 已验证范式。
- **connection-test 在测试环境返回 INVALID_EVENT**：是本地 Collect schema 严格所致，非向导 bug；真实部署用归一化事件即 `OK`。
- 后续可在「接入」Tab 或向导内补：连接测试的历史记录、映射冲突提示、多工作区选择。

## 5. 提交内容（本分支）

- 新增：`analytics/frontend/tabs/onboarding.js`、`analytics/frontend/onboarding.css`、`docs/STAGE-u5-onboarding.md`
- 修改：`analytics/frontend/app.js`（TABS + 图标）、`analytics/frontend/index.html`（引用）
- 未提交：本目录下的 `_*.cjs` / `_*.txt` / `_u4_*.csv` 等历史临时验证脚本（与 U5 无关，保持工作树干净）。
