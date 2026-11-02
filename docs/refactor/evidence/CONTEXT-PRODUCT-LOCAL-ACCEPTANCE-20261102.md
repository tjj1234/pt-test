# Context 原生压缩与恢复：本地主审验收
结论：LOCAL_CHAIN_CLOSED。主Agent接受当前本地同版链；未证明真实PT摘要质量、实际扣费或目标生产验收。

使用锁定DSH的compaction-basic、token-meter和session-persistence-jsonl。真实原生pressure钩子在默认80%阈值/16%最近历史保留比例下替换旧表面；没有用直接summarize冒充自动压缩。宿主对话菜单提供手动压缩，仍进入持久Run；真实Chromium验证菜单、完成结果和刷新历史。测试完整停止Shell及原生进程，在同一数据库与原生持久日志上重启，验证检查点恢复、旧长原文不与摘要重复重放。内存仅作为热缓存；恢复绑定owned conversation及当前Key SHA，客户端不能提交nativeSession覆盖。

普通模型请求由agent/request单次预算准入并签发宿主一次凭证；llm/stream只消费匹配活动Run的凭证，不重复计数。压缩绕过agent/request，独立通过辅助准入及持久模型意图。自动摘要与回答恰好两条意图、两个SDK usage响应、modelCalls=2。摘要事件独立保留usage；压缩中取消、未提交summary的辅助响应明确记录context_usage_incomplete，不能变成零费用证据。摘要没有可证明的主回答turn/step关联时，不伪造价格/实际账单关联。

组合预算是显式配置：三份profile均maxModelCalls=3、contextModelCalls=1；普通调用最多2，辅助最多1，不能互相借用。普通profile允许1次恢复重试；CSV/受控媒体仍maxRetries=0、maxToolCalls=1、原有单工具/任务授权范围。媒体外部提交和不可重复的reservation门禁不变，不是提升到3次媒体生成。输出上限保持128/512，原生摘要128；仍为受控本地验证限额，不作生产容量承诺。工具拒绝后不再发起后续模型请求掩盖失败。

资料/记忆撤销清除数据库native session映射、停止活动Run并关闭温会话，旧检查点不能被冷恢复复活。真实原生测试覆盖压缩期间停止、取消后清理并重新对话；失败辅助usage保持未知。10项主审反例全部通过，包括完整绑定、TTL、活动Run替换、冻结请求输出超限、审计脱敏及未消费return结算。

可复跑：`node scripts/northstar-chain-checks.mjs --chain context --browser`。源码绑定JSON、unit-review/main-regressions/probe/http-sdk日志及context-browser-20261102.png。原Gemini探针保留为局部摘要回归，auto:false/空历史入口不作为产品验收证据。推理/XLSX/检索/记忆四条共享链均在同版重跑通过。新增迁移027与受信profile模块；依赖锁文件未变。实际付费调用0，未部署。
