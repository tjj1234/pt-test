# F3 文本价格目录持久化与调用前绑定（2026-10-27）

已接本地链：审核后的公开文本 USD 价格目录 → 独立持久目录版本 → 每次模型请求前宿主确认 → Run `model_request_intent` 事件。DSH 仍锁定 `0.1.1-rc.2`；四方法/五事件外形保持，`run(spec)` 增加可选 `recordModelIntents`，复用既有宿主 RPC，保留名 `northstar.model_request_intent` 不注册为模型工具。

## 持久目录与维护入口

`021_text_price_catalogs.sql` 新增公开价格目录表；目录 ID 由规范化费率和来源内容 SHA-256 计算。仓储只提供追加导入和按时刻选择，不覆盖旧记录；相同内容重导入不改变原记录时间。完整目录的每个模型区间必须无重叠；换版本导入新的完整目录，旧调用保留绑定目录与费率。来源 URL 只能为 PT 官方价格页，但 URL 相同本身不能证明录入费率正确，必须由维护者核验来源内容。未录入实际官网价格；测试数据明确为 fixture。

维护命令仅支持已存在、已完成迁移的 PGlite，必须先停写入进程；`--offline` 是维护者声明而非进程探测。命令拒绝环境中的 PG 配置及替换 PGlite 入口；不创建数据库，不执行其他迁移，只打印目录 ID、来源哈希和记录时间。输入是本地有界 JSON：`{sourceEvidence: "已核验的官方价格原文", snapshots: [...]}`，快照字段沿用选择器契约。

```sh
node scripts/northstar-price-catalog.cjs import --db-dir /absolute/fixture-or-maintenance-db --input /absolute/reviewed-prices.json --offline --reviewed
```

未新增 HTTP 价格录入接口。目录内容是全局公开定价，不含用户 Key/账户账单。`recorded_at` 使用数据库毫秒时间；选择器不会把调用之后入库的目录补用到历史调用。抓取时间在未来的目录导入被拒；有效价格仍由严格时间区间选择器判断。

## 调用前的持久绑定

Durable Run 启用 `recordModelIntents`；Runner 在通过模型调用预算并取得本次选择后、SDK prepare/send 之前，调用保留 RPC。宿主以受信的 Run/用户上下文校验所选模型，按数据库当前时刻选择目录，将调用 ID、DSH turn/step、所选模型、provider、maxOutputTokens 与完整价格快照写入 Run 事件，写入完成才确认。无可信价格仍允许对话，价格为 unknown；事件/数据库写入失败则不允许请求继续。

Runner 新增 `model-intent-v1` 能力声明；Adapter 对要求记录的任务检查该能力，旧 Runner 缺能力时在派发任务前返回 `DSH_MODEL_INTENT_UNSUPPORTED`，防止静默绕过。此次已重新生成并核验受控 profile 快照，候选 manifest SHA-256 `0a7b5eefd52cf4cc90debe59e643211eb826ee904343887d32d26db8e3f7c471`；不是线上发布证明。

事件的 `submission:intent_only` 明确表示“已记录即将尝试调用”，不证明供应商收到请求或实际扣费。参数覆盖目前为 partial，只记录提议配置中可证实的输出 token 上限，尚未包含网关/SDK 默认参数或网络内部重试。下一步须将响应证据按 turn/step/attempt 关联该事件，再接估算与 UI/CSV；不能按 Run 的首个价格猜所有响应价格。

## 验证

| 验证层 | 结果与范围 |
|---|---|
| 原四方法/五事件兼容 | `runtime-contract-test.mjs` 内 26/26；不是付费真实模型验收 |
| 存储/迁移/登录/SDK 组合 | 18 项 Node tests PASS，含上面的 26 条脚本断言 |
| 最终定向组合 | 24 项 Node tests PASS；其中宿主 RPC 脚本内部 11/11，检查缺能力拒绝、会话隔离、取消/超时 |
| 锁定 SDK 确定性模型 | 两次真实 SDK 请求经过宿主确认；模拟台账失败时 0 个响应且没有工具步骤；不调用真实 PT |
| HTTP/PGlite | 已登录 CSV 对话的保留 RPC 写入 Run 意图事件；未导入价格时明确 unknown |
| 维护 CLI/PGlite | 审核标记、相同导入、来源内容哈希、未来抓取拒绝、重叠拒绝、关闭重开可读均通过 |
| 静态检查 | 全仓 451 个 JS 文件，0 语法失败；`git diff --check` PASS |

未执行真实 PT 请求、生产价格导入、生产数据库迁移、部署或合并。F3 的响应关联、估算金额、界面、真实账单对账仍未闭合；图片／视频开发保持挂起。

## 后续本地链闭合与实际价格候选

既有模型身份事件现在保留 turn/step，`bound-text-estimate.cjs` 只将唯一调用意图关联到同坐标响应：可信 disjoint 用量、所选/上游报告模型一致、有效绑定价格全部具备时输出 estimated；重试歧义/无身份/缺字段/价格区间不适用时 unknown。Run 用量接口附金额、币种、绑定目录与版本及未知原因；结束时持久化 `text_response_estimates` Run 事件。前端“查看本次运行→查看本次用量”提供分页、估算依据、价格版本与 CSV，并明确非 PT 官方账单；未知原因以用户可理解的文字显示。CSV 为 20 列，5,000 行仍在既有 100,000 单元格硬上限内。

从 [PT 官方价格页](https://powertokens.ai/pricing) 与 [qwen3.8-flash 模型页](https://powertokens.ai/models/qwen3.8-flash) 核对一条 Standard 文本费率，保存为 `docs/refactor/candidates/pt-text-prices-observed-20261027.json`。每百万 token 的 USD 费率：普通输入 0.150，输出 0.470，隐式/显式缓存命中均 0.016，缓存创建 0.200。两种缓存读取费率一致才映射到当前合并 cacheReadTokens。抓取时间 `2026-10-27T05:58:07Z`；有效范围仅从观察时刻开始，至次日同一时刻的本地新鲜度上限，不宣称供应商公布了该生效/失效日期。

此文件为单模型、单费率档位的**导入候选**，没有写入产品数据库，没有把该模型加入运行可用目录。其他模型的阶梯价、不同隐式/显式缓存价或缺失 Cache Creation 未推断为 0。固定样例的四项用量通过算术验收为 USD 0.000225；这是确定性测试，不是真实 PT 扣费。

最终八文件定向组合 **33/33 PASS**（选择/仓储/估算/Run用量DB/成功失败中断持久事件/UI/CSV），全仓 **453 个 JS、0 语法失败**，profile 快照与 `git diff --check` PASS。当前候选 profile manifest `12009c6ef485a8509168ded8185baabc68bc000fc909c62f9dd3833c22f58fb2`。

**仍需决定/验收**：锁定 pi-ai 会丢弃与请求 ID 相同的上游模型证据，当前严格策略对普通真实响应可能长期 unknown。已询问用户是否允许“按请求模型官方价格估算，同时上游身份未知”；收到决定前不放宽。实际官网价格导入、真实 PT 同用户端到端、目标环境与完整参数覆盖仍未验收。随后用户已授权 Gemini 并行媒体引擎候选，媒体仍属 F1，前文的整体挂起描述由新的 `F1-PTVIDEO-PROPOSAL-REVIEW-20261027.md` 和工作日志细化。

**后续已获用户决定并实施**：本期接受按请求模型的官方价格估算，上游身份仍独立 unknown；未来 PT 官方接口用于补账单证据，不作为本期依赖。低层估算器新增显式选项 `allowRequestedModelEstimate`，默认仍兼容严格旧调用；已绑定 Run 的估算路径开启此选项，缺上游 ID 也可按请求模型计价，返回 `costBasis=requested_model`。有明确上游同模型证据时为 provider_reported_model；明确异模型仍不猜测。API、Run 估算事件、UI、CSV均附依据，CSV仍20列、5000行上限。17项针对性回归通过，包含未知身份仍保持null但金额为estimated，以及异模型、重试歧义、缺用量仍拒绝估算；静态/空白符检查通过。

### 2026-10-27 F3 请求模型估算：本地 HTTP→台账→CSV→重开数据库贯通
- 扩展 `tests/regression/chat-usage-failure-accounting-test.mjs`：隔离 PGlite 导入明确标记的虚构价格，模型替身经真实服务端内部 RPC 在两次响应前绑定价格；不访问 PT、不使用真实 Key、不发起付费调用。
- 验证同一 Run 的用量 HTTP 返回两笔 estimated/requested_model，providerReportedModel 保持 null；金额分别约 USD 0.0000202、0.0000253，快照版本 http-fixture-v1。全量 CSV 保留 cost_basis，两笔均为 requested_model。
- 持久估算事件保留同一口径；关闭服务后重新打开数据库，usageByRun 的完整响应与 HTTP 返回一致。暂时写入失败、提交成功但 ACK 丢失、持续写入失败仍只执行原有四次模型替身 Run，不重放上游调用。
- 本项 HTTP 回归 1/1 PASS；沙箱禁止监听 loopback，已通过提权运行本地测试。该证据属于离线集成，不代表真实 PT 调用、生产迁移或 F3 整体交付完成。

### 2026-10-27 F3 历史估算不随新价重算；同版本本地集成复核
- 在同一隔离 HTTP/PGlite 回归中，数据库重开后导入费率为原十倍的 v2 目录，确认新调用选择 v2，而历史 Run 完整用量投影仍与最初 HTTP 返回一致（v1、原金额、requested_model、上游身份 null）。无需回写历史估算。
- 三项定向集成 `chat-usage-failure-accounting-test.mjs`、`google-login-integration-review-test.mjs`、`f2-csv-real-sdk-runner-test.mjs` 合计 3/3 PASS。Google 测试为身份替身，CSV 为真实锁定 SDK 加确定性传输，均不证明真实 Google/PT 用户验收。
- `node scripts/ci-check.mjs`：453 个 JS 文件，0 失败；`northstar-profile-snapshot.mjs check`：14 文件 PASS（deployedProfileVerified=false）；`northstar-dsh-manifest.mjs check --manifest shell/runtime/dsh-release-manifest.json`：DSH 0.1.1-rc.2、20 文件 PASS。原默认预算仍为 1 model/0 tool；CSV 特定预算的离线通过不等于默认入口已能调用 CSV。
- Gemini R2 仍独占其三个新文件，本轮未编辑；不部署、不提交、不发付费请求。F1/F2/F3 继续保留真实链路与目标环境交付门槛。
