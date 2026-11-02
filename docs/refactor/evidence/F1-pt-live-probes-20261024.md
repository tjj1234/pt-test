# F1 当前 Key 真实 PT 探针与响应时间（2026-10-24）

**结论：真实 PT 目录及两种文字模型、一个本地 DSH 文本 Run、文生图和图生图已获得限定成功证据；两种视频任务未通过，F1 仍不可交付。** 探针使用用户明确授权的测试 Key，Key 仅由进程标准输入接收；此文、工作树、命令参数及输出均不含 Key。直接 PT API/本地 DSH 探针不是目标站浏览器、持久 Run、候选发布或 PT 账单验收。

| 路径 | 请求/结果 | 响应时间 | 证据边界 |
|---|---|---|---|
| `GET /v1/models` | HTTP 200，82 项，无显式下一页 | 响应头 833 ms；JSON 完成 840 ms；本地 catalog 归一化首次 1515 ms、修正后 2823 ms | 只读、当前 Key；目录可见不证明每项实际调用成功 |
| `POST /v1/chat/completions` · `deepseek-v4-pro` | HTTP 200，返回身份相同，`OK`；reported usage prompt 88、completion 27、total 115 | 响应头 4179 ms；JSON 完成 4184 ms | 直接 API，最多32输出token，1请求/0重试；usage不是账单金额 |
| `POST /v1/chat/completions` · `qwen3.5-flash` | HTTP 200，返回身份相同，`OK`；reported usage prompt 15、completion 203、total 218 | 响应头 3033 ms；JSON 完成 3037 ms | 直接 API，最多32输出token，1请求/0重试；reported completion大于所设max_tokens，不能把参数当成本上限 |
| 本地 DSH adapter · `deepseek-v4-pro` | `ok=true`，2字符结果，1个delta，usage字段存在 | 首个delta 4824 ms；完成 5079 ms | 单模型、0工具、0重试、90秒超时；没有持久 HTTP Run/浏览器/切换证据，usage数值未与账单核对 |
| 本地 DSH 同会话 A→B | A=`deepseek-v4-pro`，2字符/1 delta；B=`qwen3.5-flash`，45字符/9 delta；均`ok=true`且usage字段存在 | A首delta/完成 2985/2986 ms；B首delta/完成 819/1228 ms | task frame请求了两个不同模型，DSH结果未返回上游实际模型ID；不能单靠此项签署真实模型切换或目标站验收 |
| `media.route` · 文生图 `seedream-5-0-260128` | 1 POST，HTTP 200，结果 URL 存在，无task ID | POST响应头 17529 ms；完成 17538 ms | 直接调用媒体模块，1张2048×2048测试图；未验证Agent结果登记与历史 |
| `media.route` · 图生图 `seedream-5-0-260128` | 使用上一张测试图；1 POST，HTTP 200，结果 URL 存在，无task ID | POST响应头 39565 ms；完成 39576 ms | 直接调用媒体模块，未验证Agent结果登记与历史 |
| `media.route` · 文生视频 `wan2.7-t2v` | 1 POST尝试；传输失败，未收到响应/task ID；**上游结果未知，不重提** | 10551 ms时失败 | 无HTTP状态、无可核对task ID；需PT任务/扣费日志判断是否执行 |
| `media.route` · 图生视频 `wan2.7-i2v` | 1 POST，HTTP 403，未取得task ID/结果 | 响应头 1056 ms；结束 1066 ms | 403原因未确认；不把目录列出该ID视为此任务获准 |

文生图结果 URL 另以一次不带 Key 的 GET 验证：HTTP 200、`image/jpeg`、2048×2048、119,992字节，响应头1266 ms、下载完成8945 ms、SHA-256 `3730be1b01a4450f902ee6ccbbd33006f3dcb5235189c349bb4e0a5d79daa550`。实际图像已目视核对为白色背景上的蓝色陶瓷杯，与测试提示相符；保存的[图像证据](assets/f1-pt-t2i-20261024.jpg)不包含Key或原资源URL。此项只证明该时点资源可读，不证明Agent历史可恢复、链接长期有效或目标站能显示。

所有付费探针每个组合最多一次POST、零重试。文生视频与图生视频分别是独立任务；视频GET状态轮询均为零次。`wan2.7-t2v`意图于 **2026-10-24 10:49:24 UTC** 记录，10:49:34 UTC 记录未知错误。用户确认没有此Key对应账户的登录权限，无法取得控制台任务/扣费记录；本轮跳过账单核对，不再请求该材料。T2V是否执行或扣费仍为未知，不能自动重提；I2V的403原因未证实。无可信账单行，本文不声称实际费用或扣费状态。

真实目录当前只给这些代表模型的`id`和`supported_endpoint_types`，未给`capabilities`、`supported_tasks`、`input_modalities`、`output_modalities`。原本把通用`openai`端点直接解释成textChat，导致82项里58项被标为可聊；实际`openai`同时出现在图像、视频、语音模型上，其中27项无`anthropic`/`openai-response`，17项另有明确媒体端点。已从聊天推断移除通用`openai`，复测明确聊天端点31项、文生图11项、文生视频29项；图生图/图生视频在API目录中均无独立任务事实，须结合官方模型文档、运行验证和受控登记，不能靠名称推断。原本线上r2的`MODEL_CATALOG_INTERNAL_TYPE_ERROR`在本地新鲜目录未复现；目标机旧缓存及阶段码证据仍缺。

已保存该次82项的[脱敏目录矩阵](F1-current-key-directory-matrix-20261024.json)：仅含model ID、端点标签和目录任务提示，**不含Key、价格、权限通过结论或运行验证结论**。其任务提示不能直接作为可调用列表。

本地 DSH 初次探针在发请求前被`DSH_LOCK_MISMATCH`拒绝，因为当前dirty `shell/package-lock.json` SHA与旧`dsh-release-manifest.json`绑定不一致。仓库生成器确认新旧manifest唯一差异是lockfile SHA；更新工作树manifest后，生成器`check`及`resolveDshInstallation`均通过，锁定DSH 0.1.1-rc.2、20文件。此修改不是冻结候选或目标发布证明。

PT官方模型页确认选定模型的声明范围：[Seedream 5.0](https://powertokens.ai/models/seedream-5-0-260128)含文生图/图生图及`/v1/images/generations`，[Wan 2.7 T2V](https://powertokens.ai/zh-Hans/models/wan2.7-t2v)含文生视频，[Wan 2.7 I2V](https://powertokens.ai/zh-Hans/models/wan2.7-i2v)含图生视频及`/v1/videos`。官方价格随参数变化；页面价格仅用于事前估计，不是本次实际账单。无Key的`HEAD /v1/videos`从本机返回HTTP 404（该方法/路由无匹配），约1秒到达网关，不能解释有Key的POST失败。

优化用时间口径：上表是单次观测，不是P50/P95；直接非流式API的响应头时间接近完整响应，不能当首token。DSH的`firstDelta`才是本地流式首增量；从本地进程开始计，包含启动/协议/模型等待。同会话A是冷启动、B是热会话，不能直接拿二者时长比较模型本身速度。后续同候选目标浏览器应分别记录请求受理、首delta、完成、媒体POST响应、轮询终态、资源可见、刷新重开时间，并汇总多次分布；未知结果与失败单独计，不与成功样本混算。

## 用户提供的PT账单项目与wan Skill经验复核

读取[pt-usage-dashboard README](https://github.com/PowerTokens/pt-usage-dashboard/blob/main/README.md)及[抓取脚本](https://github.com/PowerTokens/pt-usage-dashboard/blob/main/scripts/fetch_pt_server.py)：逐笔金额、额度、余额来自网页登录会话的私有`www.powertokens.ai/api`，认证是`_Bearer` Cookie原值；模型API Key用于`api.powertokens.ai/v1`，**不能替代网页登录会话抓逐笔账单**。脚本查询`POST /usage-records/list`、`/bill/balance`、`/dashboard/usage`、`/dashboard/model-consume-rank`和`/usage-records/daily-quota`；账单逐笔记录有`consume_id`或`request_id`及`consume_time`、`amount`。用户没有此Key对应账户的登录权限，故该项目目前不能用于本次调用的服务端账单核对；此项记录为不可取得的证据，后续工作不以用户提供该账单为前提。不可把聊天usage、响应状态或估算价当成实际扣费。该项目代码遇月份/页请求失败会警告后继续，日窗口触上限亦可能留下缺口；若未来用于其他可登录账户的验收，应同时检查查询完整性、时间窗、请求ID匹配及账户范围，不能只看生成看板总额。

用户提供的wan Skill踩坑档案与现有`business/media/powertokens.cjs`对照：`completed`、产物URL、100%进度已作为成功兜底；429与5xx独立计数；本地轮询上限没有解释成PT服务端上限；未知提交结果不能自动重投。本轮发现现有轮询对**任意非空未知状态**都会清空异常计数，仍可静默等到守护超时；已将进行中状态改成显式词表，未知枚举进入40次熔断。媒体POST的403仍只携带上游原文，尚无经过真实错误体验证的QUOTA/AUTH/NOT_ALLOWED分类；这次I2V的403不能据HTTP码单独归因。wan档案的具体阈值与错误字样属于用户提供的另一项目经验，不直接推定本Key/本模型当前网关行为。Northstar付费媒体入口在资格未知时保持拒绝，不采用wan Skill的目录失败放行规则。
