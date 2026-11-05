# GEMINI-ISOLATION-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/isolation-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**30/30 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | read-file 正常读取 | read-file 成功 | ✔ PASS |
| 2 | read-file 正常读取 | output 正确 | ✔ PASS |
| 3 | read-file 正常读取 | outputSha256 匹配 | ✔ PASS |
| 4 | read-file 正常读取 | truncated=false | ✔ PASS |
| 5 | read-file 路径穿越防护 | 相对路径 .. 被 PATH_TRAVERSAL 拦截 | ✔ PASS |
| 6 | read-file 路径穿越防护 | 不在 allowedPaths 内被 PATH_TRAVERSAL 拦截 | ✔ PASS |
| 7 | read-file 软链接拦截 | 软链接访问被 SYMLINK_REJECTED 拒绝 | ✔ PASS |
| 8 | read-file 资源上限截断 | 超限时返回 ok=true | ✔ PASS |
| 9 | read-file 资源上限截断 | truncated=true | ✔ PASS |
| 10 | read-file 资源上限截断 | 输出精确截断至 500 字节 | ✔ PASS |
| 11 | list-dir 目录列出 | list-dir 成功 | ✔ PASS |
| 12 | list-dir 目录列出 | 输出为 JSON 数组 | ✔ PASS |
| 13 | list-dir 目录列出 | 包含 hello.txt | ✔ PASS |
| 14 | list-dir 目录列出 | 已自动过滤符号链接 | ✔ PASS |
| 15 | run-script 审批缺省 | 缺审批 token 返回 APPROVAL_REQUIRED | ✔ PASS |
| 16 | run-script 审批篡改 | 参数 Hash 不匹配返回 APPROVAL_PAYLOAD_MISMATCH | ✔ PASS |
| 17 | run-script 静态网络阻断 | 网络调用特征被 NETWORK_ACCESS_REJECTED 阻断 | ✔ PASS |
| 18 | run-script 凭据防泄露 | 凭据特征被 CREDENTIAL_ACCESS_REJECTED 阻断 | ✔ PASS |
| 19 | run-script 后端可用性 | 无沙箱后端时 fail-closed 返回 NO_ISOLATION_BACKEND | ✔ PASS |
| 20 | run-script 正常受控执行 | 脚本正常执行 ok=true | ✔ PASS |
| 21 | run-script 正常受控执行 | 脚本输出计算结果正确 | ✔ PASS |
| 22 | run-script 正常受控执行 | 输出 outputSha256 正确 | ✔ PASS |
| 23 | run-script 超时中断 | 无限循环超时触发 RESOURCE_EXCEEDED | ✔ PASS |
| 24 | run-script 运行取消 | 中途中止返回 RUN_CANCELLED | ✔ PASS |
| 25 | 非法 execType 防御 | 未知 execType 返回 EXEC_TYPE_NOT_ALLOWED | ✔ PASS |
| 26 | QUESTIONS 联动闭环 | 获取到 pending 提问 | ✔ PASS |
| 27 | QUESTIONS 联动闭环 | 审批提交成功 | ✔ PASS |
| 28 | QUESTIONS 联动闭环 | 提问已确认答复 | ✔ PASS |
| 29 | QUESTIONS 联动闭环 | 审批联动执行成功 | ✔ PASS |
| 30 | QUESTIONS 联动闭环 | 执行输出与预期一致 | ✔ PASS |

## 实现说明

- **受限执行原语与固定枚举**：严格支持 `read-file`、`list-dir`、`run-script`，任何未授权类型直接返回 `EXEC_TYPE_NOT_ALLOWED`
- **文件路径安全边界**：强制验证 `allowedPaths` 目录白名单，杜绝 `..` 相对穿越，禁止符号链接解析（`SYMLINK_REJECTED`）
- **精确审批绑定**：`run-script` 必须挂载与当前脚本 SHA256 完全吻合的 `ApprovalToken`，拒绝提权和参数篡改
- **静态安全拦截**：静态检测脚本代码，拦截包含网络请求特征（`curl`, `fetch`, `http` 等）以及凭据/环境变量探测特征（`process.env`, `API_KEY` 等）
- **Fail-Closed 隔离策略**：无沙箱隔离后端时直接报错 `NO_ISOLATION_BACKEND`，不退回裸宿主降级执行
- **资源与生命周期控制**：精确限制输出字节大小、执行超时，并在收到 AbortSignal 时立即销毁子进程并返回 `RUN_CANCELLED`
- **跨包集成实证**：真正联动 `questions-20261103` 完成从用户审批到生成 Token 并注入受控执行的端到端闭环

## 文件 SHA256

```
1338a83b5c314333cda47af2aaacdabb96de4527e40ca82da046366568f41470  shell/candidates/isolation-20261103/CONTRACT.md
37c9622bdefb2a0bb56eb6b9120e7f7732b993b483b1bc3f018b029e112f77ef  shell/candidates/isolation-20261103/index.cjs
d50e58c0b738a9cc3b54cf960a0d3df791c709d84b71a002f8487331d786a54d  tests/probes/isolation-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_REAL_SANDBOX`: 生产环境下 Linux 真实 seccomp/cgroups 隔离后端待 Linux 节点生产部署验证。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (30/30 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载到安全执行环节。
