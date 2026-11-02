# T14 profile and source audit — 2026-10-20

**结论：** 当前仓库证据不能证明产品的 `run-persistent` DSH profile 已加载联网搜索或网页读取能力，也没有 T14 专项来源、失败态、URL/重定向安全或网页注入回归。配置项与旧 `web` profile 快照只能说明配置意图/历史快照，不能作为运行时能力证据；本次为只读盘点，未运行测试。

## Profile 与配置证据

产品 profile 由 `shell/runtime/dsh-adapter.cjs` 生成：`PROFILE_NAME` 是 `run-persistent`（约151行），`PROFILE_PATCH` 只插入 Northstar 兼容补丁与 `persistent-runner`（约163–174行），生成的 `package.json` 使用 `buildProfileDependencyContract` 返回的 bundles（约191–208行）。`shell/runtime/profile-dependencies.cjs:12` 的默认 bundle 仅为 `@deepseek-ai/dsh-base`；`shell/package.json:13–39` 与对应 lockfile 列出 DSH base/核心依赖，未列出 `dsh-web-search-pro` 或 `@anweat/dsh-browser`。因此现有生成逻辑没有显示搜索/浏览器插件被纳入产品 profile。

`shell/dsh-settings.yaml:54–63` 配置了 `web-search-pro`（DDG/Bing、结果数、缓存 TTL、`registerProvider`、CLI backend），但设置模板本身不证明生成 profile 安装并加载了对应 bundle。`docs/dsh-profile-snapshot/package.json` 声明了 `@anweat/dsh-browser`、`dsh-web-search-pro` 等 bundle；其 README:3–6 明确指出快照非权威且可能漂移，且该快照属于独立 `web` profile，不能代替当前 `run-persistent` 的依赖合同或真实启动证据。`docs/refactor/EXTERNAL-DEPENDENCIES.md` 的“搜索/浏览器与 CLI 后端”行也将端点、凭据、调用/失败策略与实际出网列为未知，未记录 T14 实际出网采集。

## 来源、安全与失败语义证据

T14 原文（任务包 v2.0 第14节，约332–338行）要求从生产对话入口分别验证搜索和链接读取；来源记录 URL、访问时间及关键引用；登录墙、失败、过期内容如实呈现；限制内网/云元数据/恶意重定向；网页内容不能触发未授权文件或网络动作；并观察耗时与费用来源。AC15 要求联网结果有真实来源、失败不伪装；AC16 要求跨用户/注入/恶意路径与链接受控（任务包约382–383行）。

当前 `docs/refactor/ACCEPTANCE-STATUS-20261018.md:63` 将 T14 标为 `untested`，并列出来源回查、网页读取/失败、注入隔离、URL/网络目标约束及真实加载证据缺失；AC15（约89行）为 `untested`，AC16（约90行）为 `blocked`。`docs/refactor/T05-SECURITY-STATUS.md` 的凭证与出网段落说明目前没有 OS 出网策略、命令隔离或审计证明，并明确 `web-search-pro` 配置与 profile 实际加载之间仍需运行时核验。检索 `tests/` 中 search/web/browse/fetch/URL/SSRF/injection 相关文件，仅发现通用 `tests/probes/northstar-browser-harness.mjs`；未发现覆盖 T14 来源回查、失败/登录墙、重定向/内网拒绝或网页注入的专项回归。此检索结果不是运行测试结果，也不能据此断言浏览器探针覆盖了联网搜索语义。

## 最小高价值后续切片与边界

先对实际生成的 `run-persistent` profile 做本地冷启动核验：检查精确 bundles/锁定依赖，并确认 `web_search` 与 `web_fetch` 在运行时注册；若未加载，先由产品决定是否纳入并固定插件版本，再做受控 fake-target 验证。后续安全/来源用例应分别检查真实可回查来源、访问时间、失败/登录墙不编造结果、重定向到 loopback/private/metadata 地址被拒绝，以及网页提示不能触发未授权副作用。

本记录只是源码与仓库回归文件盘点，不是能力实现、运行时 profile 检查、网络/安全测试或产品验收；不改变 T14 `untested`、AC15 `untested`、AC16 `blocked` 状态。
