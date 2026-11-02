# T05 工具执行与租户安全状态

**结论：T05 仍不能验收为 PASS。** 聊天业务工具已改为 parent host RPC，由宿主的可信 handler/registry 执行；子进程不再收到全局或 scoped dashboard 凭据。当前仍有两项明确阻断：DSH 子进程保留模型 BYOK（`POWERTOKENS_API_KEY`），且没有 OS 文件/网络/命令沙箱证据。T00 已证明 cwd 不能作为文件沙箱。Host RPC 收口工具执行权限，但不消除模型密钥暴露或通用进程能力风险。

| 判定 | 问题与证据 | 影响 |
|---|---|---|
| **已修复，需保持回归** | 聊天侧媒体、GA、归因等业务工具通过 host RPC/registry 进入宿主处理；child 不再持有 analytics/dashboard 凭据 | 权限与执行落在 host trusted context。需持续验证各工具注册表权限、tenant/Run绑定和失败关闭，不可把 RPC 可达等同于授权通过 |
| **阻断** | DSH 子进程仍接收原始 `POWERTOKENS_API_KEY`（BYOK）；cwd 不是文件沙箱，OS 文件、网络、命令隔离没有验收证据 | 子进程或未审查扩展仍可读取 BYOK、访问工作区外文件或发起网络/命令操作；AC05/07 不成立 |
| **需按调用面持续核对** | 高风险媒体副作用必须经 durable Run/external-operation 生命周期；当前聊天 host handler 已使用 Run/lease 路径，HTTP 同步媒体入口是否仍存在及其生命周期需以当前 server/tool route 为准 | 不应从 host RPC 收口推断 HTTP 与聊天的取消、未知提交恢复及审计语义天然一致 |
| **风险，非当前已证实越权** | parent RPC 帧没有 `runId`，以 `sessionId` 查当前 waiter；媒体 handler 的 trusted `taskRun` 闭包再绑定 Run | 当前路径不让模型指定 tenant/Run，且 server 为每次调用注入受信 identity；但协议无法独立证明帧属于哪个 Run，迟到/伪造帧只能依赖 waiter 生命周期防护 |
| **已修复，需保持回归** | child 不接收 dashboard internal key、tenant ID/token 或 dashboard port；环境隔离回归覆盖父环境含 mock scoped token 的情形 | child 不持有 dashboard bearer；各 analytics 权限由 host handler 校验 |
| **非阻断改进** | DSH 热进程环境中的 BYOK key 来自 spawn 时 `spec.apiKey`，进程按 tenant 复用 | 用户轮换/撤销 Key 后，旧环境可能保留旧值直到进程重建；应做轮换失效/进程回收 |

## 证据与实际执行路径

**聊天业务工具桥（当前状态）**：Runner 注册的业务工具通过 parent RPC 发送 `{requestId, sessionId, name, args}`；Adapter 以 waiter/session 绑定回调，server host handler 再以可信 tenant/user/Run context 路由到宿主 registry/executor。媒体、GA、归因等工具的执行逻辑不在 child 内做业务 HTTP/HMAC；模型只提供工具名和参数，不能自行提供可信 tenant 或 Run 身份。受控真实 SDK/RPC probe 验证了一个 session 的媒体 RPC 挂起时另一个 session 可以完成、取消归属隔离及模型热切换；它不是多租户生产部署验收。应维持 host 注册表逐次 schema/RBAC 检查，并为每个 handler 保留失败关闭与 Run/lease fencing。工具能力提示仍不是执行授权本身。

**凭证与出网**：当前 `buildDshChildEnv` 不注入 `PT_DASH_INTERNAL_KEY`、`PT_DASH_TENANT_ID`、`PT_DASH_TENANT_TOKEN` 或 `DASH_PORT`；回归测试以含 mock scoped token 的父环境验证这些值不会复制进 child。业务工具权限由宿主处理，child 不需要 dashboard bearer。Adapter 仍把 `spec.apiKey` 作为 `POWERTOKENS_API_KEY` 注入，作为模型 BYOK；因此子进程可读取该 key，密钥轮换也可能受热进程生命周期影响，仍需解决。没有 OS 出网策略、命令隔离或进程降权验收证据。`shell/dsh-settings.yaml` 配置 web/CLI/MCP 能力，是否每个 profile 实际加载需运行时核验；不能把 host RPC 当成整个子进程的 OS 沙箱。

子进程配置不只包含自定义 Runner：`shell/dsh-settings.yaml` 的 `web-search-pro` 开启 `registerProvider` 与 `enableCliBackends`（约 54–63 行），并配置本地 `ryze` MCP endpoint（65–70 行）。这意味着网络/CLI/MCP 扩展至少被配置为可用能力；不能把工具名、prompt 或 cwd 当成安全边界。是否每个 profile 都成功加载这些插件需运行时证据，但当前没有 OS 出网策略、命令 allowlist/隔离身份或审计证明。T00 的真实 SDK 受控测试明确证实 `dsh-fs-local` 在 cwd 为 `repo/shell` 时，`resolve('../package.json')` 到达 `repo/package.json`；同一证据明确声明 cwd 不是 sandbox。T00 只证明 SDK 文件工具行为，不证明本生产 profile 必然注册该文件工具；但它足以否定以 cwd 作为文件隔离证明。`shell/runtime/artifacts.cjs` 的路径校验保护产物收集/下载路由，不限制 Agent 任意读写。需要 OS 级文件/网络/进程边界或禁用所有不受控扩展，不能用 VM、prompt 约束或 workspace cwd 代替。

**租户与 Run 绑定**：RPC 帧有 `requestId` 与 `sessionId`，Adapter 按对应 session waiter 分发，child 不携带 dashboard token；server handler 从受信请求闭包取得 user/tenant/Run，不使用模型传来的身份字段。媒体 handler 要求 durable Run/lease 并使用 operation key。需继续检查每类工具的 handler 是否都绑定当前 Run/tenant/权限；RPC session 关联本身不替代宿主授权，迟到请求应由 waiter 生命周期拒绝。

**HTTP 媒体工具**：hostRPC 状态不自动证明 HTTP `/api/tools/:name/execute` 与聊天使用相同的 durable Run lifecycle。以当前 route、registry executor 和 media handler 的实际接线分别核验；若 HTTP 仍直调同步 provider executor，应迁入 Run/operation lifecycle 或禁止该调用方式。

**保护已确认的范围**：server 根据登录会话形成 user/tenant context，child env 不含 dashboard 凭据；业务工具走 host handler。产物路径校验约束 artifacts URL，但不提供 Agent 文件系统沙箱。需继续审查 registry 动态权限注册边界，且不能把受控 SDK probe 当成 production OS sandbox 证据。

## 建议修复顺序

1. **保留 host RPC 权限边界并收回 BYOK**：继续确保媒体/GA/归因等业务工具只由 host handler 执行并逐次校验可信身份、schema 和权限；评估把模型调用代理到 host 或其他不暴露原始 BYOK 的受控路径。dashboard 凭据不再传 child，补充回归防止重新注入。
2. **收紧执行环境**：确认 production profile 实际工具清单；默认禁用无审查的 filesystem/bash/CLI/MCP/Web 扩展。对必须保留的工具，在 OS 层实施限定目录、降权身份、网络出口规则与命令限制；用越界路径、符号链接、私网/本机访问、附件提示注入做运行验证。T00 的 cwd 越界用例应成为负向验收。
3. **统一付费副作用和 RPC fencing**：按当前 server route 验证 `/api/tools/.../media.route` 是否进入 Run + external operation store；所有 RPC 回调处理取消后迟到响应、会话隔离与宿主授权。工具日志关联真实 Run 与 operation。
4. **收窄剩余权限与密钥生命周期**：dashboard child credential 已移除，无需再扩大 scoped token；制定 BYOK 轮换/撤销时热进程失效方案。将 `registerTool` 未知权限自动授权行为限制在静态可信定义。

## 验收状态边界

受控证据支持：业务工具经 host RPC 执行；child 不接收 global/scoped dashboard 凭据或 dashboard 端口；隔离真实 SDK probe 验证了 RPC session 并发、取消隔离和热模型切换；环境隔离测试 26/26 通过。受控证据不支持：BYOK 不可被 child 读取、文件/命令/网络具备 OS sandbox、production profile 全部扩展均受权限控制、每条 HTTP media 路径具备 durable Run fencing、恶意附件/网页不可诱导滥用。因此当前判定仍为 **T05 partial / blocked for acceptance**；不能据此宣布部署或上线安全通过。
