# attribution.quality v1
真实业务技能 `attribution.quality`，`outputType: report`，只读；规则生成建议，无大模型调用。变更只在 `business/attribution/`，不改数据库结构或 Shell/UI。评分仅反映六类事件类型覆盖与登录后事件 user_id 完整性，不能作为完整埋点质量认证。

## 基座接线契约
公开入口 `require('business/attribution').quality`（使用仓库相对路径）。定义：`quality.attributionQualityToolDefinition()`；执行器：`quality.buildAttributionQualityExecutor({ internalKey, dashPort })`，返回 `(args, context) => Promise<report>`。参数仅 `from/to`（YYYY-MM-DD，UTC、含结束日，默认最近七天含当日，最多31天）；`context.tenantId` 必须来自登录鉴权。工具权限 `tool.use` + `attribution:read`。服务端 `GET /api/attribution/quality` 已通过现有归因路由注册在生产统一服务，复用 token、scope `analytics:read`、过期校验、workspace 派生。客户端不能指定 tenant/workspace 或计数。

基座待做：autoload provider 的 getter=`quality.attributionQualityToolDefinition`，executor 工厂调用上述公开导出。目前 `shell/persistent-runner.mjs` 仍逐个注册 DSH 工具，并仅在 ga.query 执行时保存 `lastReport`；还需注册对应 DSH 工具并将本技能的 report 写入现有 report 帧。首页卡片的样本预览需由 UI 替换为真实调用；这些路径未改、未宣称端到端接线完成。禁止 executor 新建内存 adapter/质量 store。

## 数据与口径
| 输出 | 来源 / 计算 |
|---|---|
| 关键事件类型覆盖率 | `pt_events` 当前租户窗口内观测到的六类事件数 / 6；未发生不等于未配置 |
| 登录后事件 user_id 完整率 | 非 visit 事件中 user_id 非空且非空白的记录 / 非 visit 总数 |
| sGTM 日志有效 ID 重复率 | `ss_gtm_debug_logs` 中重复 UUID 的多余记录 / 有效 UUID 记录；同 UUID 忽略大小写 |
| sGTM 日志有效 ID 率 | 有效 UUID 日志数 / 当前租户窗口日志数 |
| 分数 | 有登录后样本：100×(0.6×类型覆盖率+0.4×user_id完整率)；只有visit样本：100×覆盖率；没有归因样本：null |
| 不支持 | 实际已配置埋点数、跨域丢失率、整体参数合规率、GA4 数据查询 |

SQL 使用一致性只读事务、`set_config` RLS 与显式 tenant WHERE；时间窗左闭右开。`pt_events` 已去重且包含实时接入和事件 CSV，现有表无法区分来源。Debug 日志仅是已导入样本，不能推断整个 sGTM 流；没有日志时重复率为未评估，不显示0%。报告包含 `score/stats/table/suggestions` 和分子、分母、窗口、来源及限制。

## sGTM 设置检查
| 发现 | 状态 / 影响 |
|---|---|
| 连接测试使用错误 secret 头 | 已修复：增加 Collect/raw-collect 实际要求的 `X-PT-Webhook-Secret`；原有两种头保留兼容。真实统一服务复现旧头401，修复后正确密钥200、错误密钥403 |
| 向导默认地址 `/api/v1/collect/...` | 此地址只接收标准事件三件套；设置中的原始名映射应配合 `/api/v1/raw-collect/{existing_webhook_id}`。若 sGTM 发送 page_view/sign_up 等原始事件，使用 raw-collect；标准化上游可继续 collect |
| 原始接入不自动写 Debug 日志 | 当前只有日志导入辅助函数/seed 写 `ss_gtm_debug_logs`，没有生产 Debug API 自动抓取或用户导入入口。重复率可能长期未评估；需要后续日志接入任务，不能把内存适配计数冒充重复率 |
| 连接成功不等于完整业务链路通过 | 探针只证明服务接受事件；不证明六类业务事件、广告花费、上游容器转发、落库都正常 |
| 向导完成记录 | `workspace/connected` 是显式记录；raw-collect 路径没有自动 markConnected，UI 的首条实时事件自动记录描述缺少实现证据 |

以上设置问题除请求头修复外为当前代码核查结果；没有连接用户生产 sGTM 容器，未修改真实容器或租户设置。

## 验证
`node --test business/attribution/quality/quality.test.js`：真实 PGlite、真实统一 Fastify 服务、真实本机 HTTP executor、真实报告渲染组件；跨租户、scope/过期/非法token、日期、重启持久化、空样本、日志重复、评分分母、Collect与raw-collect连接测试。测试数据由隔离数据库中的合成记录生成；不是用户生产数据。入队回调为测试替身，因此连接测试不证明真实 worker 落库。
回归：`node tests/attribution/a17-ingestion-adapter.test.js`、`node tests/attribution/b12-raw-ingest.test.js`、`node tests/attribution/a19-attribution-api.test.js`。
