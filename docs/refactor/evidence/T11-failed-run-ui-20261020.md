# T11 failed-Run UI regression evidence (2026-10-20)

**结论：**新增的前端回归确认，失败 Run 的终态 SSE 若携带含成功与失败工具步骤的 assistant message，UI 会把这些步骤原样交给历史渲染，并在历史之后显示非持久化的通用错误提示；`needKey` 仍走专用提示且不重复显示通用错误。此结果只证明 UI 消费该 SSE fixture 的行为，不改变 T11 或 AC22 总体状态。

## Fixture 与断言

测试位于 `tests/regression/ui-run-resume-review-test.mjs`，用生产 `runChat` 处理合成 SSE `done` 事件：`ok:false`，历史含一条 assistant message，其 `steps` 分别是成功的 `lookup` 与失败的 `write`。五个断言检查：(1) 完整 messages 原样传给 `renderChat`；(2) 两条 step 及 `isError` 状态未被整体 Run 失败改写；(3) 渲染顺序为 conversation 后接 error sysline；(4) error 不进入 conversation messages；(5) 普通 Run failure 不触发 PT key 专用提示。相邻既有 `needKey` 回归另外确认专用提示恰好一次且没有通用错误气泡。

## 验证

命令：

```sh
node --test tests/regression/ui-run-resume-review-test.mjs
```

结果：**21/21 PASS**。首轮新增测试未通过，因为 fixture 的 SSE 换行被编码成字面反斜杠文本，事件没有被解析；修正分隔符后复跑通过。

## 验证边界与状态关系

本切片只新增 UI 回归，没有生产 UI 或 server 改动。测试 harness 在 `renderChat` 边界记录数据，因此不证明浏览器 DOM/CSS 中步骤的实际外观，也不证明后端会把 steps 持久化到 conversation、断线 resume/replay 后能读取这些 steps，或错误提示可从重放事件恢复。后续 replay 仍从 conversation detail 读取持久 messages；这些 messages 必须由后端正确保存，前端本测试不覆盖该条件。

既有 T11 evidence 将 T11 整包标为未验收，且指出失败/取消的端到端 UI 呈现未验证；本测试仅补充“失败终态 SSE 到 UI 的数据保留与提示顺序”这一局部回归，不覆盖工具执行与 usage 的联合失败行为。AC22 仍为 untested；本证据不构成其验收依据，也不据此更新 T11/AC22 状态。

## 与后端历史的边界

当前 `shell/server.cjs` 失败分支写入的 assistant message 只有 `text/ts`，因此错误正文会进入 conversation 历史，失败工具 `steps` 不会随 conversation detail/replay 恢复。现有 `sanitizeParentRpcStep` 仅对 `parent_rpc` 特殊遮盖 `args/result`；通用工具步骤的参数与结果没有已验证的通用安全脱敏。此 UI fixture 假设 SSE 中已有带 steps 的 assistant message，只验证前端消费契约，不授权将 raw steps 持久化。失败步骤的安全历史表示需由 T03 确认并另行验证。

取消/中断残余：T11 要求步骤状态保真及取消记录可查，但未明确 Run 被用户停止或超时后，先前成功工具的工具级终态是否必须仍为 `completed`。当前 stop 分支将所有已观察步骤标为 `interrupted`；本轮失败 Run UI fixture 不覆盖该路径，也不据此判定其符合步骤状态契约。该语义留待 T03 确认。
