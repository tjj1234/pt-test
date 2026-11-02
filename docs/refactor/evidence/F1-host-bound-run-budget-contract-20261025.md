# F1 单用户、单 Run 预算绑定接口草案（2026-10-25）

**结论：当前共享 profile 不能作为“仅此用户、仅此 Run”的付费媒体放行机制。** `persistent-runner.mjs` 每次任务从同一个 `DSH_HOME/profiles/run-persistent/run-budget.json` 读取限额；`dsh-adapter.cjs` 按 tenant 保有进程，传给 runner 的 task frame 只有 `sessionId`、`task`、`model`、`tenantId`，不含权威 `userId`、`runId` 或授权记录。将 profile 的 0 工具改为 1 工具，会同时放宽共享该 profile 的其他任务；按 Run 计数只限制单次执行量，不限制谁能得到新策略。现有 `allowedTools`/`allowedMediaTaskTypes` 是运行时拒绝边界，仍从共享文件读取，不能单独解决跨用户授权。发布默认预算保持 1 模型、0 工具、180 秒。

## 最小接口与信任边界

| 环节 | 必须绑定并核验 | 拒绝条件 |
|---|---|---|
| Host 创建受控 Run | 已认证 `userId`、`tenantId`、`conversationId`、持久 `runId`、幂等键、当前租约所有者；经数据库核对 Run 属主 | 非当前用户/租户、Run 不存在、重放带来不同策略、租约失效 |
| Host 冻结授权 | 独立 `grantId`、策略版本、签发/失效时刻、单一 `runId`、允许的 `taskType`、可信模型/适配版本、模型/工具/重试/时长上限、最多一次外部提交；仅保存非密钥 credential scope 指纹 | 授权已过期、版本/模型资格漂移、任务类型越界、同一 grant 已用于另一 Run |
| Runtime task frame | 由可信 Host→Adapter 内部通道传递 `grantId`、`runId`、`userId`、`tenantId`、`sessionId` 和策略摘要；Adapter 把其与 waiter/session 映射固定，runner 逐字段核对，绝不从聊天文本或工具参数读取授权 | 字段缺失/类型无效、tenant/session/run 不一致、当前 Run 没有持久授权 |
| Host 媒体提交前 | 用**实际提交所用同一 Key**重新计算 scope、确认当前目录/模型×任务资格、Run 租约与 grant；在外部 intent 写入前核对取消、预算与任务类型；外部操作表原子限制该 grant 最多一次 POST 意图 | Key scope 改变、资格未通过、已取消、已有未知/未决外部操作或提交次数耗尽 |
| 恢复与核对 | grant 与 Run 一起持久化；重启后先查询已知 task/operation，保持未知付费结果为 `manual_check`；记录 grantId、RunId、预算用量和实际费用证据状态，均不含 Key | 未知 POST 自动重提、费用未知被写成零、晚到结果覆盖其他 Run |

建议内部契约（示意，**尚未实现或授权**）：

```json
{
  "grantId": "opaque-random-id",
  "runId": "persisted-run-uuid",
  "userId": "authenticated-user-id",
  "tenantId": "verified-tenant-id",
  "conversationId": "owned-conversation-id",
  "sessionId": "adapter-bound-session-id",
  "credentialScopeId": "non-secret-same-key-scope",
  "policyRevision": "immutable-policy-revision",
  "modelCapabilityRevision": "verified-catalog-revision",
  "allowedTools": ["media_route"],
  "allowedMediaTaskTypes": ["text2image"],
  "maxModelCalls": 2,
  "maxToolCalls": 1,
  "maxToolCallsPerKey": 1,
  "maxRetries": 0,
  "maxDurationMs": 180000,
  "maxExternalSubmissions": 1,
  "issuedAt": "ISO-8601",
  "expiresAt": "ISO-8601"
}
```

`grantId` 必须由 Host 存储并在调度前与 Run 绑定；task frame 不应携带未校验的前端预算。若跨进程需证明完整性，应由 Host 签名或用数据库读取并比对不可变 grant，runner 不能仅相信用户可控 JSON。租约 fencing 与 grant 是两道门：runner 管模型/工具次数，Host 在付费 POST 之前管身份、同 Key、任务资格及外部提交次数。`sessionId` 只是会话映射，不能替代 `runId` 或用户身份。

## 实施顺序与费用边界

1. 先在 Host 的持久 Run 创建/重放路径冻结 grant；定义同幂等键策略变化时拒绝，不覆盖旧授权。保留发布 profile 的 0 工具默认值。
2. 在 `tenant.cjs` Runtime Contract 和 `dsh-adapter.cjs` 的 task frame 增加受信任 grant 引用，检查 Run/用户/租户/session 一致；runner 只在完整绑定后应用该 Run 的预算，其他任务继续用默认 profile。
3. 在 `media-run-handler.cjs` 的资格检查与 intent 之间核对 grant，并通过持久外部操作表原子限制一次提交；未知结果只查询或人工核对，不自动重试 POST。用双用户、同租户双用户、同会话新 Run、重启/失 ACK、并发两个工具调用做反例测试。
4. 才可冻结候选、审计 target profile/发布字节和回滚，再做有界真实调用。视频 Run 的 runner 时限需覆盖约 65 分钟外层窗口；图片可保留较短时限。**次数/时长不是货币上限**：目前 runner 给 `maxCost` 的模型请求没有可信 `estimatedCost`，会以 `RUN_COST_UNKNOWN` 拒绝；媒体账单/余额也不能由现有 Key 读取。取得可验证价格与实际扣费证据，或在 PT 账户侧建立已核实的硬消费上限前，不应把示例 grant 当成已满足货币封顶的付费许可。

本草案来自本地代码只读追踪与合成测试；没有读取 Key、发送 PT 请求、修改发布默认预算或完成目标机验收。
