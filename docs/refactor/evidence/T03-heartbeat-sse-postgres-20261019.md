# T03 租约续期、慢取消与跨实例 SSE（2026-10-19）

**限定切片 PASS；T03、AC04 及生产验收仍未完成。** 集成分支 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，实现与新增测试未提交。Node v24.14.0，macOS，临时 PostgreSQL16 Docker；镜像digest `sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`。

| 实际缺陷 | 修复与验证 |
|---|---|
| 支持TTL下限1000ms，但heartbeat周期下限同为1000ms；健康任务跨TTL会被取消 | 周期改为TTL约1/3、最小100ms。真实PGlite/store反例由FAIL转PASS，任务跨2TTL仍续租并持久completed/done。 |
| heartbeat等待scheduler.cancel完全settled；abort后的慢I/O清理跨TTL会停止Run与conversation续租 | heartbeat只发取消请求，不等待收尾，直到execution.result finally才停保活。独立反例证实旧版cleanup未结束时另一owner可抢租；修复后两层都拒绝抢占，最终cancelled。 |
| 首个observer把未来Last-Event-ID提升成共享publishedSeq，其他正常observer看不到后续事件 | 不允许客户端after推进共享发布水位；保留每连接cursor与HTTP过滤。模拟持久日志两例及真实PG双HTTP实例通过。 |

## 命令与结果

```sh
node --test tests/regression/task-heartbeat-boundary-review-test.mjs tests/regression/task-sse-observer-review-test.mjs tests/regression/task-execution-test.mjs tests/regression/queued-run-conversation-serialization-test.mjs
# 6/6 PASS：含独立新增边界4例；PGlite/受控执行，不是真实模型。

node --test tests/regression/task-heartbeat-boundary-review-test.mjs tests/regression/task-sse-observer-review-test.mjs tests/regression/task-execution-test.mjs tests/regression/queued-run-conversation-serialization-test.mjs tests/regression/task-store-test.mjs tests/regression/task-store-review-test.mjs
# 最终15/15 PASS，含heartbeat只请求一次cancel的资源收口。

PT_PG_DSN=<disposable-dsn> node --test --test-concurrency=1 tests/regression/task-store-postgres-integration-test.mjs tests/regression/task-lease-postgres-review-test.mjs
# 5/5 PASS：两个父测试及新增三个子场景，按Node test统计。

PT_PG_DSN=<separate-disposable-database-dsn> node --test tests/regression/run-sse-multi-instance-postgres-test.mjs
# 1/1 PASS，两个实际HTTP进程与独立writer pool共享PG。
```

PG测试首次沙箱内连接拒绝，批准外运行通过，不记实现FAIL。临时容器只绑定127.0.0.1动态端口、PGDATA为tmpfs、无host volume；租约与SSE使用不同测试库。PG覆盖并发Run抢租、旧owner fencing、不同Run争同conversation、save fencing、真实行锁等待跨过期后不复活、heartbeat跨原TTL、等待任务取消与外pool remote cancel。

专属容器 `northstar-t03-lease-review-20261019` 已精确删除，并复核daemon返回No such container；数据库行随tmpfs释放。测试临时key/data及HTTP进程已清理。宿主无依赖安装；Docker Desktop本轮启动且保留，postgres:16镜像缓存保留；T16在线安装探针另复用npm cache，可能新增缓存。

SSE测试在instance B先开未来cursor，再在A/B开正常observer；先读取预存marker，之后才写live，实际收到live后才提交terminal，以排除首次replay恰好包含live的假阳性。两HTTP进程须收到与durable log一致的完整递增序号、唯一done，并验证重连后仅返回cursor之后的事件。统一总Abort deadline覆盖健康检查与流，失败关闭进程/连接池与临时目录。数据库fixture行由一次性容器整体销毁。

## 未覆盖边界

无真实Google/PT、模型/工具或付费调用。SSE通过真实HTTP+PG，但不是浏览器刷新/断网E2E；没有生产多实例故障注入、节点强杀/网络分区、未知付费任务恢复或生产长时间负载证据。最短TTL测试验证受控负载下留有续租裕量，不能保证任意事件循环停顿。取消收尾仍等待executor，续租不代表上游I/O已被取消。生产OS隔离与全依赖闭包仍开放。

真实PG心跳使用TTL3000；TTL1000与慢cleanup跨2TTL是PGlite边界回归，不能互相替代。PG/SSE实跑后仅追加heartbeat一次性cancel标记，最终聚焦15/15通过，未重建容器重复PG。独立审查确认重复cancel原先不会重复执行cleanup，该标记用于避免累积Promise回调。
