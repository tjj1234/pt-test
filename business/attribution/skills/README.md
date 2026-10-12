# Skill-2 · 埋点质量 AI 分析
业务实现已具备真实 report 输出：`tracking_quality_audit`（`type: skill`、`riskLevel: read`、`outputType: report`），要求 `tool.use` 与 `attribution:read`。只审计 `saas_token_marketplace`；不创建面板、不启用工作区、不写事件。本能力不修改 Shell。

| 入口 | 用途 |
|---|---|
| `trackingQualityAuditToolDefinition()` | 定义工具清单、输入约束与权限 |
| `registerTrackingQualityAuditTool(opts)` | 调现有 Shell `registerTool()` 并绑定真实 executor |
| `callTrackingQualityAudit(context, args, opts)` | 校验权限与租户归属，读取真实 snapshot，返回 report |
| `buildTrackingQualityReport(snapshot, workspaceId)` | 纯报告投影，供业务层与契约测试使用 |

注册时必须绑定 U6 正在使用的 `adapter`（或其 `qualityStats` 实例）及可信 `resolveWorkspaceId(tenantId)`。禁止临时新建一个空统计 store；禁止从工具入参传入 workspace、租户或统计数字。Shell 的 `ws_<tenantId>` 上下文先解析为 analytics 的真实 workspace；其它不匹配的上下文拒绝。跨进程部署需要基座提供读取该租户真实质量接口的 adapter facade，内存 registry/store 不会跨进程共享。
```js
const { registerTrackingQualityAuditTool } = require("business/attribution");
registerTrackingQualityAuditTool({ adapter: existingU6Adapter, resolveWorkspaceId });
// 之后由现有 shellRegistry.executeTool("tracking_quality_audit", {}, sessionContext) 执行。
```
报告契约位于 `../contracts/tracking-quality-report.json`：`title / scoreBar / kv / issuesTable / recommendations`，附带原始 `source.snapshot`、统计范围、未评估项和限制。模型使用 `tracking-quality-audit.prompt.md` 解读报告；当前 executor 是可复现的后端规则，并没有执行一次外部模型请求。不能把后端规则冒充模型推理。
评分 v1 是产品规则：100 − 40×未映射率 − 35×ID 兜底率 − 25×时间戳兜底率。未映射率分母排除 ignore；后两项分母为已适配事件。存在已适配事件才评分，空数据/仅忽略/仅未映射均返回 `value: null`。90 分及以上显示 healthy、70 分及以上显示 attention，其余 high_risk；健康仅指已观测的三个适配指标，不代表完整审计通过。
整改建议针对注册、API Key 创建、模型调用、充值链路。snapshot 没有事件名/字段明细，所以六类核心事件覆盖、重复计数、时间准确性、业务金额/token 字段完整性均不声称已核验。统计为当前进程/重置后的累计适配尝试，包含重放或探测，不等于成功入库数。

验证命令：`node --test business/attribution/skills/tracking-quality-audit.test.js`。测试通过真实 adapter 产生事件质量计数，经过真实 Shell 权限、注册、执行和 PGlite 调用日志；不使用假的计数或假的权限恒放行。最后新增真实事件，验证下一次报告随 snapshot 改变。
**产品验收尚需基座/UI 接入：**当前 `shell/server.cjs` 与 DSH setup 只启动注册 `get_current_time`，未自动加载业务注册入口；Shell 前端也尚无 report 抽屉渲染器。因此业务注册探针通过不等于用户已能从现有对话/单点能力页运行并看到报告抽屉。本分支不修改这些范围外文件，也不会把接口探针称为完整产品验收。
