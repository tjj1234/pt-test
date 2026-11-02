# T13：技能 release hash 与 Run pin 独立基础切片（2026-10-22）

结论：本地新增纯函数用于对调用方提供的技能文件快照计算确定性 SHA-256 内容身份，并把已授权 release 的 `skillId/version/contentHash` 规范化复制为不可变 Run pin。该切片不读取磁盘、不发现/加载技能、不写发布记录、不授予能力，也未接入 Run 创建或 DSH loader；T13/AC15 仍未验收。

## 约束依据

- v2 任务包 `docs/北极星一期生产级重构完整任务包-v2.0.md:324-330` 要求复用 DSH SKILL 发现/加载，包含 PM 发布、能力需求、依赖、启停授权、Run 绑定，以及旧 Run 不热替换。
- `docs/refactor/evidence/T13-workspace-provisioning-regression-20261022.md:5-11` 记录现有 tenant workspace 仅首次复制、无 release/hash/启停/Run 关联；DSH process 按 tenant 常驻复用，Run 尚无 skill release identity。
- 当前 profile 的禁用项在 `shell/runtime/dsh-adapter.cjs:164-174`，包含 `tool-skill`、`compaction-basic` 等；`persistent-runner` 只注入 `agentDefaultModel/agents/sessions`。实际发布接线须先确认 loader 是否能按 Run 读取不可变版本、常驻进程如何隔离版本及如何保持旧 Run 文件不变。
- DSH skill name 的 kebab-case 约束来自本地锁定包 `shell/node_modules/@deepseek-ai/dsh-skill/lib/index.js:17-30`。新模块仅复用该格式约束；release version 保持非空不透明字符串，不规定 SemVer 或发布策略。

## 实现与验证

- `shell/skills/release-snapshot.cjs`：要求调用方提供完整 regular-file 快照，拒绝绝对/非规范/重复路径；按路径排序、逐文件散列，再以版本化 canonical manifest 生成整体 `contentHash`。提供 `pinSkillReleases()`，按 skill ID 排序并复制为冻结对象，同一 Run 同一 skill 只允许一个版本。
- `tests/regression/skill-release-snapshot-test.mjs`：覆盖顺序无关性、任一文件字节变化导致 hash 变化、路径穿越/重复/空清单/非法 skill ID 拒绝、Run pin 排序与不可变性。
- 验证命令：`node --test tests/regression/skill-release-snapshot-test.mjs`；结果 3/3 PASS，退出码 0。只运行该新增定向单测；没有触发模型或 Actions。

## 未实现/验收边界

本切片的 hash 只覆盖调用方传入的文件，不定义文件发现/排除规则、symlink 处理、依赖闭包或脚本执行环境；调用方必须先明确这些边界并提供 loader 实际会读到的完整内容。Run pin 是序列化友好的本地值，不等于持久化元数据，也不阻止 loader 继续从共享 workspace 读取被覆盖的文件。它不识别 PM 身份、不验证 release 已发布/启用、不处理禁用、回滚、热进程切换、能力到 executor 的可信映射或 frontmatter 权限。需要主线确认并实现 DSH loader 的不可变版本路径/Run 级加载合同后，才可将此 helper 接到发布与 Run admission。未修改共享入口、server/runner/workspace、WORKLOG、T06/T07 或现有证据文件；未提交。
