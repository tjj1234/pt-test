# T11 用量证据与 admission 聚焦验证（2026-10-20）

**范围结论：观测到的 SDK response 用量累计与缺失语义有局部 PASS；T11 整包仍未验收。** Node 本地受控测试，无真实模型/PT调用。

运行命令：

```sh
node --test tests/regression/response-usage-test.mjs tests/regression/tool-calls-usage-evidence-test.mjs tests/regression/task-budget-provider-test.mjs
```

结果 **17/17 PASS**。覆盖多轮/工具往返中按 `assistant/message` response 事件累计 usage、按 event sequence 去重、合法零值、字段缺失或非法/溢出时保留 unknown、未观察到 response 不编造请求量；预算 admission 并发同步、结算缺实际成本证据时 fail closed、时钟回拨拒绝新 admission；provider worker 仅查询已认领且已知 taskId、最多八次、有界重试和停机 drain。

限制：response 数只代表 SDK 暴露且被观测到的 response 事件，不证明底层网络尝试或 SDK 内部 retry 数；当前实现没有真实币种费用来源，不能将 token 数换算成实际费用；没有验证真实模型/媒体调用、账单一致性、失败/取消的端到端 UI 呈现或权限。此证据用于 T11 的局部实现/回归，不关闭 T03 预算闭环、T11 整包或 AC13/22。
