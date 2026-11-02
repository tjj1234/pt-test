# candidate-18 budget summary release evidence

日期：2026-10-22。candidate-18 从已审查的 candidate-17 USTAR 快照重封，仅替换 `shell/persistent-runner.mjs` 为当前 runner；非法、负数或超安全整数的预算用量保留为 `null`，有效的零值保留为 `0`。这避免把未知计量误报为零。

| 产物 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-18.tar.gz` | `eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37` |
| `release-artifacts/northstar-shell-candidate-18.service` | `ed3b4de17f4c27fdf5552ed5b3fdc9730e77ba816e9437851473ee45db70cfa8` |

`tests/regression/t16-candidate18-ustar-release-test.mjs` **3/3 PASS**：绑定归档/unit checksum，逐头解析 USTAR 并校验 header checksum，检查 318 个成员、19 个 migrations、路径安全、无 AppleDouble/禁用路径，并逐字节比较归档 runner 与当前源码。`run-budget-event-test.mjs`、`run-budget-summary-test.mjs` 覆盖 unknown 传播与有效零值；本轮预算/发布/存储/CSV/profile 汇总测试 **42/42 PASS**，`node --check shell/persistent-runner.mjs` 与 `git diff --check` PASS。

部署清单为 [`北极星受控试运行部署命令清单-20261022-candidate-18.md`](../北极星受控试运行部署命令清单-20261022-candidate-18.md)。没有目标机安装、systemd 切换、线上健康检查、模型目录查询或真实模型调用。Linux candidate-17 的 T10 容器回归不等同于 candidate-18 目标机验收；T00–T18/AC01–AC24 整体验收状态不变。
