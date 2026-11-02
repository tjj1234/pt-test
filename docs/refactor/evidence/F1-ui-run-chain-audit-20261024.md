# F1 用户入口、持久 Run 与媒体可见性核查（2026-10-24）

**结论：现有代码具有 UI→持久 Run→媒体工具→消息保存→重开渲染的连接点；已修复本次 PT 图片资产主机被 CSP 拦截的本地阻断，但尚无同一冻结候选的真实浏览器和四类媒体闭环证据。** 本次只运行隔离本地夹具，无 PT 付费调用、现有服务重启或目标环境操作。

| 环节 | 当前代码/测试证据 | 仍需验证 |
|---|---|---|
| 前端模型选择 | `app.js` 的 `currentModelChat()` 在发送前拒绝非聊天模型；`/api/models` 与会话偏好变更已有 `ui-model-switch-test.mjs` | 目标浏览器的真实上游 A→B 身份，不可由 DSH task frame 代替 |
| 用户媒体请求 | `ask()` 提交 `taskType`，`/api/chat` 持久 Run 接收并在提示中要求调用 `media.route`；`f1-media-runner-host-test.mjs` 覆盖真实锁定 SDK/runner/host/store，但模型和 PT 传输均为夹具 | 同候选浏览器四类任务真实输出，已获准的 model×task/预算 |
| 结果和历史 | `server.cjs` 从 DSH 结果取 `r.media`，存入 assistant 消息；`app.js` 的 `renderMessage()` 调用 `chat-media.js`，重新读取会话消息也走该渲染；`ui-run-resume-review-test.mjs` 证明 SSE 断线按持久游标 GET 补读，`t10-artifact-history-persistence-test.mjs` 证明独立产物元数据保存/重开 | 这两类现有测试没有证明真实 PT 媒体 URL 在会话历史中重开后可加载，签名 URL 有效期也未知 |
| PT 结果资源 CSP | 本次真实文生图 URL 位于 `pub-425ca9cea13d454a907692a0a9f80079.r2.dev`；原 `img-src` 缺此主机，浏览器图片会被拒。主 Agent 已在共享 `server.cjs` 加精确主机；新增 `f1-pt-media-csp-http-test.mjs` 启动隔离本地 HTTP，核对主页响应的 `img-src`、`media-src`、`connect-src` 放行该主机且 `script-src` 不放行，**1/1 PASS** | 其他模型可能返回不同资产主机，需按真实结果审查；本测试不能替代浏览器加载成功 |
| 未知付费状态核对入口 | 媒体错误步骤现提示先查看运行记录。入口为用户头像菜单“用量与日志”→“媒体外部操作”，请求 `/api/usage/external-operations?range=today|week|month`；同日状态可间接查找 | 错误步骤旁无直接链接或 Run ID 定位；该页不是 `/api/runs/:id` 详情，只列最近媒体操作且范围至月。用户若无法对应行，仍可能误操作 |

聚焦复核：隔离 HTTP CSP **1/1 PASS**；Run 恢复和产物历史 **26/26 PASS**；媒体上传与气泡渲染脚本 **139/139 PASS**；媒体外部操作只读 HTTP **1/1 PASS**；主 Agent 同步未知状态保守文案断言后，媒体步骤 UI **34/34 PASS**。上述测试属于不同局部夹具，不能相加为“一次完整 Agent 端到端通过”。

## 错误步骤直达当前 Run 的最小入口

`runChat()`在`/api/chat` SSE响应头读取`X-Agent-Run-Id`，保存在该对话的`requestEntry.runId`和会话存储；同一闭包处理后续媒体工具 step，故**运行中的错误步骤**已有可信 Run ID。只读`GET /api/runs/:id`返回当前登录用户及租户拥有的Run和`externalOperations`，`GET /api/runs/:id/operations`提供同一Run的分页操作；跨用户/租户返回404，前端无需自行相信用户传入ID。最小入口是在该错误步骤旁放一个“查看本次运行记录”按钮，使用闭包中的Run ID发GET，按固定字段以`textContent`显示Run状态、子操作状态、任务ID、最后观察时间及查单次数；请求失败显示“记录暂不可读”，不发POST、不自动重试生成。`switchView("usage")`只能打开通用用量页，不能定位当前Run，不能把它称为精准直达。

历史边界更严格：Run终态后前端`forgetRun()`清会话存储，`chatRunsByConversation`移除该请求；服务端成功assistant消息只存`text/steps/media/artifacts`，DSH失败assistant消息仅存`text/ts`，二者均不存`runId`。所以刷新后历史消息无法可靠指向原Run；不能按“该对话最新一条Run”猜测。长期方案需把经过校验的Run ID随assistant消息持久化（现有消息JSON字段即可，数据库表结构不必改），并在失败分支保存经脱敏的步骤或至少保留对应运行记录入口；此项需另验历史恢复、跨用户拒绝和敏感参数不泄漏。当前仅可给live错误步骤做安全直达，不能宣布历史错误也已解决。
