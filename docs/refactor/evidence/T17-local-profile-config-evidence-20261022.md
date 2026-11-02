# T17 isolated profile dependency/configuration slice — 2026-10-22

结论：完成一个不需要业务方选择域名、凭据或模型的本地 T17 子切片。新增回归测试核对 DSH pi-ai adapter 与 pi-ai 的安装版本和 lockfile 声明一致，并验证 hand-declared provider 缺少 `baseURL` 时，真实 adapter 在启动解析阶段以包含 provider/model 名称的异常拒绝配置。未改业务运行代码、共享 server、UI、WORKLOG 或外部依赖矩阵。

## 执行与结果

- 文件：`tests/regression/t17-profile-dependency-config-test.mjs`。用临时 fixture route `pt-gateway/fixture-model`，配置 `api: openai-completions`，故意省略 endpoint；测试直接调用安装包 `@deepseek-ai/dsh-llm-pi-ai` 的 `apply()`，断言得到 `provider "pt-gateway" model "fixture-model" needs a baseURL`，证明配置错误在 adapter 配置解析入口可见。没有建网络请求、credentials service 或 LLM 请求。
- 同一测试读取本地 `shell/package-lock.json` 与已安装 package.json，核对 `@deepseek-ai/dsh-llm-pi-ai` `0.1.1-rc.2`、`@earendil-works/pi-ai` `0.82.1`、lock `resolved` 域和 integrity 字段存在且版本相同。此处是仓库锁定声明与本机安装版本的一致性检查，不重新计算 registry tarball integrity，也不证明生产机安装相同。
- 命令：`node --test tests/regression/t17-profile-dependency-config-test.mjs`；结果 **2 passed, 0 failed**。

## 范围界限

这只覆盖一个 DSH profile endpoint 缺失负例和本地依赖锁定元数据核对；没有验证 Northstar 的实际 `settings.mutate` / Web Models 页面是否将同一错误显示为 `settings-rejected`，没有修改 `shell/dsh-settings.yaml` 或目标环境配置，也没有验证 PowerTokens/媒体/Google/GA/PG 的真实来源、实际域名加载、错误日志脱敏或 SSRF/CSP。T17 与 AC23 仍未完成。完整来源/负责人/验证时间/失效策略矩阵及目标环境配置错误体验，仍须各模块负责人、部署 owner 与独立验收补证；本切片未把这些未知项替用户决定。
