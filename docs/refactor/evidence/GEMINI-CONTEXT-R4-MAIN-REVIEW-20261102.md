# Context R4主审｜暂不接入同版链
结论：BLOCKED_FOR_INTEGRATION。候选的原4项单元及原探针独立复跑通过；主审新增8项可复用反例均失败。原件保留，不接Runner、不启用压缩、不以开发者PASS摘要替代验收。

复跑：`node scripts/northstar-chain-checks.mjs --chain context`。入口同时运行原单元、原探针与主审回归；当前非零退出是阻断结果。明细及源码SHA见`context-chain-checks-20261102.json`，独立反例入口为`tests/probes/context-admission-main-review-20261102.mjs`。每个反例可以在修正后转绿，不能修改期望来接纳旧缺陷。测试仅受控dispatch，真实providerCalls=0。

| 主审反例 | 现状与接入风险 |
|---|---|
| 缺budgetAdmission仍可签ticket | 准入证据被做成可选，不能证明普通chat已经计入预算 |
| 缺runId/provider/model仍可签ticket | 绑定退化为可选比较，无法满足确切Run/模型约束 |
| Infinity TTL接受 | 有效期不受有限时间限制 |
| await意图期间更换活动Run | 只检查旧对象取消标志，没有重新比较当前活动Run对象，仍dispatch |
| 实际输出上限 | turn.maxOutputTokens=8而请求maxTokens=1024，未被约束 |
| 审计异常泄漏 | INTENT_AUDIT_FAILED错误正文拼接原始异常 |
| recordEvent异常后的settle | 观测回调抛错后未释放已准入操作 |
| 未消费流return | generator尚未进入时return不执行finally，已准入操作未settle |

原生入口证据仍不足：原探针以`auto:false`创建引擎；`ctx.commands.execute(dummyAgent,"/compact",...)`断言“No compactable history yet.”，随后对包装对象直接`compactionEngine.summarize`。这证明锁定引擎与空历史命令入口可运行，没有证明真实Agent/loop自动压缩或维护Run手动压缩发生且投影正确。原报告所称触发事实不能提升为产品验收。

修复方向：使用宿主真实预算操作句柄签发完整一次性绑定；配置有限容量/TTL；首消费及异步审计后重查当前活动Run、deadline/取消/模型；确保所有throw/return/未消费/abort路径资源有界且settle一次；固定脱敏错误；实际LLM请求强制输出上限。保留DSH原生压缩引擎，补真实Agent自动与command-compact维护Run探针；不再接受直接summarize替代入口验证。该阻断不阻止其他独立产品链机械检查及开发。
