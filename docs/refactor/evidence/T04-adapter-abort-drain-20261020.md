# T04 adapter abort drain — 2026-10-20

**结论：** `dsh-adapter` 在取消已派发任务时不再因 `aborted` acknowledgement 立即 resolve waiter；取消中的 waiter 保留到后续 runner `done` frame。受控 JSONL child 回归 1/1 PASS；T16 对源码和测试作静态独立复核 PASS，未重跑测试。该结果关闭“abort ack 早于 done 时 adapter 立即释放 waiter”的窄缺口，不证明真实 DSH turn、持久 conversation lease 或生产资源已收敛。T04 保持 `partial`，AC02/AC03 保持 `blocked`。

## 修复与回归范围

修复位于 `shell/runtime/dsh-adapter.cjs`：`job.abort()` 对已派发任务写出 abort 并保留 waiter；尚未派发的任务仍可立即收尾。`aborted` frame 作为取消确认设置 `abortRequested/abortAcknowledged` 并清理未决工具请求，不再删除 waiter 或 resolve；守卫在 ack 前后到达的晚期工具 RPC，回 `SESSION_ABORTED`，不调用 handler。回归也覆盖 `onSpawn` 时 signal 已取消的前置 guard。

T03 运行 `node --test tests/regression/t04-adapter-abort-drain-test.mjs`，结果 **1/1 PASS**。测试使用真实 `dsh-adapter`、scheduler 和受控 JSONL `FakeChild`，不启动真实 runner/DSH SDK：A/B 两个 session 分派给同一 fake child；A cancel 后、ack 前到达的请求被拒绝且不触发 A handler；ack 后的迟到请求同样被拒绝；B 的工具请求仍成功，B 完成后 A 仍未 settle；只有显式发出 A `done` frame 后 A 才以 cancelled 收敛。测试断言 fake child 未被杀死。T16 对改动与断言作独立静态 review PASS；未重跑命令。

## 证据边界

受控 child 按测试脚本安排 abort ack 和 `done` 的顺序；`done` 是协议帧，不是从真实 DSH SDK 观察到 `agent.whenIdle()`、session flush 或 turn 资源释放。未验证真实 conversation lease、持久 Run/PG 锁、真实 SDK 取消及上游实际停止、生产 session 资源趋势、真实 PT/provider 或生产运行收敛。该 probe 支持 adapter waiter 不在 ack 时提前结算及 A/B handler 隔离的受控契约；不替代 T04 的真实同进程 session 执行重叠、连续 session 资源释放及完整 AC03 验收。
