# T04 纯 Session 调度器独立审查

日期：2026-10-16。审查者未参与调度器实现；阅读任务包T04、`shell/runtime/session-scheduler.cjs`、原自测与T04-scheduler证据后新增 `tests/regression/session-scheduler-review-test.mjs`。未改实现、未连接DSH／数据库／网络、未提交。

**首轮结论：FAIL（共享close Promise契约的一处P2边界），不是核心并发名额失效。** 实跑 `node --test tests/regression/session-scheduler-test.mjs tests/regression/session-scheduler-review-test.mjs`：**18项，17 PASS／1 FAIL，exit 1**；原12项通过，独立6项中5通过。全部使用deferred与明确事件推进，无固定sleep。

| 编号 | 实证反例 | 影响与最小修复 |
|---|---|---|
| SC01 | 运行任务的signal abort listener同步调用scheduler.close；外层第一次close遍历stop时触发listener，而closePromise尚未赋值，内层又创建一份Promise。任务收敛后内外Promise均完成，但引用不同 | 违反模块公开的共享关闭Promise／幂等关闭契约。未看到名额泄漏、重复执行或资源未收敛，严重性P2；应在发送任何abort前建立权威closePromise，再把停止集合结果接到该Promise |

独立通过控制：

- 每用户1／全局2并发下，取消同session中间排队任务，不会执行被取消任务；后继保持顺序，其他用户仍并行，最终active=0。
- execute返回非Error拒绝被规范为EXECUTION_FAILED，释放所有名额并让同session下一任务开始。
- submit后、execute微任务真正调用前failProcess，execute收到已aborted信号，队列不执行；运行槽直到executor收敛才释放，不假装底层已经停止。
- caller修改原context不污染已提交任务；共享非循环子对象合法、深层冻结、权威user/process覆盖spoof值。
- 同进程连续两次failProcess，运行任务最终result保持第一次故障cause，名额回收。

## 适用范围

本模块只调度回调，不负责Agent循环、HTTP鉴权、持久Run、预算、网络副作用、操作系统进程或SDK实际取消。队列上限／分布式额度／持久恢复在原实施说明已明确为后续接线责任，本轮不把这些缺失当模块自身bug。

取消在execute微任务前发生时回调仍被调用，但收到已aborted signal；这是当前「名额已分配即running」模型，集成executor必须先检查signal，不能据此宣称已经阻止付费提交。若产品要求未实际启动的executor绝不调用，需另明确状态与协议，本轮未将其列为违约。

真实DSH同进程session重叠、取消收敛、工具/报告局部状态、cwd、副作用与文件隔离均未验证；本组纯调度测试不能作为T04整体完成依据。失控executor永不settle时close持续等待是明确设计，不能靠超时假释放；进程生命周期层仍需处理失控状态并桥接T03事实。

## 独立复验：SC01已修，本组纯调度边界通过

日期：2026-10-16。独立审查者读取修改后的close实现，确认先创建并赋值closePromise、再发送同步abort；未修改原独立review测试或实现。重新执行：

```bash
node --test tests/regression/session-scheduler-test.mjs tests/regression/session-scheduler-review-test.mjs
```

结果 **19/19 PASS，0 FAIL，exit 0**：原独立6项全部通过，实施测试现13项（含新增重入回归）全部通过。SC01反例中abort listener内的close、外层close与后续close现在返回同一Promise，均等待任务真实收敛。之前配额、FIFO、故障、冻结与取消控制保持通过。

当前结论更新为 **PASS（纯Session调度模块及本组边界）**，首轮FAIL保留作为返工历史。不扩大为真实DSH多Session验收：SDK、持久Run/事件桥接、HTTP、模型、工具副作用与进程恢复仍需后续独立验证。
