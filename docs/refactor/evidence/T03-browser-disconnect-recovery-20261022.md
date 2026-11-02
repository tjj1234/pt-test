# T03 · 浏览器断流后的 Run 恢复（2026-10-22）

**结论：受控本地端到端切片 PASS；T03/AC整体仍未通过。** 使用仓库 `tests/probes/northstar-browser-harness.mjs` 启动真实 shell、UI、存储与路由，身份、模型与回复由隔离 fixture 提供；浏览器在 `hold A` Run 运行中强制关闭 SSE stream。观测到 1 次 `/api/chat`、1 次 Run admission、1 次 mock model invocation、1 次 `stream_disconnected`（1 条 stream），随后客户端通过同一 Run 的 `/api/runs/{id}/events` 轮询恢复，最终 UI 显示 `hold A completed`。Harness 记录 `createdRuns=1`、`completed=1`，全过程未出现第二次 `/api/chat` 或第二次模型调用。

这证明当前 checkout 的受控浏览器路径能在 stream 断开后读取同一持久 Run 的事件并呈现完成结果。它不证明线上运行包包含此代码、不证明真实 DSH/provider 的断流行为、网络中断之外的页面重载恢复、不证明真实模型权限/调用或 usage/费用核算，也不覆盖 T03 的幂等、取消、超时、租户隔离和故障恢复全部验收项。运行环境及所有模型数据均为本机 disposable fixture；没有付费请求或线上访问。

证据来源：`node tests/probes/northstar-browser-harness.mjs` 本机浏览器控制流程与 harness JSONL 状态计数；浏览器 UI 确认同一会话显示最终回复。任务/会话 ID 省略，避免保留无必要的临时标识。临时 harness 已正常关闭。
