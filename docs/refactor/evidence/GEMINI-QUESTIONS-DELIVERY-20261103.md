# GEMINI-QUESTIONS-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/questions-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**22/22 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | 正常提问-回答 | submitAnswer ok=true | ✔ PASS |
| 2 | 正常提问-回答 | answer.answer=CSV | ✔ PASS |
| 3 | 正常提问-回答 | answer.consumed=true | ✔ PASS |
| 4 | 正常提问-回答 | answer.questionId 正确 | ✔ PASS |
| 5 | 超时自动拒绝 | 超时后 promise reject QUESTION_TIMEOUT | ✔ PASS |
| 6 | 超时自动拒绝 | 超时后迟到答案 ALREADY_ANSWERED | ✔ PASS |
| 7 | Run 取消批量拒绝 | cancelledCount=2 | ✔ PASS |
| 8 | Run 取消批量拒绝 | 两个 promise 均 QUESTION_CANCELLED | ✔ PASS |
| 9 | Run 取消批量拒绝 | 取消后新提问立即 QUESTION_CANCELLED | ✔ PASS |
| 10 | 授权检查 | 不同 tenant 拒绝 | ✔ PASS |
| 11 | 授权检查 | 不同 userId 对 approval 拒绝 | ✔ PASS |
| 12 | 防重复提交 | 已回答不能重复提交 (ALREADY_ANSWERED) | ✔ PASS |
| 13 | 幂等性 | 两次调用返回相同 Promise | ✔ PASS |
| 14 | 幂等性 | Promise resolve 正确 | ✔ PASS |
| 15 | 并发多提问 | getPendingQuestions 返回 3 条 | ✔ PASS |
| 16 | 并发多提问 | 并发中 q-par2 正确 resolve | ✔ PASS |
| 17 | 并发多提问 | 其余 2 条仍 pending | ✔ PASS |
| 18 | 内容安全检测 | 含凭据关键词被 SENSITIVE_CONTENT 拒绝 | ✔ PASS |
| 19 | 答案合法性 | 不在 options 中返回 INVALID_ANSWER | ✔ PASS |
| 20 | 标识符校验 | 不存在的 questionId → QUESTION_NOT_FOUND | ✔ PASS |
| 21 | 参数边界 | timeoutMs=0 拒绝 | ✔ PASS |
| 22 | 参数边界 | timeoutMs>300000 拒绝 | ✔ PASS |

## 实现说明

- **原生复用与最小宿主桥**：对齐 DSH `userQuestions` 协议，提供宿主端提问生命周期与持久化队列管理
- **租户与身份强绑定**：每个提问强制关联 `runId`、`tenantId`、`questionType`（clarification vs approval）
- **审批类型防冒领**：针对 `approval` 操作，强制校验答复者的 `userId` 必须与指定的目标审批人匹配
- **单次消费与防重复**：答案一次性消费生效，后续相同 `questionId` 答复均拦截并返回 `ALREADY_ANSWERED`
- **生命周期与级联取消**：当 Run 取消时，批量使挂起的问题 Promise reject 为 `QUESTION_CANCELLED`，后续提问亦即时拒绝
- **内容安全与敏感词拦截**：防止提问中泄露凭据和关键环境变量

## 文件 SHA256

```
e2cd57a80cbcf9f6cdc717b245e54b3fcca28daf1e2240d076d6b0132ab47b5c  shell/candidates/questions-20261103/CONTRACT.md
5ee8b08735b4c7726c161199949f85ab57d2057a7fdc83fd226b796e2052a5ea  shell/candidates/questions-20261103/index.cjs
13c6e6ecb02f1085b6c868e556877881e6d79c92a79d4c9192d3d718f626d2d0  tests/probes/questions-delivery-20261103.mjs
```

## BLOCKED 项目

- 生产环境中跨多节点进程重启时的外部分布式锁与集中式 Pub/Sub 订阅通知机制（需待生产多节点中间件环境就绪后联调）。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (22/22 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载至任务流提问/审批环节。
