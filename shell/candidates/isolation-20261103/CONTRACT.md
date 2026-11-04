# CONTRACT: 受控执行与审批绑定 (isolation-20261103)
修订版本：`2026-11-04-revision-1`（基于主审 QUESTIONS-ISOLATION-MAIN-REVIEW 闭合 I-PARENT-LINK / I-HARDLINK / I-FORGED-APPROVAL / I-SCRIPT-ROOT）
基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`

## 输入 Schema

```typescript
interface ControlledExecInput {
  runId: string;
  tenantId: string;
  execType: 'read-file' | 'list-dir' | 'run-script';
  input: ControlledInput;
  approvalToken?: ApprovalToken;
  resourceLimits?: ResourceLimits;
  signal?: AbortSignal;
}

interface ControlledInput {
  path?: string;
  script?: string;
  args?: string[];
}
```

## 核心安全门禁 (I- 规则)

1. **I-PARENT-LINK（逐级符号链接防御）**：不仅检查叶子节点，强制解析真实物理路径 `fs.realpathSync` 并自上而下逐级校验每个目录段。若包含符号链接或真实路径逃离 `allowedPaths`，立即阻断并返回 `SYMLINK_REJECTED` 或 `PATH_TRAVERSAL`。
2. **I-HARDLINK（硬链接文件防御）**：常规文件必须满足 `stat.nlink <= 1`，检测到多重硬链接跨目录越界时，立即返回 `HARDLINK_REJECTED`。
3. **I-FORGED-APPROVAL（权威审批核查）**：自造哈希 Token 不得执行。必须经由外部权威验证器（`approvalVerifier`）核实该 Token 确实由 `questions-20261103` 签发、未过期、未被撤销且处于未消费状态，执行前执行原子一次性核销。
4. **I-SCRIPT-ROOT（默认 Fail-Closed）**：`hasIsolationBackend` 必须默认为 `false`。未提供经过审计的原生/OS 隔离沙箱后端时，严禁使用裸宿主直接运行不受信脚本，直接返回 `NO_ISOLATION_BACKEND`。
