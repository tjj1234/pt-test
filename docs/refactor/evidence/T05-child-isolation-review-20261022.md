# T05 子进程凭据与执行边界独立复核（2026-10-22）

**结论：T05 仍为 partial，安全边界未达到整包验收；AC16 继续 blocked。** 已有 child 环境变量白名单与 host RPC 工具入口，但 DSH 子进程为调用模型而显式收到用户 BYOK。候选 systemd unit 限制部分写入和 home 访问，却没有把同一服务身份下的 child 隔离到独立文件权限域；未见网络出口限制或命令 allowlist。生产 profile 的完整加载清单也未由部署侧实物证明。本复核仅用合成凭据和仓库静态材料，没有访问目标机、触发模型/工具或读取真实 secrets。

## 本次隔离负向验证

临时 Node 子进程 probe 用合成字符串 `SYNTHETIC-BYOK-NEGATIVE-PROBE` 调用 `buildDshChildEnv()` 后 spawn 一个只比较环境变量并返回 `BYOK_VISIBLE` 的 Node child；`node --test /private/tmp/t05-child-byok-negative-review.mjs` **1/1 PASS（即预期发现 BYOK 可读）**。临时 probe 源文件已删除。随后 `node --test tests/regression/c2-dsh-env-isolation-test.mjs` **1/1 PASS，26/26 断言**：它确认敏感父环境变量被过滤，但同时明确断言 `POWERTOKENS_API_KEY` 被注入（测试第53–70行）。这两项结果验证现有白名单确实保护若干父级凭据，却不能支持“child 不可读 BYOK”；child 可直接读取 provider 所需的明文 Key。

## 代码与配置事实

| 边界 | 代码／仓库可证事实 | 不能据此声称 |
|---|---|---|
| BYOK | `buildDshChildEnv()` 只创建新环境并注入 `POWERTOKENS_API_KEY`；真实 spawn 在 `dsh-adapter.cjs` 第658–680行以 `spec.apiKey` 构建环境并启动 DSH。`persistent-runner.mjs` 和已生成 profile `powertokens.cjs` 从该环境读取 Key。 | allowlist 不等于密钥隔离；当前模型 provider 在 child 进程内运行，因此可读取该租户的原始 BYOK。服务端 DB/Google/analytics 凭据未从父环境直接复制，并不消除 child 可读配置文件/同身份文件的路径。 |
| OS 身份／文件 | `buildSpawnIdentity()` 在 POSIX 仅当显式提供 `PT_DSH_UID/GID` 时设置 uid/gid；Windows 一律返回空身份；未设置时 child 与父服务沿用同一身份（`dsh-adapter.cjs:286–301,658–680`）。目标环境示例没有配置 UID/GID（受控部署清单第255–273行）。候选 `northstar-shell-r5.service` 是 `User=northstar`，`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`，同时把 runtime、db、secrets 加入 `ReadWritePaths`（第9–22行）；服务环境文件配置为 `root:northstar 0640`（部署清单第245行）。 | 按仓库候选 unit 与部署清单权限、且未另设 child UID/GID 推断，同组 child 可读该 0640 环境文件（含 DSN/OAuth/internal secrets），并因同一 service UID 具备读取主密钥与数据库目录的文件权限；这不是线上 effective 权限的实测。systemd 的只读挂载与 env 白名单不构成父子进程隔离：允许父进程访问的 `secrets`/`db` 路径没有 child-specific ACL。T00 的 SDK 反例也证明 cwd 不能代替沙箱：`dsh-fs-local.resolve('../package.json')` 能越出 cwd（`T00-dsh.md:58–59`）。 |
| 网络／命令 | 候选 unit 没有 `PrivateNetwork`、地址族限制或 egress allowlist；child 环境透传 `PATH`/`ComSpec`（`dsh-adapter.cjs:266–283`）。`shell/dsh-settings.yaml:58–74` 开启 web search provider 与 CLI backends，并配置本地 Ryze MCP endpoint；shell lock 声明 `dsh-bash-local`、`dsh-code-runtime`、`dsh-fs` 等包（`shell/package.json:14–33`）。 | 配置这些扩展不证明每个部署 profile 都实际加载；但也没有 OS 网络隔离或命令执行 allowlist 证据，不能把 prompt、工具注册表或 loopback 地址当作网络/命令边界。service unit 的 `NoNewPrivileges` 也不限制同 UID 可读文件、已允许的网络访问或普通用户可执行命令。 |
| Profile 完整性／扩展范围 | 生成 profile 的 manifest 将 runner、业务模块和依赖输入 hash 绑定；`package.json` 固定 `@deepseek-ai/dsh-base@0.1.1-rc.2`（`docs/dsh-profile-snapshot/run-persistent/*`）。Dsh release manifest 校验 DSH 包文件清单、vendor、integrity 与 lockfile。 | `run-persistent/README.md:3–7` 明确这是仓库生成快照，不是生产 DSH home 导出；快照排除 `settings.yaml`、安装后的 `node_modules`、DSH 生成的 `cordis.yml`。故当前不能声称已知生产 profile 的全量插件、命令、网络能力或 bundle 加载顺序。 |
| Host RPC | 聊天业务工具经 parent RPC/宿主 registry 执行，handler 从可信上下文取身份并做 schema/权限检查；这收口业务 handler 的身份来源。 | RPC 只管理业务工具调用，不限制 child 直接读文件、用其 BYOK 出网或调用本地命令；不能把 host RPC 当 OS sandbox。 |

## 最小可执行验收清单

1. **BYOK 不可由 child 读取：**先实现 host-side model gateway/provider adapter，让 child 只拿限单次 Run、短时、可撤销的请求句柄；原始 Key 留在 host。用合成 Key 启 child，验证 `/proc`/环境/日志/错误/临时文件均无原始 Key，并由 fake gateway 捕获单次受控模型协议请求；检查 child 崩溃、超时、取消、Key 轮换后句柄失效。当前直接从 `POWERTOKENS_API_KEY` 取值的 DSH provider 无法通过“再删一个环境变量”保持模型请求可用。
2. **父子身份与文件边界：**在 Linux disposable rootless/user-namespace 或受控 OS sandbox 中运行真实 child；child 仅能读写本 Run 的合成 workspace 与固定 profile。负向验证读取合成的 host env file、master-key sentinel、DB sentinel、别的 tenant workspace、`../`、symlink、`/proc/<parent>/environ` 均被拒；确认 host 服务仍能访问所需数据。仅用当前 unit 的 `ProtectSystem`/`ReadWritePaths` 或相同 UID 运行不满足本项。
3. **默认拒绝网络／命令：**child 只能连接明确定义的 host-side model gateway；以假 listener 验证 loopback 非 gateway 端口、私网/公网任意地址、DNS 指向变化及重定向均拒绝。默认禁用 bash/CLI/MCP/web 扩展；逐个批准后再验证二进制、参数、工作目录、输出和资源限制。必须证明 shell 直连网络也被隔离，不能只 mock `fetch`。
4. **生产 profile 清单：**由维护者在隔离/受控目标实例提供脱敏的实际 managed profile 文件清单、DSH 生成的 `cordis.yml` hash、加载 bundle 名称/version/integrity/load order，以及 settings 中启用的 web/CLI/MCP/filesystem/command/provider 能力。不得导出 settings/credentials/workspace 内容；对清单中每一扩展绑定 owner、权限、网络目的地、文件范围和更新版本。与仓库 manifest 不一致时 fail-closed 或先人工审阅。
5. **入口与租户负向：**对 chat RPC 与 `/api/tools/:name/execute` 分别测试非授权工具、伪 tenant/run、迟到 RPC、跨租户路径、附件/web 注入；assert executor、网络 fake 和持久化日志均未被触达，合法请求再验证可信身份、Run 归属、预算和审计。
6. **平台边界：**POSIX 验真实 uid/gid 与 ACL、seccomp/namespace、network egress；Windows 需单独验证 Job Object/AppContainer/ACL 或明确不支持不可信扩展。不能从 POSIX `uid/gid` 代码推导 Windows 隔离。

以上第1项是修复 BYOK 暴露的架构前置；第2–4项需要运行时/部署实现，不宜在当前只读复核中用 fixture 模拟成 PASS。当前 T05 schema review 仅为 Registry JSON Schema 子范围 PASS；工具统一、权限、报告/log、文件/网络/命令 OS 边界和生产 profile 仍未整体验收。T05 保持 `partial`，AC16 `blocked`；AC12（报告依据/多报告持久化）也仍按验收矩阵为 `untested`。本次 probe 不改变整包状态。
