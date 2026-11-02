# T15 CI 门禁与验收覆盖静态审计（2026-10-20）

**结论：T15 继续 blocked。** 仓库存在 Node 20/22 语法、回归、attribution 子包回归 workflow，以及迁移文件非空检查；这证明 CI 配置已接线，不证明最近一次 GitHub Actions 成功、分支保护要求这些 checks，或 T15 综合验收完成。本记录为静态检查，未运行这些测试、未查询 GitHub 设置或执行浏览器/性能场景。

## 当前仓库内的门禁

| 入口 | 可由源码确认的行为 | 证据与边界 |
|---|---|---|
| `.github/workflows/ci.yml` | `push` 和 `pull_request` 指向 `main`；语法检查和回归 job 使用 `ubuntu-latest`、Node 20/22；回归 job 在 `shell/` 执行 `npm ci`，再运行 `node scripts/run-regression.mjs`。 | workflow 第3–7、10–25、47–70行。不能据 YAML 推断 GitHub branch protection 已将 job 设为 required，也没有本次 CI run 结果。 |
| 语法检查 | `scripts/ci-check.mjs` 遍历仓库内 `.js/.cjs/.mjs` 并调用 `node --check`；跳过点目录、`node_modules`、若干运行时目录及 `_pg-test`，测试目录也排除。 | 脚本第4–5、20–32、43–55行。语法通过不执行代码或测试断言。 |
| 回归 runner | `scripts/run-regression.mjs` 只枚举 `tests/regression/` 的直接子项 `.mjs`，跳过 `mock-dsh-runner.mjs`，排序串行运行，每个子进程 120 秒超时，任一非零状态令 runner 失败。 | 第21–24、26–41、44–80、83–106行。目录外的测试、子目录和其他包脚本不会自动纳入。 |
| 迁移 smoke | workflow 检查四个指定 SQL 文件存在且非空。 | workflow 第27–45行；不启动数据库、不解析或执行迁移，也不验证迁移序列/升级/回滚。 |
| attribution 子包回归（新增） | `attribution-regression` 使用 Node 20/22；依次对 `analytics`、`shell`、`business/attribution` 执行 `npm ci`，逐文件运行 `tests/attribution/*.test.js`、quality、skills tracking audit 和 GA connector 测试。单文件在独立 Node 进程执行，失败即停止并使 job 失败。 | workflow 第72–123行。只完成静态路径/lockfile存在核对；本次没有运行这些测试或 GitHub Actions。 |

## 未接入的验收面

新增 job 将 attribution、quality、skills tracking audit、GA connector 的指定测试文件接入 CI，并安装三个锁定包的依赖；它不调用 attribution package 的 `test:a0`–`test:a7` scripts。`analytics/package.json` 当前只有 `start`，没有测试 script；本 job 安装其依赖以支持组合测试环境，不等于 analytics 独立测试已接入。当前 workflow 仍没有浏览器/移动端 job、AC01–AC24 场景矩阵编排、性能基线/分位数报告、付费上游分层验收或独立验收者产出的 gate。

T15 原始验收要求 AC 矩阵有证据、干净安装/旧数据升级/重启/回滚、首字/排队/解析/外部生成/渲染的 P50/P95 或充分原始分布、双对话并发与至少双用户隔离、目标桌面浏览器和基础移动可用，并由独立验收者给最终结论（`docs/北极星一期生产级重构完整任务包-v2.0.md:340-346`）。当前矩阵仍将 T15 标为 blocked，AC17/18/24 也为 blocked（`docs/refactor/ACCEPTANCE-STATUS-20261018.md:64,91-98`）。既有局部回归和受控 HTTP 证据不能填平这些整体验收缺口。

## 当前补强与剩余边界

最小增强已接线，待 CI 实跑：Node 20/22 下逐文件运行指定 attribution/quality/skills/GA 回归，并安装 `analytics`、`shell`、`business/attribution` 三个锁定依赖。静态路径核对通过，未运行这些测试、未取得 Actions 结果，也未核验分支保护 required-check 设置。该 job 只把指定子包回归纳入 workflow，不证明 analytics 独立行为、未列出的 attribution scripts、完整 AC、真实浏览器/移动端、性能、目标环境或整包独立验收。T15 维持 blocked，AC 状态不变。
