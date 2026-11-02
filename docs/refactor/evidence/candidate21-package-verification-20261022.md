# candidate-21 包验证（2026-10-22）

candidate-21 从 candidate-20 固定归档 `4bc1f95b3f4797764fd33212171f1b98e6130dd37f4dd1342e4512d644b6dfbc` 更新 `shell/auth.cjs`：`initAuth` 中 migration 失败会关闭 auth 所拥有的数据库句柄，close 异常不会覆盖 migration 原始错误。新的清单基于未提交工作区，仅此后续源码改动叠加于 candidate-20，包成员仍为322、SQL migration仍为20。

| 产物 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-21.tar.gz` | `81cc6cd4467c2ef34f320ca40f71e25c10e43f50ecfcda021614948988b0140a` |
| `release-artifacts/northstar-shell-candidate-21.service` | `fd1ce0025cc06c384a7ff13ec5a7c7115bf22f73e9ac025cfac559f67019ed7f` |

`tests/regression/t16-candidate19-ustar-release-test.mjs` 的 candidate-21 用例核验上述 checksums、322个 USTAR 成员、20个迁移、AppleDouble/敏感路径清零，以及包内 `auth.cjs` 与当前源码逐字节一致并带清理逻辑。candidate-19、20、21 包核验共 **4/4 PASS**。记忆Run取消、`storage-init-cleanup-test.mjs` 与 `storage-upgrade-test.mjs` 共 **5/5 PASS**；syntax 与 `git diff --check` PASS。

部署、真实 PostgreSQL 的 migration-failure/restart、目标 profile/OS 验证、模型资格读取和 1/0/0/180真实 Run 均未发生。candidate-21 仍只是维护者待执行的受控候选，不改变任何 T/AC 整体验收状态。
