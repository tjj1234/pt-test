# T13 工作区技能目录创建局部回归（2026-10-22）

**范围与结论：** 仅验证已有用户完成 Google 回调时，租户工作区 `.dsh/skills` 目录在会话 cookie 下发前创建。命令 `node --test tests/regression/google-login-integration-review-test.mjs` 通过：1/1，exit 0，用时约 7.6 秒。测试在临时数据库/服务环境运行，身份上游由 fixture 替代；它不证明源技能文件被复制、技能可加载或可执行。

代码只读检查：[`tenant.cjs`](../../../shell/tenant.cjs) 的 `initTenantWorkspace()`（第 47–89 行）按租户 ID 建路径，首次遇到目标技能目录不存在时递归复制共享源目录；后续调用不更新目标目录。复制会跳过符号链接、`node_modules`、`data` 和下划线前缀项。当前没有版本清单、内容 hash、启停状态或发布记录。`/api/skills`（[`server.cjs`](../../../shell/server.cjs:1379)）列的是内存工具 registry 展示数据，不是 DSH 技能目录的发布入口；registry 中的工具 `version` 只保存在进程内（[`registry.cjs`](../../../shell/tools/registry.cjs:118)），未与 Run 关联。

版本固定的主要约束是 runtime 当前以 `tenantId` 作为常驻 DSH process key（[`dsh-adapter.cjs`](../../../shell/runtime/dsh-adapter.cjs:630)），已有进程会直接复用；新进程以 tenant workspace 为 cwd（第 678–680 行）。因此仅覆盖租户目录或更新共享源，不能证明新 Run 即时采用新版本，也不能保证运行中的旧 Run 不受影响。Run store/事件没有发现 skill release ID 或 content hash 字段。任务包要求的新旧版本并存需要明确进程加载语义后才能安全接线。

**最小可实现边界建议：** 先由可信 PM 权限写入不可变的 `skillId/version/source/hash/capabilities/dependencies` 发布记录；禁用只改变新 Run 可选状态，不删旧版本。Run admission 将已启用 release 清单/hash 固定进 Run 元数据；执行侧从不可变、版本化技能目录加载。现有 tenant 常驻进程若不能按 Run 固定加载版本，应按 release hash 隔离进程/工作区，或在旧 Run 排空后再切换；不得原地覆盖正在使用的目录。Frontmatter 可提供展示/依赖描述，不能自行授予工具 executor、权限、发布或删除能力。此边界还需确认 DSH loader 是否支持 Run 级 skill source/版本快照。

**未覆盖验收：** T13 六项验收（发布 v2 对新 Run 生效且旧 Run 维持 v1、禁用阻断新 Run 并保留历史版本、能力关联 executor/测试、frontmatter 不扩权、加载/依赖失败可见、多技能不重复注册或无限增长上下文）均未由本次回归证明；AC15 仍 `untested`。任务包标注 T13 为 2–4 人日；当前仅有目录创建/首次复制，没有发布持久化、运行固定或权限治理基础。完整实现需额外落地 PM 权限/发布状态、不可变产物与 hash、Run pin、持久进程版本切换和场景回归，原估算偏乐观；在 DSH loader 契约确认后再估，预计需增加约 3–5 人日，且真实 DSH 发布/禁用验收另计。

没有修改生产代码、任务包、工作日志或验收状态；没有模型调用或部署。本文件只记录目录创建局部回归，不代表 T13 或 AC15 通过。
