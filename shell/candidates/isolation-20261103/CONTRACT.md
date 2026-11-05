# CONTRACT: 受控执行与审批绑定 (isolation-20261103)

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface ControlledExecInput {
  runId: string;                   // 绑定 Run ID（权威来源）
  tenantId: string;
  execType: AllowedExecType;       // 固定枚举，不接受自由字符串
  input: ControlledInput;
  approvalToken?: ApprovalToken;   // 需审批的 execType 必须提供
  resourceLimits?: ResourceLimits;
  signal?: AbortSignal;
}

type AllowedExecType =
  | 'read-file'        // 只读文件，仅限 allowedPaths 内
  | 'list-dir'         // 列目录，仅限 allowedPaths 内
  | 'run-script';      // 受限脚本（需审批 token）

interface ApprovalToken {
  questionId: string;              // 来自 questions-20261103 的 questionId
  operationType: string;           // 必须与 execType 匹配
  operationPayloadHash: string;    // 操作参数 SHA256，防篡改
}

interface ControlledInput {
  path?: string;                   // read-file/list-dir 使用
  script?: string;                 // run-script 使用（不含网络/凭据访问）
  args?: string[];
}

interface ResourceLimits {
  maxBytes?: number;               // 输出字节上限（默认 1MB）
  timeoutMs?: number;              // 执行超时（默认 10_000ms，最大 60_000ms）
  maxFiles?: number;               // list-dir 最大条目数
}
```

## 输出 Schema

```typescript
interface ExecResult {
  ok: true;
  execType: string;
  outputSha256: string;            // 输出内容 SHA256
  output: string;                  // 文本输出（截断至 maxBytes）
  truncated: boolean;
  durationMs: number;
} | {
  ok: false;
  code: ErrorCode;
  detail?: string;
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `EXEC_TYPE_NOT_ALLOWED` | execType 不在允许列表中 |
| `PATH_TRAVERSAL` | 路径含 `..` 或逃出 allowedPaths |
| `SYMLINK_REJECTED` | 输出路径是软链或硬链 |
| `APPROVAL_REQUIRED` | run-script 缺 approvalToken |
| `APPROVAL_PAYLOAD_MISMATCH` | approvalToken.operationPayloadHash 与实际不符 |
| `RESOURCE_EXCEEDED` | 输出超 maxBytes 或超时 |
| `NETWORK_ACCESS_REJECTED` | 脚本试图访问网络（静态检测） |
| `CREDENTIAL_ACCESS_REJECTED` | 脚本含凭据访问模式 |
| `NO_ISOLATION_BACKEND` | 无可用隔离后端，fail-closed（不退回裸宿主执行）|
| `RUN_CANCELLED` | Run 取消，进程树清理 |

## 约束

1. **固定 execType 枚举**：不接受任意字符串，防止枚举注入
2. **路径白名单**：read-file/list-dir 仅限配置的 allowedPaths，禁止 `..` 穿越
3. **审批绑定精确操作**：approvalToken.operationPayloadHash 必须与执行参数 SHA256 完全一致
4. **输出非链接**：禁止软链/硬链输出路径
5. **无后端 fail-closed**：若无隔离沙箱可用，直接返回 NO_ISOLATION_BACKEND，不退回裸宿主执行
6. **取消清理进程树**：AbortSignal 触发时立即 kill 子进程树

## BLOCKED 项目

- `BLOCKED_REAL_SANDBOX`: 真实 seccomp/namespace/Docker 隔离后端需 Linux 内核支持，macOS 环境 INTEGRATION_PENDING
- `BLOCKED_PROCESS_TREE_KILL`: 完整进程树 kill（pgid）在 macOS 可部分支持，Linux 完整支持

## 与 QUESTIONS 的组合接缝

```javascript
// questions-20261103 CONTRACT 引用（不编辑对方文件）
// 1. QUESTIONS 包发出审批问题，获得用户同意
// 2. 将 questionId + operationPayloadHash 构造 ApprovalToken
// 3. 传入 isolation-20261103 的 ControlledExec
const token = { questionId, operationType: 'run-script', operationPayloadHash: sha256(script) };
const result = await controlledExec({ runId, tenantId, execType: 'run-script', input: { script }, approvalToken: token });
```
