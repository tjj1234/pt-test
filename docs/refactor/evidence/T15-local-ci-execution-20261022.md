# T15 本地 CI 与回归入口执行记录（2026-10-22）

**结论：本地完整验证未通过，T15 继续 blocked。** workflow YAML 与静态矩阵审计通过；隔离 checkout 中语法入口检查 327 个 JS 文件、0 失败。第一次完整 regression runner 为 101 个套件中 88 通过、13 失败；attribution workflow 的 25 个逐文件用例为 24 通过、quality 用例在 sandbox loopback 限制下失败。随后获准在隔离副本重跑 regression runner，前 26 项均显示通过后按主 agent 要求中断（SIGINT，退出码 130），因此没有第二次完整结果。该证据不是 GitHub Actions run，也不代表 T15/AC 总验收通过。

## 执行环境与安全边界

当前分支 `feature/northstar-phase1-refactor-20261016`，HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`；原工作区有大量既有改动。为避免测试触碰原 checkout 中的 `runtime/`、model-catalog 缓存与用户改动，将 562 个已跟踪及非忽略源码/测试文件复制到独立临时 checkout，并复制 `shell`、`analytics`、`business/attribution` 三套现有 `node_modules`。复制时排除 `.git`、`runtime/`、`wb copy/`、`.playwright-cli/`、`release-artifacts/` 和 `.env`；使用空白环境，仅传 PATH、临时 HOME/TMPDIR 与 locale，不继承服务凭据。测试只在临时副本及其临时目录写入。原工作区未运行 `npm ci`，因为它会清除既有 `node_modules`；故干净依赖安装仍未验证。执行 Node 为 `v24.14.0`，不等同 workflow 的 Node 20/22 矩阵。

## 本地执行结果

| 入口 | 结果 | 解释与边界 |
|---|---|---|
| Workflow 配置审计 | PASS：Ruby Psych 解析 `.github/workflows/ci.yml`；四个 jobs 存在；syntax/regression/attribution 矩阵为 `[20,22]`；四组 glob 匹配 25 个文件，与 `expected_test_file_count=25` 一致。 | 仅本地 YAML/结构/文件计数，不是 GitHub Actions schema 或远端运行验证。 |
| `node scripts/ci-check.mjs` | PASS：327 个 JS 文件，0 个语法失败。 | 在隔离 checkout、Node 24.14.0 执行；CI Node 20/22 未覆盖。 |
| `node scripts/run-regression.mjs` | FAIL：101 个套件，88 通过、13 失败。 | 失败项及原因如下；其中本地 loopback 权限会造成 sandbox 假失败，另有真实配置/行为缺口。 |
| attribution job 的 25 个逐文件 `node --test` 命令 | 24 PASS、1 FAIL：`business/attribution/quality/quality.test.js`。 | quality 测试在 `quality.test.js:58` 绑定 `127.0.0.1` 时于 sandbox 收到 `listen EPERM`；未在提权后单独重跑该文件。 |

### Regression 失败项

| 测试 | 观察到的失败 | 分类 |
|---|---|---|
| `chat-usage-failure-accounting-test.mjs`、`conversation-model-preference-http-test.mjs`、`csv-document-http-test.mjs`、`google-login-integration-review-test.mjs`、`google-login-server-test.mjs`、`m3-workspace-enabled-status-test.mjs` | `listen EPERM: operation not permitted 127.0.0.1`。 | sandbox 禁止 loopback listener。提权重跑后前三项已显示 PASS；runner 在 Google/M3 相关项之前停止，余下三项状态未复核。 |
| `run-sse-multi-instance-postgres-test.mjs`、`task-lease-postgres-review-test.mjs`、`task-store-postgres-integration-test.mjs` | 缺少显式隔离的 `PT_PG_DSN`。 | 本地未提供 disposable PostgreSQL；Docker daemon 当前不可连接。workflow YAML 未声明 PostgreSQL service/DSN，因此标准 CI 配置是否能执行这三项尚未证明。 |
| `storage-google-policy-review-test.mjs`、`storage-upgrade-test.mjs` | PGlite 报 SQLSTATE `42703`：旧迁移 fixture 中 `conversations` 表缺少 `model_preference`；失败语句尝试向该列插入。 | 本地真实失败，需复核 legacy schema fixture 与当前 repository query/migration 的兼容性。 |
| `t04-adapter-abort-drain-test.mjs` | `T04 cancellation waits for runner drain...` 在 `tests/regression/t04-adapter-abort-drain-test.mjs:146` 断言 A 仍为 `running`，实际为 `cancelled`；该文件 4 pass、1 fail。 | 行为断言失败；本轮未做修复或再次归因。 |
| `ui-archive-readonly-test.mjs` | `tests/regression/ui-archive-readonly-test.mjs:46` 执行时 `ReferenceError: setBusy is not defined`。 | 测试/harness 与当前 UI 符号不一致或存在 UI 回归，需独立复核。 |

## 提权重跑与停止点

因 sandbox 的 loopback 失败，申请并获准在同一个隔离 checkout 运行完整 regression runner；启动后确认前三个 listener 相关用例通过。主 agent 随后要求若 101 项仍未结束则立即停止；runner 显示至少前 26 项通过后以 SIGINT 结束，退出码 130。该 partial rerun 不覆盖后续 75 项，不能据此前段 PASS 推断完整回归通过。停止后核对临时目录的精确路径前缀及 workflow、runner、日志 marker，再删除本次创建的隔离副本；摘要已保存在本文件。此次没有对原工作区运行任何测试，也未请求外部服务或使用真实凭据。

## T15 缺口与后续动作

1. 在 CI 中配置并销毁隔离 PostgreSQL service，安全注入 `PT_PG_DSN` 后验证三项 PG suites；若 workflow 不应覆盖 PG suites，则应在 runner 中明确分层，而不能让它们以缺凭据失败。
2. 复核两个 legacy PGlite fixture 的迁移路径、T04 abort-drain 行为和 UI archive 测试符号后，在独立任务中修复并重跑受影响入口。
3. 用 Node 20 和 22 分别验证；完成所有 101 regression suites、25 个 attribution 测试及干净依赖安装的完整结果。当前依赖已存在的测试不能替代 clean install。
4. 补齐 T15 原始验收：AC 场景矩阵、真实数据库升级/重启/回滚、性能分布、双对话并发与双用户隔离、桌面浏览器/移动端以及独立验收者结论。还需远端核验真实 Actions run、required checks 与 branch protection。

任务包边界见 `docs/北极星一期生产级重构完整任务包-v2.0.md:340-346`。本记录不改变 T15 `blocked` 或 AC 状态。

## 2026-10-22 candidate-16 隔离复跑补充

在新的隔离副本及空白环境中执行最新 `node scripts/run-regression.mjs`：**116 suites，111 PASS、5 FAIL**。失败均来自 independent review fixture 与当前契约不匹配，不能记作全量通过，也不构成 candidate-16 文本资格部署的产品代码失败：`google-auth-routes-review-test.mjs` 的 schema 仅应用 001/012，缺少 019 提供的 `users.disabled_at`，导致 OAuth callback fixture 失败并连带 workspace hook 超时；`google-login-integration-review-test.mjs` 与 `storage-google-policy-review-test.mjs` 在 pre-019 schema 上调用当前 auth repository 来造 legacy session；`model-capabilities-review-test.mjs` 使用当前不认可的 `supported_endpoint_types:['chat']` 和 `chat` adapter endpoint；`ui-archive-readonly-test.mjs` harness 的 `/api/models` 响应不含 `ok:true` 和 ready model，因此 UI readiness guard 阻止测试发送。candidate-16 正常启动使用完整 19 个迁移，真实 `/api/models` 契约也包含资格上下文；这些 review 失败不升级或降低 T06/T07/T02/AC 状态。

本次临时 PostgreSQL 16 门禁使用 localhost 动态端口 `63816`、tmpfs、无 host volume；沙箱内运行因 loopback 限制为 0/3，获批沙箱外重跑 `node scripts/run-regression.mjs --postgres` 后 **3/3 PASS**（SSE multi-instance、lease review、task-store PG）。仅停止并移除本次容器 `northstar-t15-pg-20261022`，核对无残留，其他既有容器未动。该结果补足本地 PG execution，不是 hosted Actions run；Node 20/22矩阵、远端 required-check/branch protection、AC端到端与其余T15验收仍未证明，T15继续 blocked。
