# T15 / AC18 本地 workflow 执行审计（2026-10-22）

**结论：** 当前工作树的 Node 24 本地执行覆盖已通过：语法检查 358 个 JS 文件、默认回归 123/123、隔离 PostgreSQL 16 的 3/3 套件、attribution workflow 声明的 25 个测试文件、A7 历史交付范围校验均通过。此结果来自未提交的脏工作树，HEAD=`b09b1e13720cd16cd7538999d4c63386920b367c`；不能称为该 Git commit 的 clean-checkout 验证，也不能代替 workflow 指定的 Node 20/22 hosted Actions。

## 当前 workflow 覆盖与本地复现

- `syntax-check`：Node 20/22 matrix 调用 `node scripts/ci-check.mjs`。本机 Node `v24.14.0` 执行 **358 个 JS 文件，0 fail**。
- `migrate-smoke`：固定检查 analytics 的 4 个 SQL 路径存在且非空；本地逐个 `stat` **PASS**。它不执行 SQL、不检查语法或迁移结果，故 job/step 已改名为“迁移文件存在性”，避免把存在性检查表述成 SQL smoke。
- `regression`：Node 20/22，先 `npm ci` 再跑默认 regression runner。本机 `node scripts/run-regression.mjs` **123/123 PASS**。此次没有重新执行 `npm ci`，未验证干净安装或包注册表下载。
- `postgres-regression`：Node 20/22 + PostgreSQL 16 service，调用 `node scripts/run-regression.mjs --postgres`。本地用一次性 `postgres:16` 容器、仅映射 localhost `127.0.0.1:54152`，**3/3 PASS**；停止并移除容器后以 `docker ps` 确认无残留。结果在 Node 24，不是 Node 20/22 hosted run。
- `attribution-scope-integrity`：`fetch-depth: 0` 后运行 `node scripts/verify-a7-scope.mjs`。本地 **PASS**，固定历史 A7 commit 父子关系及受保护路径差异，不读取当前 dirty worktree diff，因而不会被当前 Northstar shell 改动误报。
- `attribution-regression`：workflow 的 glob 实际展开为 **25 个文件**（19 个 `tests/attribution/*.test.js` + 6 个 quality/tracking/GA 文件），硬编码数量断言为 25。本地分别执行两组 workflow 命令，19 个 attribution 文件及另外 6 个文件均通过（后者 Node TAP 30/30）。先在受限沙箱合并执行时仅 quality HTTP 用例遇 `listen EPERM`；按 workflow 分组并在获准的 localhost 环境重跑后，全部通过。Node 20/22 的 clean `npm ci` 与 hosted 行为未验。

## 小修复与 dirty-worktree 检查

`.github/workflows/ci.yml` 的 `migrate-smoke` 原注释和 job name 声称 SQL “冒烟/可被提取”，实际脚本只做 `test -s`。已将 job/step 改为准确的“迁移文件存在性”并写明不执行 SQL、不验证语法。YAML 使用本机 `js-yaml` 解析成功，确认 `migrate-smoke` job 仍存在；`git diff --check -- .github/workflows/ci.yml` **PASS**。

搜索发现唯一与 Git 历史相关的 A7 校验已独立成 `attribution-scope-integrity` job；它固定检查历史交付范围，不再断言本地 `git diff --stat HEAD` 必须没有 dirty shell 文件。`a7-acceptance.test.js` 的 `scopeCheck` 明示指向 workflow job。本地 A7 verifier、A7 acceptance 子流程和 `wire-funnel-collect.test.js` 均通过。全工作区当前约 290 项 modified/untracked；本次回归结果对应这份工作树快照，非 clean commit。

## AC18 与仍缺证据

CI 中现有 `ui-chat-elapsed-format-test.mjs` 等测试只证明部分阶段提示/格式，无法提供首字、排队、解析、外部生成、渲染各自的同条件耗时样本或 P50/P95。workflow 没有目标浏览器/移动端场景和性能采集任务；这次没有真实模型、浏览器或生产环境请求。因此 **AC18 仍 blocked，T15 仍 blocked**。还缺 Node 20/22 hosted job 全绿、clean `npm ci`、hosted PostgreSQL service、当前 SHA 对应的 Actions run/required-check 执行证据、AC 场景矩阵、真实浏览器/移动与性能分布、独立验收。

## 待业务方明确

AC18 的可比性能验收需由负责人确认目标环境/浏览器与基线版本、模型/地区/网络、代表性请求和样本量，以及真实模型调用预算；未确认前不能编造 P50/P95 或把本机 UI 状态测试当作时延结果。其余本地 CI 重跑不需要新增业务决定。
