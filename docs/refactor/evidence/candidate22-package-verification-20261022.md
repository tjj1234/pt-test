# candidate-22 包验证（2026-10-22）

candidate-22 基于冻结的 candidate-21 内容，仅将最新 `shell/auth.cjs` 纳入归档；该改动确保 `auth.initAuth` 的 migration 或 default-admin 初始化失败时关闭自有数据库句柄，并保留原始错误。候选还承接 runner 预算计数修复、PT 确认的 `supported_endpoint_types` 能力映射，以及 T12 记忆修改/删除时取消已活动 Run、保留 queued Run 的规则。

| 文件 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-22.tar.gz` | `0921e28b73727dec8ba9503d0bb1bd035c0e43e904df16f60f68acfa694be0f3` |
| `release-artifacts/northstar-shell-candidate-22.service` | `5e22ae8e8f0b98f032373c49362bcafcacc37c20fdf3a8686cc1cf2a06490862` |

`node --test tests/regression/t16-candidate19-ustar-release-test.mjs tests/regression/storage-init-cleanup-test.mjs tests/regression/storage-upgrade-test.mjs tests/regression/memory-change-cancels-active-runs-test.mjs` passed **11/11**. Candidate assertions bind both checksums, 322 safe USTAR members, 20 SQL migrations, no AppleDouble paths, and package source bytes. `git diff --check` passed. Archive checksums were independently recomputed with `sha256sum` and match.

The package is a maintainer-executed test-environment candidate, not a deployment or model-call result. Target Linux install/profile/health, live permission and router eligibility, and the approved 1-request/0-retry/0-tool/180-second real text Run remain pending maintainer execution and sanitized output. No T/AC aggregate status is changed.
