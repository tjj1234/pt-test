# T00 · DSH 技术验证证据

日期：2026-10-16。集成基线 `a2adbee64c326653dbf5bfed3f918dd09f96589d`。状态：**真实 SDK＋本地受控模型／工具验证 11 项通过；真实 PT、产品适配接线与完整进程链尚未验收。** 不读取 `.env`，不使用任何现有付费 Key，不改 DSH 包或共享接缝文件。

## 依赖与现有入口

命令：`node tests/probes/northstar-dsh-preflight.mjs`。首次结果 exit 2；`@deepseek-ai/cordis`、`dsh-agent`、`dsh-agent-loop`、`dsh-llm`、`dsh-session`、`dsh-tools`、`dsh-fs-local` 七个包均 MODULE_NOT_FOUND。package-lock 固定 Cordis 4.0.4，其他六包 0.1.1-rc.2；仓库有顶层 `shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz`，没有已安装 SDK。主 Agent 正在安装依赖，安装后继续。该预检不代表并发通过。

已阅读 `shell/runtime/dsh-live-contract-test.mjs`、`dsh-live-smoke-test.mjs`、`shell/persistent-runner.mjs` 与 Adapter。既有 live 脚本需要显式 `DSH_LIVE_PT_KEY`，部分默认入口是历史 Windows 绝对路径，不能直接当成本机可运行命令，也不能自行取 `.env` 的 Key 启动。

## 静态事实与待验证项

| 维度 | 现有代码证据 | 当前结论 |
|---|---|---|
| 并发 | runner stdin 的 task/close 进入同一 Promise queue；进程级 currentTenantId/reportResults/mediaRouteResults | 当前产品串行；真实 SDK 双 session 能力仍待验证，不能仅改 runningJobs |
| 取消 | abort 旁路 queue；调用 agent.cancel({kind:'user'}) 后立即发 aborted 帧 | 有请求取消入口；帧不等于工具/模型真实终止或资源释放 |
| 生命周期 | handleClose 调 sessions.flush，删除两个 Map；未显式调用 agent dispose | 未证明释放 agent 监听器/工具/资源；需确认公开生命周期接口 |
| cwd | 创建 agent 的 meta.cwd=process.cwd()；Adapter spawn cwd=tenant workspace | 当前租户进程同 cwd；未证明每 session 文件工具可安全采用不同任务目录；不允许 process.chdir 切并发目录 |
| 模型切换 | agents.create 时注入 provider/model；热 agentMap 复用不重建 | 当前热 session 不随下一轮参数切换；需确认 SDK 可用方式及历史保留语义 |
| usage | summarize 每遇 assistant/message 就覆盖 usage；最后输出一次 outcome.usage | 不是明确的逐请求累加；不能假定多工具往返累计完整，应检验事件字段的权威语义 |

## 无付费 SDK 验证计划与门禁

使用真实公开 SDK + 本地确定性模型服务/异步受控工具，禁止用 createMockRuntime 替代。需要验证双 session 执行区间重叠、事件 session 归属、取消 A 不影响 B、工具取消信号与收敛、关闭/重开资源生命周期、cwd 和模型选择变更，以及两个模型响应的 usage 如何进入事件。受控模型只验证内核协议与调度，不证明真实 PT 或真实大模型能力。

若依赖安装失败，记录命令、退出状态与非敏感错误，阻塞真实 SDK 结论；不自动改 fork 或另造内核。真实 PT 最终冒烟需用户显式提供测试凭据与预算上限，建议先限定两个短文本 session、一次取消、一次切模型，最大 6 个短请求；实际美元预算须先拿到所选模型官方价格，不能编造固定费用。媒体生成与音视频理解不混入此免费探针。

## 安装成功后的复验（新增，取代“尚未安装”当前状态）

主 Agent 已完成 `npm ci --prefix shell --ignore-scripts --no-audit --no-fund`，433 packages、exit 0；该命令结果由主 Agent 提供。随后本探针实跑仍 **exit 2**：Cordis 可加载；agent/agent-loop/tools 缺 `@deepseek-ai/dsh-scope`，llm/session 缺 `@deepseek-ai/dsh-timeout`，fs-local 缺 `@deepseek-ai/dsh-fs`。这些缺项不在当前 lock packages 表；`shell/.npmrc` 明确 `legacy-peer-deps=true`，对应官方包的 package.json 将它们声明为 peerDependencies。安装成功不能证明运行闭包齐备。本探针现输出 missingPackage，错误不含凭据或用户文件。

**该次阻塞为依赖闭包缺失，不是付费 Key；已由主 Agent 补齐后复验解除，见末节。** 不可跳过它并宣称真实 SDK 通过；由主 Agent 安排 T01 补齐公开依赖，或在授权隔离目录建测试闭包。未修改 package.json、lock、node_modules 或安装策略。

已读安装包的官方 README、公开 `.d.ts` 与根导出实现，得到可实现路径（均为源码证据，尚非运行通过）：
- `dsh-agent/README.md` 的公开创建接口返回 `AgentHandle={agent,dispose():Promise<void>}`。dispose 等待driver收敛、注销agent/session、回收scope；当前runner只取 `{agent}`，应持有handle后在close时调用dispose，不能只删除本地Map。
- `dsh-agent/lib/types/model-selection.d.ts` 公开 `installModelSelection(agentCtx, selectionRef)`；`selectionRef.current` 可修改并在下一step装配快照。可通过保留ref实现热会话下一步切模型，不必修改内核。
- `dsh-llm/lib/types/index.d.ts` 公开 `LlmAdapter.stream(options)` 与 `registerAdapter`，可注入纯本地确定性响应验证真实AgentLoop，不调用PT。`GenerateOptions` 有sessionId、signal、model；`StreamChunk` 有usage与finish，可用已知数值做逐请求对账。
- `dsh-fs-local/README.md` 公开每次resolve的opts.cwd，模型文件工具传session cwd；同文明确 config.cwd不是沙箱，绝对路径和..可逃逸。需真实验证session cwd接线和额外权限门禁，不应改process.cwd。

上述公开接口为后续受控探针的实施依据；依赖恢复后受控探针与实际结果见末节。


## 当前结论：真实 SDK 受控验证通过

主 Agent 已补装缺失的 18 个非 optional peer，精确版本 `0.1.1-rc.2`；本子任务未修改依赖。实际复验：

```bash
node tests/probes/northstar-dsh-preflight.mjs
node tests/probes/northstar-dsh-controlled.mjs
```

两个命令均 **exit 0**。预检七包均成功导入。受控探针通过 11 项行为断言，使用真实 Cordis `4.0.4` 与 DSH `0.1.1-rc.2` 的 AgentRegistry、SessionStore、LlmRuntime、ToolRuntime、AgentLoop、LocalFileSystem；模型为公开 LlmAdapter 的纯进程内确定性实现，工具为可取消的异步 barrier，没有 HTTP 请求或付费调用。

| 场景 | 实测结果与边界 |
|---|---|
| 同进程双session | A/B 都进入真实AgentLoop的工具执行，任一工具返回前barrier已观察两者，证明执行区间重叠 |
| 取消隔离 | cancel A 后A工具收到AbortSignal且whenIdle收敛；B工具未结束，释放B后正常继续第二次模型请求 |
| cwd | 两agent session有不同cwd元数据，process.cwd不变；真实LocalFileSystem.resolve可用每次opts.cwd得到不同目标 |
| 权限边界反例 | cwd=repo/shell时resolve('../package.json')实际到repo/package.json，证明cwd不是文件隔离措施；生产必须另加限制 |
| 热模型切换 | 同一B session从selectionRef.current model one改two，下一次真实SDK请求model=two；没有改内核或重建session |
| 生命周期 | handle.dispose后agents与sessions均清空；相同A ID可重新创建，没有注册冲突 |
| 用量 | B工具往返两次assistant/message分别保留input=10/20、output=1/2、cacheRead=2/2；累计uncached input=30、output=3、cacheRead=4。usage是每次模型响应，不可只取最后一个响应；inputTokens不含cacheRead，统计需按DSH定义处理 |

**技术路径判定**：当前精确版本公开SDK具备同用户进程内多session、独立取消、dispose与热切模型的实现基础，可继续T03/T04，无需为此修改DSH内核。产品runner当前全局队列/共享状态/丢弃dispose/usage末值仍需正式接线改造；本探针不证明这些产品缺口已经修复。

**剩余验证**：真实上游网络请求取消与计量、异常/超时、反复创建销毁长期资源趋势、真实文件工具与命令隔离、Adapter进程/重启/流式、真实PT模型切换与费用均未覆盖。预检和受控测试不访问 `.env`、凭据或持久用户数据，不创建实际用户工作目录、不改DSH包。所有免费检查不足以替代最终真实PT与浏览器验收。
