# T04 · Session 调度辅助模块

日期：2026-10-16。分支 `feature/northstar-phase1-refactor-20261016`。状态：**纯模块与受控异步行为自测通过，未接入 server／runner／SDK，不代表真实 DSH 并发或 T04 完成。** 同一实施者追加对抗用例属于自查，不能替代未参与实现的独立验收。

## 建议接线接口

`createSessionScheduler({perUserLimit=2,globalLimit=8})` 提供 per-user、全局并发额度和按 `(userId,sessionId)` FIFO。`submit({runId,userId,sessionId,processId,context,execute})` 返回 `{result,cancel,getState}`。可信服务端传身份与关联对象；execute 接收 `{signal,context}` 并调用既有 Runtime，不在本模块创建 Agent 或 Session。context 经有界 JSON 检查、拷贝与递归冻结，权威 run/user/session/process 字段覆盖传入 context 的同名字段。

| 方法 | 行为 |
|---|---|
| `submit` | 立即开始有名额任务，否则排队；活跃 runId 重复拒绝。按最早可运行条目选择，阻塞用户不拖住其他用户 |
| `cancel(runId)`／handle.cancel | queued 取消不调用 execute；running 发 AbortSignal，但等 execute Promise 真正收敛才释放 session／user／global 名额 |
| `failProcess(processId,cause)` | 标记该进程全部 queued／running 任务失败并阻止新任务进入失效进程；running 仍等待执行收敛，其他进程任务不受影响 |
| `disposeSession({userId,sessionId})` | 停止该作用域全部任务，queued 不误启动，等待真实收敛；该 Session 标识此后拒绝新任务 |
| `close()` | 停止接收任务，取消队列与运行任务，返回共享关闭 Promise；等待运行收敛后完成 |
| `stats()` | 运行、排队、活跃数和关闭标记，用于接线观测，不是持久任务事实源 |

运行中 cancel 的 getState 保持 running，直到实际收敛后 cancelled；收到取消不冒充已停止。若取消与共享进程故障竞争，结果以 PROCESS_FAILED 收尾；AbortSignal 保留第一次 abort 原因（JS 原生语义），最终 result 反映权威故障。异常、同步 throw、取消均回收名额；完成后再 cancel 不改终态。

## 实测

命令：`node --test tests/regression/session-scheduler-test.mjs`。结果 **12／12 PASS、0 fail、0 skip**；约 36ms。`node --check shell/runtime/session-scheduler.cjs` 与 `git diff --check` exit 0。全部使用显式 deferred/barrier 推进，没有固定 sleep、网络、数据库或付费模型。

覆盖：两个 Session 开始区间重叠；三个同 Session 严格 FIFO；相同 Session 标签跨用户独立；每用户与全局额度；阻塞用户不堵其他用户；queued 取消不执行；running 收到 AbortSignal 后未收敛不放名额；取消 A 不影响 B；上下文深拷贝／冻结；异常后复用名额；共享进程失败覆盖 queued／running 而不影响健康进程；dispose／close 不误启动队列且等待收敛；重复取消同等待结果；取消后故障覆盖原因；AbortSignal 回调尝试提交替代任务不能突破未释放额度；已完成任务不能被追溯取消；非法 context 和重复活跃 runId 拒绝。

## 尚未证明与接线责任

模块只调度传入回调，不含 Agent 循环、模型路由、DSH Session、数据库或子进程操作。尚无 SDK 并发、真实停止、cwd／工具副作用、模型切换、真实事件／报告局部性证据；不得据 12 项本地用例宣称生产多 Session 已完成。若 SDK 取消不收敛，名额与 close 会持续等待；本模块不定时假释放或擅自杀共享进程，失控处理由进程生命周期层决定并标记受影响任务。

身份、Session／process 映射来自可信服务端；模块不能自行证明传入对象来自登录态。必须先持久化 Run，再 submit；队列不持久化，重启以 T03 store 恢复，不能据此实现恰好一次。取消／故障结果须桥接持久 state/event；新进程必须使用新的 processId，故障标识不可复用。disposed Session 需要新的生命周期标识或重建调度器，不把删除再创建混为同一个已 disposed 实例。

仅限制执行并发，不含排队长度、租户容量、预算或分布式额度；服务层需按持久任务策略提供入队配额与背压。调度器不拥有可信外部 Runtime 进程，不直接 dispose SDK。完成记录从活跃 Map 回收；失效 process／disposed session 标识保留到调度器关闭，长期运行规模需按生命周期治理。文件只新增本模块、测试和本证据，未改共享接缝、未提交。

## 独立首验 P2 返工：同步重入 close

独立验收者复现：close 在 stop 发出同步 abort 事件之后才完成 closePromise 赋值，execute 的 abort listener 若重入 close 会看见第二个 Promise。已修为先发布共享关闭 Promise，再逐项 stop 并收敛完成；不提前释放任务额度，不改变已有取消语义。实施测试增加一个同步重入反例。`node --test tests/regression/session-scheduler-test.mjs tests/regression/session-scheduler-review-test.mjs` 实跑 **19／19 PASS**（实施 13＋独立 6）；未修改独立 review 文件。此处是修复方自测记录，最终独立结论由维护验收者另行复核。
