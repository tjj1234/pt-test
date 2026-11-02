# 显式核对释放候选：本地与真实PG证据
结论：仅可信host显式reconcile(identity,{reservationId})，不接受调用者outcome/force。复用纯函数和已持久外部操作事实，未接HTTP/UI或自动调用，未发PT请求。

新增023迁移保留历史reservation，status扩为reserved/released，slot唯一性只约束reserved；按pg_constraint固定列集合定位旧约束，不猜自动名称。回填provider/revision/adapter快照，INSERT触发器兼容原grant-store；释放写reason/operationId/时间/操作者，旧grant consumed不改。

事务按owned Run→grant→reservation→operation加锁，交叉核验身份与路由快照。未知/未决固定keep；明确终态走已有决策。释放UPDATE RETURNING必须恰好一行，否则回滚。重复核对released幂等；新授权才可占已释放slot。

## 时钟问题与修正
1. reserve同事务内intent.updated_at默认now()可能早于reserved_at=clock_timestamp()：未决记录核对适配层保守keep，不伪造时间或以sleep调整。
2. 实测host观察时间领先DB更新时间1ms（PG fixture差值updatedMinusObserved=-1）：二者来自不同clock，不能额外要求updatedAt>=observedAt。纯契约只要求两者各自不得早于reservedAt，仍保留此约束；新增/修改实际反例证明，不靠容差或改写证据。

## 验证层
- 纯函数53 + release/grant实际PGlite12 = 65/65 PASS。
- 专项 tests/probes/media-reservation-release-postgres-review-20261028.mjs 使用仅localhost随机端口、tmpfs PG16，显式fixture标记/DSN保护。观察真实不同backend及Lock/pg_blocking_pids后释放A commit，B新reservation成功；oldGrant=consumed、historyAudit=retained、unknown=reserved、rollback=status+audit、reopen=persistent、providerCalls=0。
- 第一次PG失败暴露跨clock比较；修正后通过，不隐藏失败或修改时间。专用--rm容器已stop，未访问现网DB。
- 仅候选未启用；candidate34-r3冻结包不含023/release模块，不把本增量证据混作r3包内验证。未来启用仍需产品签发/核对入口与完整同版验收；价格/实际账单/金额cap未证明。
