# T15 isolated PostgreSQL CI gate (2026-10-22)

## Decision

The existing regression workflow selected three suites that require a disposable PostgreSQL database, but its runner had no mode boundary and the CI job injected no `PT_PG_DSN`. The generic job therefore could fail on missing database configuration. Injecting a DSN into that job would also violate multiple disk/PGlite regression suites that explicitly require no `PT_PG_*` variables. This slice gives the three real-PostgreSQL suites their own runner mode and workflow job with an ephemeral PostgreSQL 16 service; default regression remains free of external database configuration.

## Changes

- `.github/workflows/ci.yml:50-73` now describes and invokes the default regression mode. Lines 75-110 add a Node 20/22 matrix job with a job-scoped PostgreSQL 16 service, readiness probe, synthetic disposable credentials, `PT_PG_DSN`, and `node scripts/run-regression.mjs --postgres`.
- `scripts/regression-plan.mjs:1-28` defines the explicit three-suite PostgreSQL group and rejects unknown modes or missing expected PG suites.
- `scripts/run-regression.mjs:27-37,79-87` selects the default or PostgreSQL group. The existing per-suite child process behavior is unchanged.
- `tests/regression/regression-plan-test.mjs:1-18` verifies group membership, default exclusion, invalid mode handling, and failure when a required PG suite is absent. The test is itself part of default regression.

The PG group is `run-sse-multi-instance-postgres-test.mjs`, `task-lease-postgres-review-test.mjs`, and `task-store-postgres-integration-test.mjs`. The prior local evidence recorded their missing-DSN failures and the need to separate external PG configuration from tests that reject it (`T15-local-ci-execution-20261022.md:18-24,32-35`).

## Verification performed

- `node tests/regression/regression-plan-test.mjs` — PASS.
- `node --check` on the runner, plan helper, and plan test — PASS.
- Ruby Psych parse of `.github/workflows/ci.yml` — PASS; workflow fragment assertions for read-only permissions, PostgreSQL service, DSN, and PG runner command — PASS.
- `git diff --check` scoped to the changed workflow/runner/plan/test — PASS.
- `actionlint` and `yamllint` were not installed in this environment.

## Evidence boundary and remaining work

No PostgreSQL suites were executed locally, no service was started, and no GitHub Actions run was triggered. YAML parsing and fragment checks do not validate the GitHub Actions schema or prove the service image starts on hosted runners. T15 remains blocked: verify this job on hosted Node 20/22, then complete the broader acceptance evidence for database upgrade/restart/rollback, concurrency and tenant isolation, browser/mobile, performance distribution, clean dependency install, required checks/branch protection, and independent acceptance. This file records a workflow and runner configuration change only; it does not change the overall T15 or AC status.
