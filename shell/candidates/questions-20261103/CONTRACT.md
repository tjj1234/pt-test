# CONTRACT: 原生提问和审批交互 (questions-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface AskQuestionInput {
  runId: string;                   // 绑定的 Run ID（权威来源，不接受自报）
  tenantId: string;                // 租户 ID
  userId: string;                  // 提问发起用户
  questionId: string;              // 幂等 ID，重复调用相同 ID 返回原 Promise
  type: 'clarification' | 'approval';  // 澄清问题 vs 特定操作审批
  question: string;                // 问题文本（不含凭据或敏感系统信息）
  options?: string[];              // 可选答案列表（approval 类型必须提供）
  approvalTarget?: ApprovalTarget; // 审批类型必须：绑定被展示的精确操作
  timeoutMs: number;               // 超时毫秒（必须 > 0，≤ 300_000）
}

interface ApprovalTarget {
  operationType: string;           // 操作类型（固定枚举）
  operationPayload: unknown;       // 操作参数快照（审批绑定此快照，不自动扩展）
  displayedToUser: true;           // 必须为 true，声明已向用户展示
}

interface SubmitAnswerInput {
  questionId: string;
  answer: string;
  respondentUserId: string;        // 回答者 userId
  respondentTenantId: string;      // 回答者 tenantId
}
```

## 输出 Schema

```typescript
interface QuestionResult {
  questionId: string;
  answer: string;
  answeredAt: number;              // Unix ms
  respondentUserId: string;
  consumed: true;                  // 已消费（不可重复）
}

interface CancelResult {
  cancelledCount: number;
  reason: string;
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `QUESTION_TIMEOUT` | 超时，不接受迟到答案 |
| `QUESTION_CANCELLED` | Run 取消，批量拒绝 |
| `ALREADY_ANSWERED` | 已有答案，禁止重复提交 |
| `INVALID_ANSWER` | 答案不在 options 列表中（有 options 时） |
| `UNAUTHORIZED_RESPONDENT` | 回答者 userId/tenantId 与提问不匹配 |
| `QUESTION_NOT_FOUND` | questionId 不存在 |
| `APPROVAL_PAYLOAD_MISMATCH` | 审批目标快照与提交时不一致 |
| `SENSITIVE_CONTENT` | 问题文本含凭据类关键词，拒绝发出 |

## 约束

1. **owner/tenant/Run 绑定**：回答者必须是同一 tenantId 下有权限用户
2. **一次消费**：答案消费后 Promise resolve，后续对同 questionId 的提交返回 ALREADY_ANSWERED
3. **超时自动 reject**：超时后立即 reject，迟到答案被拒绝（QUESTION_TIMEOUT）
4. **取消批量 reject**：cancelPendingQuestions(runId) 将该 Run 所有待答提问 reject
5. **审批精确绑定**：审批只绑定 approvalTarget 快照，不自动授予任意执行权
6. **内容安全**：问题文本检测凭据关键词（password/token/secret/key=），命中则 SENSITIVE_CONTENT

## DSH 原生能力

- `@deepseek-ai/dsh-user-questions`: 原生提问存储与 UI 桥
- `@deepseek-ai/dsh-tool-ask-user`: tool-ask-user 工具定义
- `@deepseek-ai/dsh-user-approval`: 原生审批工具

本候选复用原生 DSH 问答存储结构，在宿主层增加 Run 绑定、一次消费、tenant 隔离约束。

## BLOCKED 项目

- `BLOCKED_BROWSER_UI`: 真实浏览器作答→SSE 推送→同 Run 恢复：需真实 browser E2E，INTEGRATION_PENDING
- `BLOCKED_PROCESS_RESTART`: 进程重启后从 DB 恢复待答提问：需真实 DB，INTEGRATION_PENDING

## 挂载接口

```javascript
const { createQuestionManager } = require('./shell/candidates/questions-20261103/index.cjs');
// 在 persistent-runner.mjs 的 Run 初始化处创建实例
const qm = createQuestionManager({ runId, tenantId, userId });
// tool-ask-user 调用时
const answer = await qm.askQuestion(questionId, { type, question, options, timeoutMs });
// Run 取消时
await qm.cancelPendingQuestions(runId, 'RUN_CANCELLED');
```
