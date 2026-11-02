# T03 / AC03 · 未确认的上游任务停止提示（2026-10-22）

本地修复让 `/api/chat/stop` 根据持久 Run 的 `externalState` 标记潜在仍运行的上游任务（`submitting`、`accepted`、`pending_query`、`querying`、`unknown`、`manual_check`），并让浏览器在同一活动 Run 收到停止终态时提示“本地任务已停止；上游任务状态未确认，可能仍在运行，请稍后核对结果。”普通已确认停止和超时文案保持原样。修复覆盖的是此前 API 丢弃取消结果且 UI 一律显示“已停止”的 AC03 可见性缺口。

验证：`node --test tests/regression/ui-run-resume-review-test.mjs` **23/23 PASS**，新增受控 SSE 用例确认不确定上游状态显示独立 warning 参数；`node --check shell/server.cjs`、`node --check shell/public/app.js` 与目标文件 `git diff --check` 均通过。未调用 provider、未部署。

边界：该证据仅验证 API 字段派生代码静态检查与前端终态显示单元路径；没有真实 HTTP/DB 流程证明外部操作所有状态都能在 stop response 中观测，也没有 DSH/provider 证据证明实际上游仍在运行。页面刷新后仅靠事件回放不会重建该浏览器内 warning 标记；AC02–04 与 T03/T04 仍需完整验收。
