# T13/T14 loader and network boundary audit — 2026-10-22

**结论：**没有找到可在当前契约内安全完成的生产接线修复。当前可验证的 T13 仅是纯函数内容 hash 与 pin；它没有进入 release store、Run admission 或 DSH skill loader。产品生成的 `run-persistent` profile 显式禁用 `tool-skill` 和 `tool-web`，且只注入 `persistent-runner`；`web-search-pro` settings 项不能证明搜索或抓取可用。为避免只凭配置开放外网，或将不可变 pin 错接到仍读取共享可变 workspace 的 loader，本轮仅记录审计，不改生产代码。T13 仍 partial，T14 与 AC15 仍未验收。

## T13：release identity 尚未成为执行输入

- [T13 snapshot primitives](T13-skill-release-snapshot-primitives-20261022.md) 说明 `shell/skills/release-snapshot.cjs` 仅对调用方给定的文件字节计算 hash，并复制已授权身份到冻结 pin；模块本身不读取文件、不验证发布/启用、不写持久化记录，也不做授权。
- 当前 `shell/runtime/dsh-adapter.cjs:164-174` 的 `PROFILE_PATCH` 禁用 `tool-skill` 并只插入 `persistent-runner`。`shell/tenant.cjs` 仍按租户 workspace 创建/复用进程；在没有 Run 级 skill source loader 契约时，pin 不会阻止执行读取共享目录中的变化内容。
- [workspace provisioning evidence](T13-workspace-provisioning-regression-20261022.md) 已指出首次复制、不更新、无 release/hash/启停记录。缺少 PM 发布权限、不可变版本存储、Run 持久化 pin、禁用/回滚与旧 Run 保持旧版本的接线和回归。

## T14：配置意图没有变成可用且安全的联网能力

- `shell/runtime/dsh-adapter.cjs:151` 将产品 profile 命名为 `run-persistent`；`:164-174` 禁用 `tool-web`，只插入 `persistent-runner`。
- `shell/runtime/profile-dependencies.cjs:29` 默认 profile bundles 仅为 `@deepseek-ai/dsh-base`；`shell/package.json` 没有声明 `dsh-web-search-pro` 或 `@anweat/dsh-browser` 为 shell 的直接依赖。锁文件中出现的包名/传递依赖，不能证明其处于已构建 profile、已加载或注册了工具。
- `shell/dsh-settings.yaml:58-66` 有 `web-search-pro` 的 DDG/Bing、缓存和 CLI backend 配置，但 profile 生成及工具禁用规则没有将该设置接到产品运行时。当前仓库中未发现产品搜索/网页抓取 handler 的 URL 重定向、私网/metadata 拒绝策略，也没有 T14 专项来源/失败/注入安全回归；因此既无安全网络行为可验证，也没有合适的现有调用点可修。
- 参见 [T14 profile and source audit](T14-profile-and-source-audit-20261020.md)：搜索与网页读取须分开核验；页面来源、访问时间、失败/登录墙行为及网络目标策略都缺真实或受控 runtime 证据。

## v2.0 / 验收映射与下一依赖

v2.0 T13 要求 PM 发布、版本固定、禁用、能力映射、失败可见和多技能上下文有界；T14 要求真实搜索/读取、来源回查、失败诚实、重定向与内网安全、网页注入隔离及费用/耗时可观测。AC15 要求 PM 新版只影响新任务、联网来源真实且失败不伪装。当前没有一个已实现的 loader/source path 可以用纯本地回归证明这些产品行为，且实际联网插件和策略的授权/版本选择是需主线确认的范围决策。

**最小后续依赖：**T13 先确认 DSH loader 的 Run 级不可变 skill source 契约及发布记录/授权边界；T14 先确定获准的插件与锁定版本、运行 profile 入口、出网策略和受控 fake-target 设计。接线后才可本地验证版本固定、来源/失败语义和私网/重定向拒绝；生产对话真实来源验收仍需经批准的目标环境验证。本轮未运行测试、未访问站点/provider、未调用模型，也未修改 WORKLOG 或验收矩阵。
