# T15 archive-readonly regression harness review — 2026-10-22

结论：`setBusy is not defined` 是测试引用旧 harness API，不是当前 UI 缺少 busy 状态处理的证据。当前 `shell/public/app.js` 已用 `setConversationBusy(conversationId, entry, busy)` 按对话管理生成状态；本次仅将独立回归测试的 busy 生命周期调用改为该现行 API，未改 UI 行为。

## 证据

- `shell/public/app.js` 当前定义 `syncConversationBusy()` / `setConversationBusy()`（807–815 行），由 `chatRunsByConversation` 推导 active conversation 的 `state.busy`。`runChat()` 启动与 finally 清理分别调用 `setConversationBusy`（845、1014 行），旧 `setBusy` 不再定义。文件存在近期未提交差异，以上是当前工作树事实，不代表已发布版本。
- `tests/regression/ui-archive-readonly-test.mjs` 原第 45–49 行直接调用 `setBusy(true/false)`；现改为对 A 使用同一 entry 调用 `setConversationBusy(..., true/false)`，仍断言生成期间 disabled，busy 清理后归档锁保持。
- 直接执行 `node tests/regression/ui-archive-readonly-test.mjs` 在 harness 加载前失败：`tests/helpers/app-harness.mjs` 用 `new URL(...).pathname` 读 app 文件，URL pathname 将项目路径中的中文编码为 `%E9...`，导致 `ENOENT`。为不修改 harness，以 ASCII 临时 symlink 路径加 Node preserve-symlinks 选项执行同一单文件：`node --preserve-symlinks --preserve-symlinks-main /tmp/northstar-pt/tests/regression/ui-archive-readonly-test.mjs`。
- 单文件结果：23 PASS / 2 FAIL（共 25）。本次修复覆盖的 busy 断言均 PASS。两项失败为“恢复后能正常发消息”与“普通对话能正常发消息”，均得到 `chatCalls=0`；当前 app 有 `modelContextReady` 未就绪时拦截 `ask` 的守卫，harness `/api/models` 返回空列表。该解释是基于当前代码的推断；未据此改变测试或产品代码。

## 边界 / 下一步

本切片只修正旧函数名造成的 ReferenceError；不据此宣称 archive-readonly 全套回归通过，也不代表 production/发布验收。后续应为这两条 ask 断言配置有效且已就绪的本地模型上下文，或将它们改为专门验证归档恢复状态的断言，然后在同一单文件 harness 下复验。当前证据不能区分真实 UI 行为问题与测试夹具不满足模型就绪前置条件。
