# Candidate-28 package and T06 permission binding — 2026-10-22

**Result: local candidate package verified; target deployment and the approved real text Run remain pending.** Candidate-28 is derived from immutable candidate-27 and overlays only `shell/model-catalog.cjs`. It applies the user's confirmed per-ID rule: each model ID present in the current authenticated PT `/v1/models` response gets `permission=true`; cached IDs omitted from a partial/incomplete response are not granted permission and are not tombstoned. Completeness remains a separate signal. This does not assume the response is exhaustive or auto-follow pages.

| Artifact | SHA-256 | Binding |
|---|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-28.tar.gz` | `1d50a46516ad1d3501889c3caaa814967a77e02e8b8bda9edcc1cb1f669789f4` | 323 USTAR members, 20 migrations; only `shell/model-catalog.cjs` differs from candidate-27 |
| `release-artifacts/northstar-shell-candidate-28.service` | `ccb75eeb1e36abe5602066beebe6fc206003969308d434e6f4df344b9d8b4b61` | points to candidate-28 release directory |

Verification: `node --test tests/regression/t16-candidate28-ustar-release-test.mjs` **2/2 PASS**; all 8 numbered runbook bash blocks pass `bash -n`; the actual decompressed archive reports `POSIX tar archive`; `git diff --check` passes. The package regression parses every header as USTAR, rejects extension headers, confirms migration count and absence of AppleDouble/secret/dependency/Git paths, verifies exact overlay scope, and binds both checksums into the maintainer runbook. The runbook is `docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-28.md`.

Candidate-28 supersedes earlier candidate runbooks; none has been deployed. It includes existing user-confirmed `localPolicy` and adapter wiring, trusted `supported_endpoint_types` mapping, manual router eligibility, account chat limit 35/minute, per-user Runs 4, global Runs 16, and the one-request/zero-retry/zero-tool/180-second text validation procedure. The runbook remains maintainer-executed because this environment has no target SSH access. No model call was made. Online key-specific IDs, permission/policy/eligibility fields, target health, and the one real model response remain unobserved. Strict T06/T07 and project-wide T00–T18 / AC01–AC24 acceptance states do not change.
