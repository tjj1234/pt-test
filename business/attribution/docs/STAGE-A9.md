# A9 · 广告导出导入入口

| 项 | 内容 |
|---|---|
| 分支 | `feature/attribution-a9-import-entry` |
| 基线 | 含 A11/A13 的 `feature/attribution-a11-a13-quickwins` |
| 范围 | `business/attribution/import/*` + analytics 统一服务一行挂载 |
| Shell | **未修改** |

## 行为

1. 页面：`GET /api/business/attribution/import`
2. 上传：`POST /api/business/attribution/import/jobs`（JSON：`provider` + `contentBase64` + `originalName`）
3. 确认：`POST /api/business/attribution/import/jobs/:id/confirm`
4. 状态机：`pending → validating → ready → importing → completed|partial_failed|failed`
5. 解析：复用 A1 `parseExportFile`
6. `tenantId` / `workspaceId` 来自分析 Token + `resolveWorkspaceId`；拒绝 body 里的 tenantId

## 测试

```bash
node tests/attribution/a9-import.test.js
```
