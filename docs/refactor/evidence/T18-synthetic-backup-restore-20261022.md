# T18 synthetic PGlite backup/restore slice — 2026-10-22

## Result

Added an isolated offline prototype in `shell/runtime/data-backup.cjs`, a standalone CLI in `scripts/northstar-data-backup.cjs`, and `tests/regression/northstar-data-backup-test.mjs`. It is not wired into startup, deployment, or the production restore path. The test uses a synthetic PGlite database, synthetic session/API-key material, and synthetic uploads/artifacts/skills only.

Verification: `node --test tests/regression/northstar-data-backup-test.mjs` **7/7 PASS**; `node --check` on the helper, CLI, and test PASS; `git diff --check` PASS. The default regression after adding the slice and the T12 HTTP test completed **130 suites / 130 PASS** on Node 24 in the current dirty worktree.

Coverage includes explicit PGlite-only mode and refusal when `PT_PG_*` is configured; fixed allowlisted roots; separate master-key exclusion and rejection when its path lies inside an included root; stable regular-file reads; non-overwriting output and restore targets; manifest and per-file SHA-256 checks; rejection of corruption before target creation; and a forged archive with internally consistent SHA-256 values but a file-as-parent tree conflict, rejected during manifest validation. CLI backup requires `--offline-confirmed`, which is an operator assertion only.

## Independent review and limits

Independent static review found the tree-structure gap; the validator and regression were extended to reject missing/non-directory parents before extraction. Remaining path operations are path-name based rather than directory-fd/openat traversal. Under a concurrent actor able to replace writable source/target ancestors, TOCTOU remains possible; this prototype therefore does not establish hostile-concurrency safety. SHA-256 detects accidental corruption but is not a signature or authenticity mechanism. Restore failures after target creation preserve an incomplete marker and partial target for operator inspection; this is deliberately non-overwriting, not atomic multi-root recovery.

This is **not** production T18 acceptance: no PostgreSQL-native backup/restore, target-host test, encrypted/signed offsite copy, retention policy, migration-version contract, RPO/RTO, operator-role evidence, concurrent-writer detection, or restore drill. The `--offline-confirmed` flag does not prove writers are stopped. Do not use this prototype as a production recovery procedure.
