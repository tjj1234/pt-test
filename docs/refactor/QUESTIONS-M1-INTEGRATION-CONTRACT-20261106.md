# 05/06 M1主程集成契约
范围冻结：基于R31源码接Gemini d78d5c9的**普通澄清问答**；审批/FS/脚本执行保持关闭，不接其他七包，不部署。真实底座继续由DSH UserQuestionService、tool-ask-user和既有Run/Runner/工具预算负责，不新建Agent引擎。主程负责仓储、事务、可信scope、RPC、owned API和UI。R5作者23项及旧scope2项已复跑通过，但跨worker答复后原Promise误超时已复现，须在集成实现中修正，不要求用户逐个转发。

| 接缝 | 唯一可信来源与线性化点 |
|---|---|
| 身份/Run | 服务端已鉴权identity和现有durable Run；浏览器不提交user/tenant/Run状态；Runner任务的既有受信RPC闭包绑定同一Run |
| 原生call | tools/execute现有预算门禁验证exact live agent/current call后，AsyncLocalStorage绑定callId/signal/active turn；ctx.userQuestions provider只在此上下文有效，不接受模型自报scope |
| 问题键 | 生产表复合键(run_id,call_id,question_id)，Run行再绑定tenant/user；不以冒号拼接当无歧义scope，不复用裸questionId跨Run查询 |
| 首次持久化 | 现有db.transaction先SELECT owned agent_runs FOR UPDATE，再检查真实状态/租约与取消墓碑；同一事务写问题和state事件/seq，提交后才可显示 |
| 答复/期限 | 固定Run→question锁顺序；取得全部行锁后单独读clock_timestamp()，再判断期限/Run/身份/状态；answered、expired、cancelled只有一个终态，禁止用锁前now或UPDATE筛选时钟冒充锁后判定 |
| 创建/取消竞争 | Run行锁串行化；取消墓碑与所有pending终态同事务，创建即使稍后到达也不产生可答pending；实际Run终态/失效租约同样拒绝答复 |
| 等待/双worker | 等待方定期读取生产权威记录；本地timer只发起expired CAS并读取结果，不凭timer触发单独宣布超时；其他worker答复后也返回同一权威answer，重开复用原deadline/终态 |
| 存储失败 | 返回STORE_UNAVAILABLE/Run失败，不报成功或伪造expired/cancelled；不自动重投模型；取消/清理须解除timer、poll、signal，残留pending由后续owned读取按Run/期限核对 |
| 展示/API | 现有durable state事件投递问答提示；GET owned Run questions支持刷新重开，POST严格answer/callId schema并复用Gemini验证；UI只用textContent，按钮重复提交由CAS拦截，不自动回答/批准 |
| 重启 | 旧原生Promise/进程不复活，Run失去合法worker后问题不可答；历史持久问题可显示终态。禁止借问答答复重提旧模型/工具或恢复审批token |

适用矩阵：原生SDK往返、坏schema/选项、同ID同参/异参、同questionId跨call/Run/tenant/user、锁前与锁后deadline、持锁跨期、timer延迟/被阻塞、双worker一胜、取消前/中/后创建、晚答复、已终态重开、存储失败、signal/poll清理、Run终态/租约失效、owned API跨用户、真实UI刷新/作答与Run继续。PG/PGlite必须直接调用生产仓储，测试内adapter不算生产实现；SQL锁等待deadline另用真实PG双连接验证。安全关闭项只验拒绝，不声称能力完成。
主程按本契约施工和复审；新增范围另登记，不将所有未来审批/沙箱功能塞入M1。作者d78d5c9工作树和当前R31线上不改。
