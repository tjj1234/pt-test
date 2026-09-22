# Base Contract Gap（A0）

业务线需要、但**不得自行实现**的基座能力。发现缺口只记账，不改 shell。

| ID | 需要的基座能力 | 为何需要 | 当前现状 | 临时策略 |
|---|---|---|---|---|
| BG-01 | `getCurrentWorkspace()` / AttributionContext 注入 | Workflow 禁止读客户端 tenant | shell session + X-Tenant-Id 透传存在，但业务线不能信任 header | Adapter Mock：测试夹具写 Context；生产等 A8 |
| BG-02 | `checkPermission("attribution:read")` | Panel/Tool 权限 | 无统一权限服务 | Mock PermissionChecker 恒 true（仅 test） |
| BG-03 | `registerPanel()` / Panel Registry | A6 注册 powertokens-attribution | 无 | Mock Registry 写内存表 |
| BG-04 | `registerTool()` / Tool Registry | A6 注册 attribution.query | glue/contract 仅类型 | Mock Registry |
| BG-05 | `storage.repository` / `storage.transaction()` | 禁止第二套 DB | analytics 自有 PGlite；shell 另有身份库 | A1–A7 经 analytics pool 读写业务表，但封装在 Repository 接口后；A8 换基座 storage |
| BG-06 | `audit.record()` | 导入/Collect 审计 | 部分 Token 审计 | 先写业务表字段；A8 接 audit |
| BG-07 | 设置页「上传广告 / 数据接入」入口归属 | UI 入口在 shell | Part-1 曾改 shell（未进 main） | **不扩 shell**；本地用 analytics 管理 API + 夹具验收；正式入口等基座 Panel 挂载 |
| BG-08 | 生产 `PT_ALLOW_DEMO_SEED` 默认关 | 禁止生产自动 seed | `start.cjs` 仍会 seed 演示租户 | A2/A5 文档要求：`PT_ENV=production` 跳过 seed；改动限 analytics，不改 shell |
| BG-09 | 对象存储 file_id | 导入原件 | 本地目录 | 继续本地受控目录；A8 换对象存储 |

## 不申请、明确拒绝自行做

- 第二套 PGlite / Pool
- 自建用户权限 / 自发生成 tenantId
- 修改 DSH Adapter / persistent-runner / auth
- 官方 Ads API OAuth
