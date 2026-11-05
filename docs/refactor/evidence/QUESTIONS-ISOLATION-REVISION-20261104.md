# 05提问审批与06受控执行局部修正报告 (8项缺陷闭环)
2026-11-04｜结论：**REVISION_DELIVERED / READY_FOR_RE_REVIEW**。
根据主审报告 [`QUESTIONS-ISOLATION-MAIN-REVIEW-20261104.md`](QUESTIONS-ISOLATION-MAIN-REVIEW-20261104.md) 的 8 项反例与安全门禁要求，已在独立隔离修复分支 `fix/questions-isolation-20261104` 完成对 05 与 06 的精确修正、契约澄清与测试预期纠正。当前共享工作区被冻结待审的原文件未直接覆盖，原任务包正文未重写。

---

## 1. 独立修复分支与补丁信息

| 项目 | 记录 |
|---|---|
| 独立修复分支 | `fix/questions-isolation-20261104` |
| 基础提交 (Base) | `bbd9997` (与主线交接点完全一致) |
| 修复提交 (Tip) | `fb250a9` (`fix(questions,isolation): resolve 8 review security defects in isolated branch`) |
| 独立补丁文件 | [`docs/refactor/evidence/QUESTIONS-ISOLATION-REVISION-20261104.patch`](QUESTIONS-ISOLATION-REVISION-20261104.patch) |
| 机器执行结果 | [`docs/refactor/evidence/QUESTIONS-ISOLATION-REVISION-20261104.json`](QUESTIONS-ISOLATION-REVISION-20261104.json) |

### 修复分支文件 SHA256

```
3647d7e8626c035a6b1711d1414ce638e0b3ac99be688f77077509b5e8bdf329  shell/candidates/questions-20261103/CONTRACT.md
23550fa7c6aee56d9f5b4861ba680be883f1d100a1fe373f4f3d1a9f05598323  shell/candidates/questions-20261103/index.cjs
e9e0eb79530e0ffd466929eed9b00898bc02e6ee95e774c2341f401f67975814  shell/candidates/isolation-20261103/CONTRACT.md
a2b6e8a4788fb8007a8d5463be2c7f26c1c5b3497a9ca648f0d5dcaa4601d011  shell/candidates/isolation-20261103/index.cjs
13c6e6ecb02f1085b6c868e556877881e6d79c92a79d4c9192d3d718f626d2d0  tests/probes/questions-delivery-20261103.mjs
d50e58c0b738a9cc3b54cf960a0d3df791c709d84b71a002f8487331d786a54d  tests/probes/isolation-delivery-20261103.mjs
3758a9c6a8219cde8d9450e1513dd8ba8a9321675b797bb8daf1d46cda9b1dba  tests/probes/questions-isolation-main-review-20261104.mjs
```

---

## 2. 逐项回应与修复细节 (Q- 4项 + I- 4项)

### 包05：提问与审批交互

| 审核项 | 缺陷表现与主审要求 | 修复落地措施 | 独立探针复测验证 |
|---|---|---|---|
| **Q-OPTIONS** | 审批选项可缺失且接受任意答案；需验证明确批准/拒绝语义 | approval 强制初始化为标准批准/拒绝语义选项（默认 `['YES', 'NO', 'yes', 'no']`）；回答不在 options 中一律返回 `INVALID_ANSWER`，杜绝任意字符串默认同意 | **Q-OPTIONS PASS** |
| **Q-ID-CONFLICT** | 同 questionId 换成不同问题/目标仍返回原 Promise | 记录提问参数指纹（`computeQuestionSignature`）。同 ID 同参幂等返回原 Promise，同 ID 异参立即拒绝并返回 `ID_CONFLICT`，严禁复用旧批准 | **Q-ID-CONFLICT PASS** |
| **Q-DEADLINE** | 超时后若 timer 尚未触发仍接受答案 | 记录绝对时间戳 `deadline = createdAt + timeoutMs`。在 `submitAnswer` 时前置强校验 `Date.now() >= deadline`，超时立即 reject 并返回 `QUESTION_TIMEOUT` | **Q-DEADLINE PASS** |
| **Q-OPTIONS-MUTATION** | 创建后修改原 options 数组可接受用户未看到的答案 | 内部对 options 数组和 approvalTarget 执行深度克隆与不可变冻结（`Object.freeze`），调用方外部修改无法渗透 | **Q-OPTIONS-MUTATION PASS** |

### 包06：受控执行与沙箱

| 审核项 | 缺陷表现与主审要求 | 修复落地措施 | 独立探针复测验证 |
|---|---|---|---|
| **I-PARENT-LINK** | 只 lstat 叶子；allowed/jump 符号链接指向外目录可逃逸 | 强制解析真实物理路径 `fs.realpathSync`，且自上而下逐段 lstat 校验路径链；任何一级包含符号链接或真实路径超出授权根，立即拦截并返回 `SYMLINK_REJECTED` | **I-PARENT-LINK PASS** |
| **I-HARDLINK** | 授权目录内硬链接可读取外部文件 | 读取前检查常规文件硬链接计数：`stat.isFile() && stat.nlink > 1` 时立即拦截，返回 `HARDLINK_REJECTED` | **I-HARDLINK PASS** |
| **I-FORGED-APPROVAL** | 客户端自造 hash token 即可执行，未核验签发状态 | 接入权威审批验证通道 `approvalVerifier`，并支持原子性一次核销（`verifyAndConsumeApproval`）；自造未签发或已消费的 token 严格返回 `APPROVAL_REQUIRED` | **I-FORGED-APPROVAL PASS** |
| **I-SCRIPT-ROOT** | 未配置隔离后端时默认裸宿主直接运行 | `hasIsolationBackend` 必须默认为 `false`（Fail-Closed）；未配置经过审计的隔离沙箱后端时，直接拒绝运行不受信脚本并返回 `NO_ISOLATION_BACKEND` | **I-SCRIPT-ROOT PASS** |

---

## 3. 测试与验证实证

### 独立主审探针 (`tests/probes/questions-isolation-main-review-20261104.mjs`)

```
PASS Q-OPTIONS
PASS Q-ID-CONFLICT
PASS Q-DEADLINE
PASS Q-OPTIONS-MUTATION
PASS I-PARENT-LINK
PASS I-HARDLINK
PASS I-FORGED-APPROVAL
PASS I-SCRIPT-ROOT

总计: 8 项全部 PASS，0 项 FAIL，退出码: 0
```

### 纠偏后的原交付探针全量回归

- `node tests/probes/questions-delivery-20261103.mjs`: **22/22 PASS, 0 FAIL, 退出码 0**
- `node tests/probes/isolation-delivery-20261103.mjs`: **30/30 PASS, 0 FAIL, 退出码 0**

---

## 4. 主程序复审与集成建议

1. **补丁应用**：主程序可通过 `git apply docs/refactor/evidence/QUESTIONS-ISOLATION-REVISION-20261104.patch` 或合入 `fix/questions-isolation-20261104` 审查并集成修复。
2. **两包权威闭环**：`questions-20261103` 签发带不可变摘要与时间戳的 `approvalToken`，`isolation-20261103` 通过注入的 `verifyAndConsumeApproval` 在执行前执行原子一次性核销，杜绝重放。
