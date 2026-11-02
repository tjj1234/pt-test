# 受控媒体授权持久化及宿主接线（未启用）
结论：复用既有Run预算算法、同Key模型准入、controlled-media-admission和外部操作账，仅补原子授权与slot持久化。没有新预算引擎，没有放开默认零工具profile，没有增加HTTP签发入口或真实付费授权。

## 实现与事务
- 新migration022及media-grant-store-candidate提供可信host issue/getGrant/reserveAttempt，绑定用户/租户/Run/Key scope/模型/任务/revision/adapter/version/provider与有效期。
- reserve核验真实数据库Run租约/运行状态，先锁Run再grant；唯一scope+model+task slot实现跨Run互斥。未知/失败不自动释放，旧grant永久消费。当前没有release API，是保守候选边界，不是完整生产生命周期。
- 既有externalOperations仅抽取createIntentInTransaction，createIntent原接口仍调用它，不重复意图SQL。grant消费+slot+external intent+Run事件共享同一tx；callback后抛错，四者全部rollback。
- handler通过可信loadControlledGrant/reserveControlledAttempt注入选择受控流程；缺依赖拒绝。模型选择来自grant的manual modelId，不来自工具args；fresh同Key目录及既有任务/权限/adapter检查不变。receipt必须证明intentRecorded，避免第二次独立createIntent。
- server未注入此流程，runner仅default/csv，尚未打开真实媒体工具预算；count authorization≠金额cap。maxCost需真实估算/结算证据，不能只改JSON数字假称金额已受控。

## 本轮验证
`node --test tests/regression/media-grant-store-candidate-test.mjs tests/regression/media-route-admission-test.mjs tests/regression/media-run-lifecycle-test.mjs`：21/21 PASS。真实PGlite迁移/关闭重开；隔离、过期/错租约/错route、授权消费一次、跨Run冲突、atomic rollback、宿主未知结果manual_check、无第二次模拟提交。没有PT调用。之前PG4/4是旧草案环境证据，不代表本增量已完成PG并发验收。

## 发布边界
candidate34旧草案保持原始SHA，不包含本次migration/持久化接线；其source-check预期会检测工作区后续变化，不能继续声称旧草案等于当前源码。待主体收口后用新修订冻结，不覆盖旧产物。
待做：真实PG竞争验证、签发入口与受控profile接线、明确授权、媒体报价或费用未知风险的产品边界、显式核对/释放、同版真实业务。Gemini新独立包MEDIA-RESERVATION-RECONCILIATION仅提供核对纯决策，不操作数据库，不自动释放或重试。

## 真实 PostgreSQL 并发补验
主Agent创建仅localhost随机端口+tmpfs的专用PG16 fixture，清除继承PT_PG配置后执行 `tests/probes/media-grant-postgres-review-20261028.mjs`。结果：distinctTransactionBackends=true、observedWait=Lock、blockingVerified=true，successReservations1/conflict1；败方未消费且无intent，callback后失败四者rollback，关闭重开保留unknown slot。providerCalls=0。测试结束关闭专用--rm容器，未连接线上。该证据补足本增量PG并发边界，不等于产品签发/付费验收。
