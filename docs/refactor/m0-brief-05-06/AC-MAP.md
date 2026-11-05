# 05/06 全量验收矩阵映射表 (AC-MAP: F01–F40)

> **版本**：1.0.0  
> **所属阶段**：M0 原生接缝与架构评审  
> **状态标注规则**：
> - `COVERED`：已在当前实现或工作树中被探针完整覆盖并通过验证。
> - `NEEDS_REVISION`：已有基础实现，需在 M1–M2 按冻结契约强化。
> - `GAP_HOST`：原生缺失的能力，需宿主层通过外置适配器实现并补充用例。
> - `BLOCKED_EXT`：依赖真实内核沙箱（如 Linux bwrap/容器）或 Staging 端到端环境，若缺失环境则标记为安全阻塞。

---

## 全量 40 项验收标准矩阵 (F01 – F40)

| 编号 | 验收标准 (Brief 核心条目) | 当前状态 | 责任归属 | 验证方式与测试手段 | 目标组件与文件位置 |
|---|---|---|---|---|---|
| **F01** | 锁定原生服务真实加载、无 provider 拒绝、重复 provider 拦截、答案结构保真 | `NEEDS_REVISION` | 包作者 + 主程 | SDK 单测探针，测试 Context 注入与空注册 | `shell/candidates/questions-20261103/index.cjs` |
| **F02** | 原生 approval 无应答者/never 策略/审计失败/非活跃轮次 fail-closed，正常 allowed-once 配对 | `NEEDS_REVISION` | 包作者 | SDK 真实事件探针，模拟 waterfall 中断与非活跃轮次 | `shell/candidates/questions-20261103/index.cjs` |
| **F03** | 原生 tool→问题→UI 答复→同一活跃 Run 恢复，agent/call 关联正确，子 agent 未授权提问拒绝 | `GAP_HOST` | 包作者 + 独立测试 | 集成测试，模拟 agent 树调用与 tool 暂停唤醒 | `shell/candidates/questions-20261103/index.cjs` |
| **F04** | 宿主补充字段逐条证明原生缺口，profile/provider 无重复装配，不改 DSH 内部 | `COVERED` | 主程架构门禁 | 静态代码与依赖审计，核对原生 `package.json` | `docs/refactor/m0-brief-05-06/REUSE-MATRIX.md` |
| **F05** | approval 合法 schema、必选语义明确；空/未知 type、非法 options/超大输入拒绝 | `NEEDS_REVISION` | 包作者 | 边界值单元测试，注入畸形 JSON、极大字符串与未定义枚举 | `shell/candidates/questions-20261103/index.cjs` |
| **F06** | YES/NO 换顺序、不同语言、拒绝/跳过/custom 自由文本均不能误签发批准 | `COVERED` | 包作者 | Q-OPTIONS / Q-OPTIONS-MUTATION 专项用例，语义解析断言 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F07** | 同 ID 同参幂等；不同 question/type/payload/options/deadline 等异参冲突 | `COVERED` | 包作者 | Q-ID-CONFLICT 专项用例，并发同/异参数请求验证 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F08** | 请求 options/target 嵌套对象创建后突变，不改变显示/摘要/允许答案 | `COVERED` | 包作者 | 深度 Object.freeze 突变用例，验证快照隔离 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F09** | 绝对 deadline：timer 未运行仍拒迟答；边界时钟/超时参数明确且有界 | `COVERED` | 包作者 | Q-DEADLINE 专项用例，人工篡改时钟与绝对时间戳校验 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F10** | 其他 user/tenant/Run/call/operation 访问/答复/消费/查询拒绝，无枚举私密内容 | `GAP_HOST` | 包作者 + 主程 | 双租户对比测试，注入 Tenant B Token 访问 Tenant A 资源 | `shell/candidates/questions-20261103/index.cjs` |
| **F11** | 候选内容/目标版本/cwd/root/args/env/network 范围变更使旧批准失效 | `NEEDS_REVISION` | 05/06 跨包联测 | 生成批准后篡改目标文件版本或 cwd，验证 06 拦截 | 05 提问与 06 执行联合测试脚本 |
| **F12** | NO 不签发；取消前待答/取消后新问均拒；已签发未消费批准取消后失效 | `NEEDS_REVISION` | 包作者 | 状态流转探针，验证 Run 取消时令牌与待决问题的级联作废 | `shell/candidates/questions-20261103/index.cjs` |
| **F13** | 已签发批准到期、权限撤销、Run 终态后不可消费；执行中取消如实记录 | `NEEDS_REVISION` | 包作者 + 仓储 | 模拟 worker 延时消费与异步撤回竞态 | `shell/candidates/isolation-20261103/index.cjs` |
| **F14** | 返回 token/record 的外部突变不修改权威记录；签名或 opaque 引用篡改拒绝 | `NEEDS_REVISION` | 包作者 | 客户端就地修改返回对象字段并重新提交，验证服务端不变 | `shell/candidates/questions-20261103/index.cjs` |
| **F15** | 任意随机未签发 ID 拒绝，不允许固定测试值特判；无 verifier/异常一律不执行 | `COVERED` | 包作者 | I-FORGED-APPROVAL 专项用例，随机 UUID 注入验证 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F16** | verifier 比对可信预期 context，不只比较内部 hash/type；跨 scope 重放拒绝 | `NEEDS_REVISION` | 05/06 跨包联测 | 模拟同一审批 Token 在异构 scope/cwd 下执行并断言拦截 | `shell/candidates/isolation-20261103/index.cjs` |
| **F17** | 双击/并发/双 worker 消费恰有一个获权，重复返回稳定结果，不再执行 | `GAP_HOST` | 包作者 + 仓储 | 基于 PGlite/内存原子 CAS 并发 10 路 worker 测试单次消费 | `shell/candidates/isolation-20261103/index.cjs` |
| **F18** | 摘要规范化区分数组分隔符/空缺/null/类型/operationType；非法值拒绝 | `NEEDS_REVISION` | 包作者 | RFC 8785 CanonicalDigest 一致性单测 | `shell/candidates/questions-20261103/index.cjs` |
| **F19** | 批准与审计持久化失败无执行；claim/执行前后崩溃保留可核对状态 | `GAP_HOST` | 包作者 + 仓储 | 故障注入（强制抛出 DB 写入异常），验证无执行副作用 | `shell/candidates/isolation-20261103/index.cjs` |
| **F20** | 重启待答不复活旧 Promise/原生轮次；已消费或 unknown 不重放执行 | `GAP_HOST` | 包作者 + 主程 | 模拟进程终止与重启恢复，验证未完成任务置为 UNKNOWN | `shell/candidates/questions-20261103/index.cjs` |
| **F21** | 新增/移除 provider 或重连不丢 scope，旧问题/重复事件不重建批准 | `NEEDS_REVISION` | 包作者 | 动态切换 UserQuestionProvider 实例，验证状态隔离 | `shell/candidates/questions-20261103/index.cjs` |
| **F22** | 无真实后端/runner 缺失/权限不足不满足合同则拒绝，布尔 true 不能绕过 | `COVERED` | 包作者 | I-SCRIPT-ROOT 专项用例，验证无 isolationBackend 必拒 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F23** | 执行确由原生/经审 provider 受约束 argv 承载，无直接宿主 spawn 兜底 | `NEEDS_REVISION` | 包作者 + 代码审 | 源码静态扫描，断言所有执行路径均经由受限 runner | `shell/candidates/isolation-20261103/index.cjs` |
| **F24** | 实际 root 与挂载/可读可写范围、共享 tmp 及凭据可见性符合策略，租户隔离 | `BLOCKED_EXT` | 包作者 + OS 环境 | 需 Linux 环境下使用 bwrap 真实挂载验证租户 A/B 隔离 | 待 Linux 持续集成节点执行 |
| **F25** | 未允许的网络实际被阻止；静态黑名单/无网络词脚本不能绕过 | `BLOCKED_EXT` | 包作者 + 网络环境 | 在受限命名空间下尝试发起 curl/ping 外网连接，验证物理阻断 | 待 Linux 容器网络节点执行 |
| **F26** | 敏感环境/文件与 DSH 身份不跨 Run 泄露；禁止目录不可见或访问被拒 | `NEEDS_REVISION` | 包作者 | 注入 `process.env.AWS_SECRET`，执行脚本 `env` 断言无输出 | `shell/candidates/isolation-20261103/index.cjs` |
| **F27** | 父/叶/授权根 symlink、hardlink、绝对/编码路径和检查后替换均无越界 | `COVERED` | 包作者 | I-PARENT-LINK / I-HARDLINK 专项用例，OS 文件系统严测 | `tests/probes/questions-isolation-main-review-20261104.mjs` |
| **F28** | 安全 FD 打开/读取，大小受控；不全文读入后才截断；UTF8 边界不挂死 | `NEEDS_REVISION` | 包作者 | 针对大文件 (>100MB) 与畸形字节流的流式截断读取测试 | `shell/candidates/isolation-20261103/index.cjs` |
| **F29** | list-dir 有界条目/输出，超大目录/权限错/不存在有稳定错误 | `NEEDS_REVISION` | 包作者 | 构造 10,000 个文件的深度目录树，验证分页/截断返回 | `shell/candidates/isolation-20261103/index.cjs` |
| **F30** | stdout/stderr 各自及总量有界，spill 权限/保留受控；满盘/异常无泄漏 | `NEEDS_REVISION` | 包作者 | 复用 `dsh-spill` 服务，注入海量输出流测试限额控制 | `shell/candidates/isolation-20261103/index.cjs` |
| **F31** | 执行超时、取消、signal 预取消与竞态，停止并等待整个受控进程树 | `NEEDS_REVISION` | 包作者 | 启动派生多级子进程的脚本，发送取消信号，验证全树 SIGKILL | `shell/candidates/isolation-20261103/index.cjs` |
| **F32** | background jobs 归属/读取/kill/dispose 与重启策略明确，无孤儿 | `NEEDS_REVISION` | 包作者 | 结合 `dsh-tool-jobs` 验证后台长任务的生命周期绑定 | `shell/candidates/isolation-20261103/index.cjs` |
| **F33** | 执行参数超限/NaN/Infinity/非法类型拒绝或按冻结规则限制 | `COVERED` | 包作者 | 边界值参数校验用例，测试超限内存与非数值配置 | `shell/candidates/isolation-20261103/index.cjs` |
| **F34** | backend 声明 full/partial/unavailable 与实效一致，runner 失败不误报 | `NEEDS_REVISION` | 包作者 | 模拟 runner 退出码 125/126/127，区分执行器损坏与业务失败 | `shell/candidates/isolation-20261103/index.cjs` |
| **F35** | 来源/文件撤销与活动执行竞态：新访问拒绝，既有副作用/未知结果可核对 | `GAP_HOST` | 跨包联测 | 并发执行过程中撤回授权，验证后续步骤被物理阻断 | 跨模块集成探针 |
| **F36** | UI 加载/空/错误/过期/拒绝/等待与后端一致；键盘、焦点、离开/刷新 | `GAP_HOST` | 作者自测 + 独立测试 | Staging Web 界面手工点击走查与 UI 自动化录制 | 前端组件交互自验 |
| **F37** | 取消/错误保留现有成果与历史，不伪称上游停止或零费；未知不自动重提 | `GAP_HOST` | 主程集成 | 集成计费与审计模块，断言取消事件记录完整执行耗时 | 计费跨包联测 |
| **F38** | 问题、批准、执行、审计、产物的 Run/call 可串联，无敏感正文泄露 | `GAP_HOST` | 独立审计 | 端到端审计链检查，核实数据库中不存在原始 Secret 明文 | 审计数据流校验 |
| **F39** | 原聊天/媒体授权/取消/资料/记忆/Skill 链受影响回归，同版本验证 | `GAP_HOST` | 主程集成 | 全链路 35 包回归冒烟，重点验证上下文不受改动干扰 | 主仓库回归门禁 |
| **F40** | 同一冻结归档在 staging 独立验收；真实 PT/正式冒烟单独授权 | `BLOCKED_EXT` | 独立测试 / 发布团队 | 交付分支打 Tag 并发布至 Staging 环境进行独立验收 | 发布门禁 |
