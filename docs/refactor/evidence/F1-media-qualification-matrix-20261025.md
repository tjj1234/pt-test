# F1 媒体 model×task 资格阻断矩阵（2026-10-25，离线复核）

**结论：同 Key 目录于 2026-10-25（东京时间）只读刷新，82 个 ID 及端点标签与 10/24 快照逐项一致；它仍只足以给出两类生成任务的目录提示，四类媒体任务均无可签署的 AUTO/持久 Run 资格证据。** 本文不接触 Key 或重新调用 PT，也不把目录可见性、直接业务模块成功或模型名称升级为调用授权。82 项中 11 个有文生图提示、29 个有文生视频提示、2 个同时有两种提示，合计 38 个至少有一种媒体提示、44 个无这两种提示；图生图和图生视频的目录专属任务提示均为 0。新[脱敏目录](F1-current-key-directory-matrix-20261025.json)观测时间为 `2026-10-24T16:35:36.906Z`、`hasMore=false`；计数沿用与其 ID/端点逐项相同的 [10/24 任务提示矩阵](F1-current-key-directory-matrix-20261024.json) 映射。新目录仍不含目标机 scoped cache 的策略或运行验证。

| Agent 工具任务 | 82项目录中的任务提示 | 同 Key 直接探针（10/24） | 已证明可供 AUTO 的 model×task 组合 | 尚须补齐的资格证据 |
|---|---:|---|---:|---|
| `text2image` / `textToImage` | 11 | `seedream-5-0-260128` 1次 POST 成功、返回结果 URL | 0 | 当前 scope 的媒体策略；`openai-images-generations` 适配及端点匹配；与 model/scope/capabilityRevision/adapterVersion 绑定的真实运行验证；Agent 入口结果与历史 |
| `image2image` / `imageToImage` | 0 | 同一 Seedream 使用参考图 1次 POST 成功 | 0 | 有来源和版本的 `imageToImage=true`、image→image 人工审定；上述策略、适配、版本绑定验证及持久结果。不能从 T2I 成功推导所有图片模型均支持 I2I |
| `text2video` / `textToVideo` | 29 | `wan2.7-t2v` POST 传输失败，无响应或 task ID，结果/费用未知 | 0 | 视频适配与策略、版本绑定验证、明确终态；旧未知提交不可自动重投 |
| `image2video` / `imageToVideo` | 0 | `wan2.7-i2v` POST 返回 HTTP 403，无结果 | 0 | 有来源和版本的 `imageToVideo=true`、image→video 人工审定；视频适配与策略；先澄清 403 或另选有证据的组合，再做版本绑定验证 |

“已证明可供 AUTO”列统计的是**当前保存证据中能完整证明的组合数**，不是断言线上当前实际可用数为零。该脱敏 JSON 不包含原始 Key、scopeId、当前权限位、本地策略、人工 override、adapter、verification 或账单；因此不能从它计算真实目标实例的逐模型 `routeMediaTask()` 结果。项目当前 `textChatQualificationMaps()` 只生成 `textChat` 适配，未提供四类媒体的默认 adapter/override/verification；`buildMediaQualificationMatrix()` 已可对**同 Key 强制刷新后的真实 scoped catalog**逐项给出 `ROUTE_READY` 或首个阻断码，并拒绝缓存/失败/展示型目录。其 `ROUTE_READY` 仍不代表 Run 预算获准、POST 成功或可重开结果。

资格次序为：当前 Key 与网关同 scope 的新鲜目录 → 该 ID 的调用权限 → **面向该媒体任务**的本地策略 → 任务与输入/输出模态的有来源事实 → 已登记且端点兼容的图片/视频适配器 → 与当前 scope、能力版本和适配器版本一致的运行验证 → Run 的工具/模型次数、重试、时间及实际费用约束 → 外部提交意图 → 至多一次 POST → 结果/未知状态持久化。2026-10-25 的媒体路由修正已要求 `localPolicy.enabled/source/version` 且 `localPolicy.tasks` 显式包含当前媒体任务（例如 `textToImage`）；只列 `textChat` 或未列任务的策略一律返回 `LOCAL_POLICY_UNKNOWN_OR_DENIED`，避免把“模型已启用聊天”当作媒体许可。当前 `run-budget.json` 为 1 次模型、0 次工具、0 次重试、180秒；零工具会在媒体调用前阻断，调用次数和时间并非货币上限。

下一次真实验证的最小顺序：① 用实际提交所用 Key 强制刷新目录，并保存脱敏的模型×任务阻断码及 scope/能力版本摘要；② 对候选任务逐项审定官方任务/模态声明、媒体策略及固定 wire adapter，显式记录版本，不从 ID 推断；③ 建立有硬次数、重试、时限及可核对费用约束的受控**手动资格**路径，先验证已有直接成功线索的 `seedream-5-0-260128` 文生图，再用其结果验证图生图；现有 AUTO 路由要求先有 verification，不能通过伪造 verification 绕过这一步；④ `wan2.7-t2v` 原未知提交保持人工核对/不重投，`wan2.7-i2v` 的 403 在原因不明时不标验证通过，另一个视频候选也需独立事实和预算；⑤ 只在逐组合验证通过后记录 revision-bound verification，再从同一冻结候选的 Agent 入口调用、显示结果、刷新重开，并核对无重复提交。无账单登录权限的事实保持为费用核对缺口，不请求用户提供不可取得的账单。

依据：本地脱敏[目录快照](F1-current-key-directory-matrix-20261024.json)、[10/24 媒体资格复核](F1-media-qualification-audit-20261024.md)、[直接 PT 探针](F1-pt-live-probes-20261024.md)，以及当前 `shell/models/capabilities.cjs`、`media-task-router.cjs`、`media-route-admission.cjs`、`shell/server.cjs` 和 `shell/runtime/run-budget.json`。本文是离线证据整理，无新 PT 请求、无目标机验证或发布动作。

## 新鲜脱敏目录回传后的更新口径

只接受与**即将提交所用 Key**同一作用域、`catalogDiagnostics.state=fresh`且`errorCode=null`的结果。先记录观测 UTC 时间、HTTP/目录状态、模型总数、分页是否完整、各媒体任务提示数量及与 10/24 快照的 ID 增删；再按 `mediaQualification.rows` 汇总四任务的首阻断码与 `routeReadyCounts`。不要记录 Key、请求头、原始 provider payload、图片 URL 或未脱敏异常。若缺页、同步失败或目录未知，标记“本次矩阵不可评估”，保留上次快照但不延用其执行资格；若目录新鲜却四任务均报 `LOCAL_POLICY_UNKNOWN_OR_DENIED`，这与当前仅注入聊天策略的静态代码一致，不能改写成 PT 无此能力。矩阵计数应分开标注“目录任务提示”“媒体路由资格”“受预算允许”“真实 Agent 结果/重开”，后两项不能由前两项推算。

对称策略边界已在 2026-10-25 的本地工作树收口：媒体路由要求 `localPolicy.tasks` 含当前媒体任务，文字路由要求显式含 `textChat`，`capabilities.cjs` 的 `states[task].autoEligible` 也按对应任务计算；旧无 `tasks` 缓存策略和只含另一任务的策略均不取得 AUTO 资格。共享 `server.cjs` 的默认聊天策略也已加 `tasks:['textChat']`。这些仍是本地代码证据，尚未进入冻结候选或目标环境。
