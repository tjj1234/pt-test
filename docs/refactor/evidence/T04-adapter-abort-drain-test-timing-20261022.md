# T04 adapter cancel/drain 回归时序修正（2026-10-22）

**判定：** 首次定向运行失败是 fixture 时间预算与取消契约冲突，不是已证明的 adapter 源码缺陷，也不是把 `cancelled` 误当实现错误。初始失败为 `B completion does not settle A before A drains`：实际 `cancelled`，预期 `running`，发生在测试第 146 行。

测试将 `abortGraceMs` 设为 50ms（`tests/regression/t04-adapter-abort-drain-test.mjs` 原第 69 行），而 adapter 以 50ms 文件轮询读取子进程帧（`shell/runtime/dsh-adapter.cjs` 第 697 行）；用例还在 abort ack 后依次等待两次工具 RPC，再显式等待 30ms 后才结束 B。这个顺序可超过 50ms。adapter 的 `aborted` frame 只记录 acknowledgement，不释放 waiter（`dsh-adapter.cjs` 第 589–600 行）；grace 到期将进程标为 draining，若剩余 waiter 都已取消且 grace 已过则关闭子进程（第 339–356、391–400 行）。子进程 close 后 adapter 才结束 waiter（第 700–722 行），scheduler 保留的用户取消原因使最终 Run 状态为 `cancelled`。因此该状态与“等待 runner drain 或进程实际关闭”的契约一致；测试把 grace 期限误设得短于自身断言流程。

**最小修正：** 只调整独立测试 fixture：`abortGraceMs` 改为 1000ms；timeout 子用例等待 1050ms 后再断言越过 grace。生产 adapter 未改。

**验证：** 初始命令 `node --test tests/regression/t04-adapter-abort-drain-test.mjs` 重现 1 项失败（4 通过）；修正后同命令通过 5/5，约 6.9 秒。相邻 `node --test tests/regression/persistent-runner-parallel-test.mjs` 通过 1/1。后者覆盖 runtime 多 session 隔离，不是生产 DSH/browser 验收。本结果只验证受控 fake-child 下的取消/等待行为，不关闭 T04。
