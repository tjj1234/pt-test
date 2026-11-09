# R34：作者回复独立复审与问答存储定位（2026-11-09）
结论：已读取用户追加的 Bug、Gemini、QA 回复。第三批 Bug 882f532 与 Web04 7873766 尚未整体放行；R34 仍按八包、全部 Bug 与 QA 修复统一交付，暂停正式部署。作者自测通过与主审、集成、上线、业务验收分别记账。原回复文件保留，不覆盖。

## 版本与证据
| 输入 | 精确绑定 | 本轮结果 |
|---|---|---|
| 用户追加回复 | 原文件 SHA256 `40ab7fe77bc0bea6607baebe212b9458b333ec7622863d62120959bef871cbd3` | 完整读取；QA 事实与根因推测分开复核 |
| Bug 作者 | `882f5322267eb01ba86ae290153ca1dbe51d5f4c`；累积补丁 `a39a5dc551182e53b4b9cb03648853e8cc7c3328192ccad118bbd1ecd891173b` | 删除 persistSteps 猜模型兜底确认；新流式测试四场景断言复跑通过、进程退出 0；不足以覆盖真实 HTTP/server 生命周期 |
| Web04 作者 | `7873766587e078d3f9b1e82dfa74a31aee8ed705` | 上轮反例改善确认；新增生命周期与限额反例四项重现 |
| QA 失败 Run | `58653c59-d6ad-49e2-8846-134bfaad1b0c` | 首次有效参数→TOOL_REQUEST_FAILED→重试 RUN_TOOL_CALL_LIMIT；questions GET 为 STORE_UNAVAILABLE，来自 QA 回报，未重新访问生产 |

## 问答：本地复现存储权限缺口，正式根因仍待核验
R33 部署脚本 `R33-DEPLOY-VERIFIED-20261106.sh` 的 run_migration 用 postgres 运行迁移。隔离 PostgreSQL 16 重现旧表归运行账号、新 029 表归 postgres、迁移标记已存在的部署顺序：运行账号 list 抛 42501、ask 返回 STORE_UNAVAILABLE，不产生问答卡。仅给运行账号两张表 SELECT/INSERT/UPDATE 后，同一生产 service 完成 pending→用户回答→持久 answered。证据：[隔离实验](R33-QUESTION-PERMISSIONS-20261109.txt)，探针 `tests/probes/r33-question-migration-permissions-20261109.cjs`；未改变 import 或 RPC 名称，无生产写入或付费模型调用。
这证明部署权限缺口能产生同类故障，尚不证明线上该 Run 的唯一根因。下一部署门禁必须核对实际运行 DB role、两张表 owner/has_table_privilege 和脱敏数据库错误；备份恢复、迁移及问答读写要以实际运行权限验证，不能只用 postgres 验证迁移数量。若证实缺权，按显式表级最小权限修复，禁止 PUBLIC 全权限或让应用改用超级用户。新增 030 尝试表同样纳入运行权限审计；本轮没有在线 GRANT。
QA 建议把 Runner import 改为 `./runtime/native-question-provider.mjs` 不应照做：生产 adapter 的 PROFILE_SOURCE_FILES 已把该 helper 复制到 profile 的 Runner 同目录，`./native-question-provider.mjs` 符合生成布局。模型工具名 ask_user_question 与内部 RPC northstar.user_question 本来通过 provider 转换；不能仅凭名称不同认定断链。已有 e72bff8 的参数预检/预算修复保留为独立健壮性修复，不能称为已修复本次 STORE_UNAVAILABLE。

## Web04：旧反例通过，但原清单尚未闭环
精确作者模块零网络复跑：四个私网 IPv6、括号回环、NaN 请求限额、最终私网 URL 均拦截；不配合后端时 wrapper 可在取消/timeout 返回。新增证据：[四项反例](WEB04-R2-LIFECYCLE-LEAD-20261109.txt)，探针 `tests/probes/web04-r2-lifecycle-review-20261109.cjs`，所有合成后台 Promise 均释放。
| 原门禁 | 本轮可重现问题 | 必须修订及验收 |
|---|---|---|
| W04-R1-02 | 仍先请求 ctx.web.fetch/customFetcher、再检查 final URL/hops；预解析结果未传给连接层，默认 DNS 空数组 | 交付可信 transport 契约或复用锁定 DSH transport 的真实约束证据：请求前逐跳策略、DNS 与实际连接绑定。后验拒收不证明未访问危险目标 |
| W04-R1-03 | resolveHostnameIp 在 withDeadlineAndAbort 之外：timeoutMs=5、40ms 仍 pending | deadline/取消覆盖 DNS、连接、重定向、读取全过程；所有 fixture 释放且晚结果不入库 |
| W04-R1-03 | timeout 返回 FETCH_TIMEOUT，但 backend 没有收到已取消 signal | 内部 AbortController 联动外部 signal 和 deadline；销毁/关闭实际资源，不能把 Promise 竞争等同无泄漏 |
| W04-R1-04 | 构造配置 maxBytes=Infinity、请求不传 maxBytes 时，11MiB 内容成功越过 10MiB 硬上限 | 配置和请求共用有限整数校验；流式累计/解压限额在读取中执行，不能全量读取后才比较 |
| W04-R1-05 | customFetcher 返回 statusCode=500 仍 ok=true | 定义并强校验 transport 状态契约，失败响应不得转成成功正文/引用；错误信息脱敏 |
继续要求原矩阵一次性交付，不只针对上述样本。resolveContext 接口可由主程注入可信身份，默认 dsh-run/dsh-tenant 仍不得作为隔离证据；本轮未接入生产入口。

## 第三批 Bug：代码改善成立，E2E 证据仍不足
`65646de..882f532` 的 server 差异确认删除 mediaModelFallback，缺失实际 step.modelName 时记 null。最新流式测试使用真实 conversations 模块与 PGlite，并从生产 adapter 源码经 VM 暴露内部函数；四场景复跑通过。这是模块集成证据。
测试仍自己拼 partialMsg 并直接调用 saveMessages，空文本分支也复制 server 条件；没有经过真实 HTTP/Run/server 的停止→落库路径。PGlite 内存实例未关闭重开，读取同实例不是重启恢复；error/close/lease loss、真实刷新、跨进程并发和幂等仍缺证据。测试还硬编码主工作区 node_modules 路径，应改为本包依赖解析。请补真实链路矩阵并逐项 PASS/FAIL/BLOCKED，不把当前测试命名当作端到端验收。
B3-07 真实审核价格和导入仍未完成。删除假价格并显示 unknown 是正确底线，不代表单价快照已交付；不得硬编码来源不完整的缓存写入价/生效时间。主程保留受控导入责任。

## 后续与边界
主程继续推进运行权限门禁、共享接线、真实链路验证；作者按原矩阵修订并提供精确提交与证据。本轮不改作者分支、不覆盖用户回复、不发布旧 AUTO M1 包。01/02/03/07、05审批/06隔离及08费用证据的既有全量范围阻断继续有效，不能因两份局部交付宣告八包完成。Bug-12 继续 DEGRADED_PREVIEW。
