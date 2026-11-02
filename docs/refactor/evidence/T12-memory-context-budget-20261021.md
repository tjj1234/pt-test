# T12 记忆注入字符预算切片（2026-10-21）

状态：**限定实现切片，局部回归已运行；T12/AC14 仍未通过。** `shell/memory.cjs` 原先将用户的全部非内部记忆按 `updated_at DESC` 返回给任务提示，没有注入上限。现 `memoryLines(userId, opts?)` 默认最多注入 4000 个 UTF-16 code unit；可用 `opts.maxChars` 指定预算（正数向下取整，小于单行所需长度时允许不注入任何条目）。预算按当前 server 格式 `  · ${line}` 并以换行连接后的完整文本计数，包含每行 4 个前缀字符和行间换行。超限时保留能放入预算的完整条目，不截断值；超限条目跳过并继续检查后续较短条目。更新时间相同按 key 升序，保证选择顺序确定。

新增 `memorySnapshot(userId, opts?)` 提供 `lines`、`maxChars`、`includedChars`、`totalCount`、`omittedCount`；`includedChars` 与 `maxChars` 使用同一完整注入格式口径，可供后续调用方解释本轮注入范围。支持事务的 PGlite/PostgreSQL adapter 在只读、可重复读事务内按原 `updated_at DESC, key ASC` 顺序每页读取最多 64 条记忆；当剩余预算连最短下一行也容纳不下时停止拉取值行。独立 COUNT 查询保持 `totalCount`/`omittedCount` 准确；页查询和 COUNT 都按 `user_id` 限定，内部 `$` 键不纳入选择与计数。需继续寻找较短后续条目时会继续翻页，故最坏情况下仍可能扫描全部候选行；COUNT 也必须统计用户全部可见记忆。无 transaction 的 query-only 适配器保留旧的全量 list fallback。现有 `memoryLines()` 数组返回形状兼容原调用，server 仍负责原有格式化。此次只限制最终记忆注入文本，不触及 `server.cjs` 接线或 UI。

边界：这是最终记忆注入文本的字符预算，不是 token 预算，也未接入模型上下文窗口、对话历史/工具证据/附件预算；分页减少应用层一次性加载的完整记忆行，但 COUNT 仍覆盖用户全部可见记忆，且为了保留“跳过大项后继续纳入较短项”的排序语义，稀疏预算场景可能仍需逐页扫描全部行。预算按 JS UTF-16 code unit 计，并依赖 server 当前 `  · ` 前缀与换行格式；格式变化时必须同步更新计数。最近更新优先不是语义相关性检索；`memorySnapshot` 的遗漏摘要尚未传到 UI/日志。没有证明长对话压缩、稳定偏好跨对话召回、删改后热会话失效、记忆确认来源或完整个人资料生命周期。旧库若存在超过 `set()` 限制的历史大条目，可能在默认预算下被跳过。

局部回归：`node tests/regression/memory-context-budget-test.mjs` 通过，覆盖格式前缀/换行计数、预算边界、较短后续条目、零纳入、UTF-16 emoji、数组兼容、分页提前停止，以及真实 PGlite 的事务/分页/计数 SQL；`node tests/regression/seam-smoke.mjs` 14/14 通过，覆盖既有 storage 与记忆写入读取冒烟。未调用模型或部署。任务包对应 T12 验收①（超上下文预算继续并保留关键约束）仅推进记忆片段有界化，未证明对话继续/关键约束保留；验收⑥仅提供程序可读的记忆纳入/遗漏字符摘要，未接入产品可解释性。其他验收项与 AC14 仍待实现和场景级证据。
