# Gemini 原生推理／长上下文候选主审（2026-10-30）

结论：两包是隔离候选与本地替身证据，当前生产 `shell/persistent-runner.mjs`、`shell/runtime/dsh-adapter.cjs` 和 profile 未引用候选，不能计作已上线。主线接入前需解决如下边界；保留候选原件以便复核。

| 候选 | 主审发现 | 接入条件 |
|---|---|---|
| 推理强度 | `normalizeModelReasoningMeta({reasoning:true})` 自动构造 minimal/low/medium/high；该布尔值本身不证明每档被 PT 网关接受。候选测试把这种推断写成预期。 | 改为仅接受逐模型可信支持列表或原生映射；无证据则不提供显式档位。经 UI→Run→Runner 的选择须绑定模型身份、资格版本与真实 PT 请求验证。 |
| 长上下文 | 当前 Runner 的 `agent/request` 已对普通模型调用执行 `budget.admit({type:'model'})`；候选 `llm/stream` 又对所有 purpose 执行一次，会让普通聊天重复计数。候选独立测试没有叠加当前 Runner 钩子。 | 保留普通聊天原钩子，辅助 compaction 只在它确实绕开 `agent/request` 时单独记一次；同一个请求只能有一次预算准入。用真实锁定 DSH 同会话压缩和聊天组合证明调用、取消、租户归属和用量。 |
| 长上下文 | 候选按 `streamOptions.sessionId` 找活动 Run；真实原生压缩流是否总携带该 ID、何时从上下文取得归属，尚无当前产品级证据。 | 不按猜测会话 ID 放开；缺可信归属时网络前拒绝，验证两个重叠会话不串预算。 |

另：`llm/stream` 的 `next()` 返回流对象时，候选立即 `admission.settle()`；须核对当前预算 `settle` 语义与流中途失败/取消的记录，不能把“开始流”误记为“完成流”。原生插件 `compaction-basic`、`command-compact`、`tool-result-pruner`、`repeat-tool-reminder` 仍保持关闭，直到这些组合门禁与来源保留通过。
