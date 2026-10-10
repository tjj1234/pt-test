# GA 解除连接接口 · 2026-10-10
`DELETE /api/business/ga-connector/connection` 删除鉴权租户在 `ga_connections` 中的真实记录（含 property ID、加密凭证），随后 `GET /api/business/ga-connector/status` 返回 `connected:false`。重复调用成功，未连接时同样返回 200。

成功响应：`{ok:true,connected:false,propertyId:null,updatedAt:null}`，`Cache-Control: no-store`。沿用 GA 路由的 token、有效期、UUID 和 `analytics:read` scope 校验；Shell 的既有 `/api/business/` 代理可直接转发 DELETE。只使用鉴权租户，忽略请求中的 tenant/property 参数。数据库事务先设置 `app.current_tenant_id`，再执行 `DELETE FROM ga_connections WHERE tenant_id=$1::uuid`，同时受 RLS 与显式租户条件约束；失败回滚。解除不依赖 Google OAuth 配置或加密密钥，不调用 Google API。本接口解除本产品保存的连接，不撤销 Google 侧授权；设置页按钮不在本任务范围内。

验证：`cd business/attribution && npm run test:ga` → **16/16 PASS**（原 13 项 + 新 3 项）；`git diff --check` PASS。新增测试使用真实 Fastify HTTP inject、真实 PGlite/pt_app/RLS 和真实 AES-GCM 写入的双租户连接，不 mock SQL 或解除逻辑：

| 新测试 | 验证内容 |
|---|---|
| 真实删除 / 状态 / 幂等 | 删除前有 property 行，删除后 SQL 查询零行、store.get 为 null、status 为未连接；重复解除成功；后续查询要求授权且不调用 Google |
| 租户隔离 | RLS 下直接尝试删除其他租户返回 0 行；请求伪造 tenant/property 仍只删除自身，另一租户 property 与凭证保留 |
| 鉴权失败 | 缺 token、过期、未知 token、缺 scope、非法租户均被拒绝，两租户连接保持 |

分支 `feature/business-ga-disconnect`；仅修改 `analytics/backend/ga-connector/routes.js`、`business/attribution/ga-connector/store.js`，新增单测和本文；不改 UI、基座或数据库结构。待独立核实后批准合并 main。
