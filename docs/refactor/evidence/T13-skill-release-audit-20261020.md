# T13 技能目录与版本发布只读审计（2026-10-20）

**结论：T13/AC15 状态不变，仍为 `untested`。** 本审计只读代码、任务要求与现有回归，不运行测试；没有发现能证明技能发布/版本生命周期的本地验收证据。

## 代码现状

- `shell/tenant.cjs` 将共享源目录设为 `runtime/workspace/.dsh/skills`（第 23–29 行）。`initTenantWorkspace()` 只在租户目标技能目录不存在时首次复制（第 72–87 行）；已有目标目录不会同步源内容。实现没有技能版本或内容 hash，也没有将技能版本固定到 Run 的路径。
- 未发现可信 PM 身份对应的技能发布/禁用入口或持久发布状态。`shell/server.cjs` 的 `/api/skills` 返回 `toolsRegistry` 中已登记的业务工具及展示字段（第 1383–1429 行），不是 DSH 技能发布目录，也不构成 PM 发布与版本管理证据。

## 现有本地证据及限制

- `tests/regression/google-login-integration-review-test.mjs`（第 62–69 行）仅断言受控登录回调后租户 `.dsh/skills` 目录存在。
- `tests/regression/tenant-mock-smoke.mjs`（第 22–60 行）覆盖 mock 对话、错误码与会话生命周期；没有技能更新、版本固定、禁用、来源或发布权限断言。
- 因而现有回归只支持“工作区目录会被创建”这一窄结论，不支持技能内容已复制、发布 v2 对新任务生效、运行中的 v1 不变、禁用阻断新调用、历史保留版本或恶意 frontmatter 无法扩权等结论。

## 验收状态

任务包 v2.0 T13（第 324–330 行）要求按需发现/加载、版本发布与 Run 绑定、workspace 更新、禁用和可信发布权限等；当前实现及回归未覆盖这些验收点。`docs/refactor/ACCEPTANCE-STATUS-20261018.md` 第 62 行将 T13 记为 `untested`，第 89 行将 AC15 记为 `untested`；本审计不改变这两个状态，也不改变 T00–T18 / AC01–AC24 总计。

**验证记录：** 本次未运行测试或修改生产代码；此文件记录静态审计范围，不是实现验收或独立运行结果。
