# CONTRACT: 原生提问和审批交互 (questions-20261103)
修订版本：`2026-11-04-revision-1`（基于主审 QUESTIONS-ISOLATION-MAIN-REVIEW 闭合 Q-OPTIONS / Q-ID-CONFLICT / Q-DEADLINE / Q-OPTIONS-MUTATION）
基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface QuestionInput {
  questionId: string;
  type: 'clarification' | 'approval';
  question: string;
  options?: string[];              // approval 必须具备明确选项（默认 ['YES', 'NO', 'yes', 'no']）
  approvalTarget?: ApprovalTarget; // approval 必须传入且 displayedToUser=true
  timeoutMs: number;               // 0 < x <= 300,000
}

interface ApprovalTarget {
  displayedToUser: true;
  operationType: string;
  operationPayload: unknown;
}

interface SubmitAnswerInput {
  questionId: string;
  answer: string;
  respondentUserId: string;
  respondentTenantId: string;
}
```

## 输出 Schema

```typescript
interface QuestionAnswerResult {
  questionId: string;
  answer: string;
  answeredAt: number;
  respondentUserId: string;
  consumed: true;
  approvalToken?: IssuedApprovalToken; // 仅审批通过时由权威管理器签发
}

interface IssuedApprovalToken {
  questionId: string;
  operationType: string;
  operationPayloadHash: string;
  runId: string;
  tenantId: string;
  approvedAt: number;
}
```

## 核心安全门禁 (Q- 规则)

1. **Q-OPTIONS（审批选项规范）**：审批必须绑定标准批准/拒绝语义选项；回答不在选项内一律返回 `INVALID_ANSWER`，杜绝任意字符串默认同意。
2. **Q-ID-CONFLICT（同 ID 异参冲突）**：同 questionId 重复调用时，严格校验输入签名（SHA256 of type+question+options+payload）。仅同参调用才幂等返回原 Promise；参数发生任何变更直接返回 `ID_CONFLICT`，严禁复用旧批准。
3. **Q-DEADLINE（绝对截止时间）**：记录绝对截止时间戳 `deadline = createdAt + timeoutMs`。即便系统事件循环 timer 回调尚未触发，只要提交时间超过 deadline，立即拒绝并返回 `QUESTION_TIMEOUT`。
4. **Q-OPTIONS-MUTATION（快照冻结）**：内部深度克隆并冻结 options 数组与 approvalTarget 对象，外部调用方的数组修改无法穿透到已生效提问中。
5. **原子审批签发与消费**：仅当答复明确批准时，管理器方在内部权威登记 `issuedApprovals`；提供 `verifyAndConsumeApproval` 方法供受控执行器进行原子核验与一次性标记。
