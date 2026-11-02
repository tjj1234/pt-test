# T05 / AC16 · BYOK host-gateway design review (2026-10-22)

**结论：原始 Key 暴露已由可复现的负向控制确认；本次未改生产代码、未调用模型或联网。** 最小完整方案应把 DSH 模型协议请求移到宿主侧执行，并让 child 只能通过现有 stdin/stdout RPC 请求模型。只移除 `POWERTOKENS_API_KEY` 会让对话失去 provider 凭据；换成无界长期代理 token 又把凭据风险改成可复用的调用权，不能作为完成。

## 当前真实链路与负向证据

```text
/api/chat (server.cjs)
  → tenant.runDshForUser 解密当前 user Key
  → runtime.run({ apiKey })
  → dsh-adapter.getOrSpawnProcess
  → buildDshChildEnv 注入 POWERTOKENS_API_KEY
  → persistent DSH child / dsh-llm-pi-ai 读 apiKeyEnv
  → https://api.powertokens.ai/v1
```

代码定位：`shell/tenant.cjs:191-224` 解密并把 `apiKey` 传入 runtime；`shell/runtime/dsh-adapter.cjs:659-680` 将该值写入 child env 后 spawn；`shell/runtime/dsh-adapter.cjs:282` 实际设置环境变量；`shell/dsh-settings.yaml:4-10` 将 `POWERTOKENS_API_KEY` 配为模型 provider 的凭据来源，base URL 直指 PT。常驻进程以 tenant 为 key 复用（`dsh-adapter.cjs:635-646`），所以凭据不只存在 child 的启动期，还会随 child 生命周期留存；模型切换/Key 轮换不会重写既有进程环境。

复现命令：`node tests/probes/t05-child-byok-readable-negative-probe.mjs`。本探针只以合成值构造实际 child env 并启动一个 Node 子进程，子进程只返回布尔标记，不打印 Key；**当前预期输出 `EXPECTED NEGATIVE CONTROL: BYOK_VISIBLE` 表示问题复现成功**。它不启动 DSH、不访问数据库、不联网、不产生模型请求。既有 `node --test tests/regression/c2-dsh-env-isolation-test.mjs` 也为 1/1 PASS、26/26 断言，其中明确断言 child 收到合成 `pt-key`；该测试目前保护的是环境白名单和 dashboard 凭据不下发，不是 BYOK 隔离。

## 最小完整实现建议

1. **保留现有 host RPC 生命周期，扩充模型请求帧。** 当前 child → host 的 `tool_request` 已由 `dsh-adapter` 按 `sessionId/requestId` 关联活跃 waiter（`dispatchFrame`、`answerToolRequest`），而 server waiter 持有可信 user/tenant/Run 闭包。新增 `model_request` / `model_chunk` / `model_response` 帧，把 DSH 请求内容和流式响应通过同一受控管道传递；帧不携带也不接受 userId、tenantId、RunId 或 Key 作为授权事实。迟到、重复、取消后的帧必须由 waiter/Run fencing 拒绝。
2. **在 child 注册 host-backed LLM adapter。** 锁定 DSH `@deepseek-ai/dsh-llm` 提供 `LlmAdapter` 与 `ctx.llm.registerAdapter()` 扩展面（本地安装类型声明 `shell/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:118-168,234`）。将 `powertokens` provider 注册切换到自有 adapter；其 `stream(GenerateOptions)` 只发送 RPC 并把宿主返回转成 `StreamChunk`。关闭现有直连 PT provider route，profile/settings 不再包含 child 可用的 PT `apiKeyEnv` 或 provider URL。实现时需用锁定版本 SDK 证明 hook 在实际 Agent call、tool-call 与取消场景均被使用；仅有类/类型层实现不算接线证据。
3. **宿主绑定授权、资格与预算后直接调用 PT。** 按 host 创建的 active Run 上下文取可信 user/tenant、所选 model、permission/localPolicy、能力 revision、adapter endpoint、`RunBudget`。在发起网络 POST 前原子持久化调用 admission/额度占用；拒绝模型不匹配、未放行、超预算、重复请求及超输出上限。宿主从加密存储解密 Key，仅把它写入固定 PT HTTPS 请求的 Authorization header；禁止 child 提供 URL/header/代理目标，禁用重定向转发，脱敏错误与日志。宿主把 provider SSE 映射成 RPC chunks，不把 Key、Authorization header 或原始连接错误回 child。
4. **持久结算与取消不可分离。** 对每个模型 call 用稳定 `callId` 记录 reservation、已发请求/响应观测、usage 与终态；未知上游结果进入 `needs_reconciliation`/人工核查，不以新 callId 重发。取消时同时 abort 宿主 fetch、拒绝迟到 chunks、等 child RPC/Run 与 conversation lease drain 后再释放。provider SDK 与 host gateway 两侧均必须保证 0 retry 时不会暗中重试。
5. **进程/网络边界保持 fail-closed。** child 不读数据库、master key、环境文件、别的租户文件；只可读固定 profile 与当前 tenant workspace，并只写受限输出区。模型只能走已认证的 host RPC。对 child 禁用任意 egress、web/CLI/bash/MCP 和不受控文件工具，除非各自有独立的 host capability/RPC、安全 allowlist 与验收；cwd、prompt、env 白名单及 `uid/gid` 单项均不够。目标 Linux 要实测 OS 隔离；Windows 没有等效沙箱时对不可信扩展 fail closed，不从 POSIX 结果外推。

此实现改变的是模型调用执行位置与 DSH provider 绑定，但保留现有 Run、会话、选模与 PT Key 产品入口。不得先把 Key 换成可长时间复用的 bearer grant，因为长驻 child 能保存、转送或重复使用它，除非该 grant 经宿主有界调用 admission、只对固定接口有效、短时/一次性、按 Run fencing 且 child egress 同时限制。

## 独立验收范围建议

| 验收层 | 最窄可证明的断言 | 必须覆盖的反例 |
|---|---|---|
| 源码/env/子进程 | child env/profile/stdin、`/proc/<pid>/environ`、stdout/stderr、临时文件均无真实或合成 PT Key、DB DSN、master key；child 只返回脱敏状态 | 故意构造旧版 spawn 参数；注入错误含 secret 的 upstream 消息；child 尝试读取 host secret sentinel/父进程环境 |
| 真实 RPC + fake upstream | 锁定 DSH Agent 使用 host-backed adapter；一次正常 SSE chunk/usage/finish 可 round-trip；host fake 收到唯一固定 URL 与合成 Authorization，child never sees it | forged tenant/run/model/url/header、错误 capability revision、迟到/重复 `requestId`、跨 session、abort 后 late chunk、provider 302、超时与 partial response |
| Durable admission | 同一 `callId` 多实例竞争只允许一个上游 POST；DB outage/事务冲突时请求不发；额度在 POST 前保留；unknown 结果进入人工核查且不重提 | 两个 host 同时 admit；首 POST 发出后 ACK 丢失；进程在 reservation/POST/首 chunk/terminal 写入各阶段崩溃 |
| 真实目标 Linux 隔离 | child 无法读取 DB/master/env/其他租户工作区或任意本机/私网/公网；host 仍能经批准路径调用 PT；维护者核验 effective uid/mount/network policy | `../`、symlink、`/proc`、private IP、DNS 重绑定/redirect、bash/CLI/MCP 直连、worker 重启后旧凭据重用 |
| 取消与轮换 | 新 Run 使用新 Key，旧 Run 不能创建新 call；abort/drain 和 ledger 一致 | Key 在调用前、请求中、首 chunk 后撤销；旧 child 上旧 RPC；host restart 后 grant/revision 失效 |

先跑 fake upstream 与合成 secrets；真实 PT 调用只能在单独授权和已核验额度下执行。候选集成后应把当前负向探针改为断言 `BYOK_NOT_VISIBLE`，并让旧 C2 用例不再把 `POWERTOKENS_API_KEY` 注入当成预期行为。

## 需业务方决策

- **Run 中撤销/轮换 Key：**新 Run 立即用新 Key；已获准的在途请求是继续到完成，还是立即 abort 并记录取消/未知结果？这是业务语义，不应由网关实现者自行决定。
- **工具范围：**host-backed 模型适配器只解决模型 Key 暴露；当前 profile 还启用 web/CLI/MCP 等可出网/命令扩展。试用是否全部禁用，还是逐一保留并要求单独 capability、安全边界与预算验收？在回答前应按默认拒绝处理，不能称 T05/AC16 通过。
