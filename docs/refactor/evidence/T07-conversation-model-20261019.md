# T07 对话模型偏好：独立验证记录（2026-10-19）

结论：本轮对话模型偏好持久化、HTTP 接线与 UI 异步隔离通过聚焦验收；没有把本地夹具结果计作真实供应商模型、Google OAuth、生产 PostgreSQL 或整体验收通过。验证者未实现 conversations store、server 接线及 app.js；独立新增 HTTP 测试，并补充 UI 反例。

| 命令 | 结果 | 已验证行为 |
| --- | --- | --- |
| `node --test tests/regression/conversation-model-preference-test.mjs` | 1/1 PASS | PGlite 持久化；同一行 COALESCE 首次快照；用户归属；显式新建快照；非法值；重开数据库 |
| `node --test tests/regression/conversation-model-preference-http-test.mjs` | 1/1 PASS | 真实本地 HTTP、session 与 PGlite：A 改模型不影响 B；默认仅影响新对话；跨用户读写 404；未知/未验证模型拒绝；重启恢复；实际排队后修改偏好仍按已捕获模型执行 |
| `node tests/regression/ui-model-switch-test.mjs` | 43/43 PASS | 模型能力守卫；GET/POST 绑定对话 ID；A 的迟到 GET 和 POST 成功/失败响应不污染 B；偏好尚未保存时禁止发送 |
| `node tests/regression/ui-conversation-isolation-test.mjs` | 43/43 PASS | 等待真实 loadModels 成功后，A/B 流式、JSON、异常响应隔离；独立运行与停止；新建/复用对话行为 |

HTTP 测试还独立验证幂等边界：B 以 fixture-a 入队，偏好随后改为 fixture-b；执行仍使用 fixture-a。完成后同幂等键、同原消息重试返回原 Run，runner 记录只有一次调用、历史只有一条用户消息；同键改消息仍返回 409。测试最初在接线前真实复现“A 选择污染 B”，接线后转绿，避免仅证明夹具自身。

Store 静态交叉复核：读写均使用 conversation id 与 user id 双条件；首次快照使用单条 `UPDATE ... COALESCE`，不通过先读再覆盖实现竞争控制；create 接收显式默认快照，legacy NULL 由首次访问初始化。PGlite Promise 并发验证不等同 PostgreSQL 多连接、多实例实测。

HTTP 夹具只在 127.0.0.1 监听，沙箱首次返回 listen EPERM，获准后完成测试；使用临时数据库、测试会话、明确 capability/availability 的目录夹具及 PT_CHAT_DRYRUN。runner 包装记录实际 options.model，不调用付费模型；未执行真实 Google 身份交换。临时数据库及本测试租户目录在 finally 清理。UI 为真实 app.js 加最小 DOM/网络夹具，未完成浏览器视觉或真实用户交互验收。所有结果仅证明当前本地未提交工作区。
