# 05/06 原生接缝与复用矩阵 (REUSE-MATRIX)

> **版本**：1.0.0  
> **所属阶段**：M0 原生接缝与架构评审  
> **依赖环境**：`shell/node_modules/@deepseek-ai/*` (锁定版本 `0.1.1-rc.2`)

---

## 1. 原生包符号与导出核实验查表

本表基于当前真实安装的 `@deepseek-ai/*` 源码及 `.d.ts` 声明逐一核实。禁止使用任何虚构或不存在的 API。

| 原生包名 | 安装版本 | 主入口 / 类型文件 | 真实导出符号 (Exports) | 原生核心能力与服务契约 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-user-questions` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `UserQuestionService`, `UserQuestionError`, `default` | 声明 `ctx.userQuestions` 服务，单活 `registerProvider(provider)`，`ask(request)`。支持多选项与 `plan-review` 意图展示。仅内存服务定义，无持久化与跨轮次恢复能力。 |
| `@deepseek-ai/dsh-tool-ask-user` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `name: "tool-ask-user"`, `inject: ['userQuestions']`, `apply` | 向模型暴露 `ask_user_question` 工具，调用 `ctx.userQuestions.ask()` 暂停模型轮次，等待 UI 回复并传递回 Agent 循环。依赖宿主提供有效 provider。 |
| `@deepseek-ai/dsh-user-approval` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `ApprovalService`, `ApprovalRequestId`, `APPROVAL_POLICIES`, `effectiveApprovalPolicy`, `setApprovalPolicy` | 声明 `ctx.approval` 服务，事件 `'approval/request'` waterfall 机制。输出为闭合集合：`allowed-once`, `rejected`, `cancelled`, `unavailable`。仅在当前活跃轮次有效，无持久化审批令牌。 |
| `@deepseek-ai/dsh-shell` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `ShellExecutor`, `SHELL_SETTINGS_NAMESPACE`, `DSH_ENV_PREFIX`, `parseExitStatus` | 声明 `ctx.shell` 执行抽象，提供 `resolve(request)`, `run(spec)`, `start(spec)`。前后台进程句柄与退出码解析。不自带沙箱约束，由具体实现提供。 |
| `@deepseek-ai/dsh-bash-sandbox` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `SandboxBashExecutor`, `default` | 替换 `dsh-bash-local`，将 `['bash', '-c', cmd]` 交由 `ctx.sandbox` 包装。若 runner 缺失直接抛出结构化 `SANDBOX_UNAVAILABLE`，拒绝裸宿主执行。只限制文件系统写入。 |
| `@deepseek-ai/dsh-sandbox-local` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `LocalSandboxProvider`, `default` | 平台 runner 发现与探测：Linux (bwrap -> landlock)、macOS (Seatbelt `sandbox-exec`)、Windows (Restricted Token)。报告完整度 (`full` / `partial`)。 |
| `@deepseek-ai/dsh-sandbox-policy` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `SandboxPolicyService`, `SANDBOX_MODES`, `effectiveSandboxMode`, `setSandboxMode` | 统一管理模式：`read-only`、`workspace-write`、`danger-full-access` 及工作区可写根路径。为 shell 与 fs 提供一致策略配置。 |
| `@deepseek-ai/dsh-fs-sandbox` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `SandboxedFileSystem`, `default` | 继承 `LocalFileSystem`，在写入和编辑时执行路径策略围栏。**关键限制**：所有读取操作直接通过，不限制跨租户越界读取；围栏非内核安全边界。 |
| `@deepseek-ai/node-addon-landlock-run` | `0.1.1` | `lib/index.js`<br>`lib/index.d.ts` | `LAUNCHER_BIN`, `LAUNCHER_FAILURE_EXIT`, `grantArgs`, `launcherPath`, `probe` | Linux 平台 Landlock 原生启动二进制探针与参数封装。仅支持 Linux 内核 5.13+，不支持 macOS。 |
| `@deepseek-ai/dsh-spill` | `0.1.1-rc.2` | `lib/index.js`<br>`lib/types/index.d.ts` | `SpillService`, `default` | 提供 stdout/stderr 溢出控制与安全内存/磁盘缓冲区管理，防止过长输出耗尽宿主内存。 |

---

## 2. 真实能力差距分析 (Gaps) 与设计归因

原生 `@deepseek-ai` 属于通用 Agent 开发框架，未针对企业级多租户、防篡改审计与强隔离执行进行设计。以下为明确查实的架构缺口：

```
+-----------------------------------------------------------------------------------------+
|                                  原生能力与宿主缺口分界                                 |
+-----------------------------------------------------------------------------------------+
| 原生提供 (@deepseek-ai)                                                                 |
|   - 问答内存协议 (UserQuestionService)                                                  |
|   - 单轮审批 Waterfall ('approval/request' -> allowed-once)                             |
|   - 命令执行器抽象 (ShellExecutor)                                                      |
|   - 基于文件写入约束的本地 Runner (SandboxBashExecutor + LocalSandboxProvider)          |
+-----------------------------------------------------------------------------------------+
                                          |
                                          v [宿主必须补充的缺口]
+-----------------------------------------------------------------------------------------+
| 宿主扩展 (Package 05 & Package 06 架构层)                                               |
|   1. 跨轮次持久化与状态机恢复 (PostgreSQL / Durable Storage)                            |
|   2. 身份与操作绑定: Tenant + RunId + CallId + CanonicalDigest 强签名                   |
|   3. 批准执行权防重放/防篡改: 原子 CAS Claim + 期限与撤销校验                           |
|   4. 租户只读隔离: 宿主层 `realpathSync` + 硬链接检测 + 授权根判定                      |
|   5. 隔离兜底: 无原生隔离 Runner 时一律 Fail-Closed (禁用 bare spawn)                   |
|   6. 凭据与网络隔离: 执行前彻底剥离宿主环境变量与敏感凭据                                |
+-----------------------------------------------------------------------------------------+
```

### 缺口细项详述：

1. **审批不可跨轮次持久化 (Gap-01)**：
   - *原生限制*：`dsh-user-approval` 的 `allowed-once` 仅针对当前轮次有效，Agent 重启或新轮次下历史 Promise 丢失。
   - *宿主职责*：宿主维护 `RequestBinding` 和持久化存储，记录完整的 `revision` 与 `digest`。新轮次唤醒时必须重新核验有效性，不得直接复活已死 Promise。

2. **缺少多租户与操作强绑定 (Gap-02)**：
   - *原生限制*：原生接口仅传递 `question`、`options`，未内建租户、操作上下文（CWD、环境变量、网络需求、执行脚本绝对哈希）的规范化摘要。
   - *宿主职责*：在 05 提问审批中生成不可变规范化摘要 `CanonicalDigest`，在 06 执行前重新计算并比对，任何参数变动均直接导致授权作废。

3. **文件读取无内核隔离 (Gap-03)**：
   - *原生限制*：`dsh-fs-sandbox` 声明“Reads pass through untouched: every mode permits reading”，其策略围栏仅拦截写入。
   - *宿主职责*：06 必须在宿主层面提供防穿越路径解析器，严查父目录软链接、硬链接（`nlink > 1`）以及越出租户根目录的读取。

4. **原生沙箱不防网络出网 (Gap-04)**：
   - *原生限制*：`dsh-bash-sandbox` 声明只限制文件影响，网络完全不受限制。
   - *宿主职责*：在无网络隔离命名空间或专用容器环境时，标记网络隔离为 `BLOCKED`，禁止在需隔离网络场景下默认放行。

5. **执行权限令牌防伪造与防并发消费 (Gap-05)**：
   - *原生限制*：原生无 Token 签发与消费概念。
   - *宿主职责*：实现带 HMAC 签名的 `GrantRef`，在持久层采用数据库原子 `UPDATE ... WHERE status = 'issued' RETURNING ...` 实现 CAS 单次消费，杜绝双重消费与并发竞争。

---

## 3. 最小宿主接线规范 (Non-Invasive Adapter)

为遵循主程序门禁“不得修改 `@deepseek-ai` 内部源码”，宿主模块采用外置适配器模式（Adapter Pattern）与 Service Provider 机制接入：

```
[Cordis Context]
       |
       +--> ctx.userQuestions (原生服务)
       |           ^
       |           | registerProvider()
       |    [HostUserQuestionProvider] <--- 宿主适配器 (绑定持久化与 UI)
       |
       +--> ctx.approval (原生服务)
       |           ^
       |           | 'approval/request' waterfall
       |    [HostApprovalInterceptor] <--- 宿主拦截器 (校验 Digest 与 权限)
       |
       +--> ctx.shell (原生服务)
                   ^
                   | 注入
            [HostSandboxBashExecutor] <--- 封装原生 SandboxBashExecutor
                   |
            +------+------+
            |             |
       [Runner可用]   [Runner不可用]
            |             |
       受约束运行    Fail-Closed (抛出 SANDBOX_UNAVAILABLE)
```

1. **提问接入**：宿主实现 `UserQuestionProvider`，向 `ctx.userQuestions.registerProvider()` 注册。所有问题经由宿主包装为 `RequestBinding` 并持久化。
2. **审批接入**：宿主监听 `'approval/request'` 事件，在 waterfall 链中结合服务端权威记录执行判定，杜绝客户端冒充。
3. **执行接入**：06 优先利用原生 `SandboxBashExecutor` + `LocalSandboxProvider`；在平台缺少隔离后端（如当前 macOS 无有效沙箱容器、且 Seatbelt 未配置安全策略）时，严格遵循 Fail-Closed，拒绝调用原生或宿主裸 `spawn`。
