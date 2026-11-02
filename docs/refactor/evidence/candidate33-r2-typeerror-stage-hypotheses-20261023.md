# candidate-33 r2 模型目录 TypeError：本地阶段假设

线上已知：`/api/models` 返回 HTTP 200，但 `catalogDiagnostics.state=internal_error`、`errorCode=MODEL_CATALOG_INTERNAL_TYPE_ERROR`、`lastSuccessfulAt=null`、`modelCount=24`。这些字段来自外层异常兜底；24项是静态展示列表，不能用 `upstreamStatus=null` 或 `failureCount=0` 推断上游及缓存的实际状态。r2 没有 `failureStage`，因此当前无法确定真实抛错点。

冻结 r2 归档的只读代码审查与本地临时 fixture 将候选路径收窄如下；fixture 使用假 HTTP 响应，不访问真实 PT、目标机或用户缓存。

| 阶段 | 本地可复现形状 | 与线上关系 |
|---|---|---|
| `merge` | scoped cache 的 `models` 是数组，但元素为 `null`，或为旧展示形状 `{id, chat}`；假上游 HTTP 503 后，失败快照仍调用 `mergeSnapshot()` 更新旧模型，并在 `id` 或 `eligibility()` 所需字段处抛 TypeError | 与线上强制同步路径兼容；**优先验证的假设，尚非根因** |
| `local_update` | 旧缓存形状不完整、缓存未过期、`force:false`，本地策略更新再调用 `mergeSnapshot()` | r4 阶段码可区分；线上 `/api/models` 的 `force:true` 路径通常会更早经过 `merge` |
| `projection` | 合并结果被人为替换为异常模型对象，投影时抛 TypeError | 仅证明阶段码有区分能力；该对象不来自正常 JSON/PT 响应 |

`fetchPtSnapshot()` 将普通 fetch/JSON 异常归类为稳定错误码，`readScopedCache()` 吞掉文件/JSON读取异常；这降低了它们直接造成外层 TypeError 的可能性，但不排除其他输入异常。r4 本地诊断补丁会安全地返回固定枚举 `failureStage`；它仍是不可部署草案。下一条可验证证据是最终获授权候选上线后单次已登录 `GET /api/models` 的 `failureStage`。若指向 `merge`，再设计只读、脱敏的缓存结构布尔检查；不得回传缓存内容、Key 或原始模型记录，也不得先清缓存。
