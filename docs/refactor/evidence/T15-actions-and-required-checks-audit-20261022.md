# T15 Actions and required-check evidence audit — 2026-10-22

## Local verification

Command: `node tests/regression/regression-plan-test.mjs` — PASS. The assertion script verifies the three fixed PostgreSQL suites, exclusion from default mode, inclusion of itself in default mode, unique plans, exclusion of `mock-dsh-runner.mjs` in both modes, duplicate-input suppression, rejection of unknown mode, and failure on a missing required PostgreSQL suite (11 assertions). `git diff --check -- tests/regression/regression-plan-test.mjs docs/refactor/evidence/T15-postgres-runner-review-20261022.md` — PASS.

The current working-tree `.github/workflows/ci.yml` defines `postgres-regression`, Node 20/22, PostgreSQL 16 service, readiness probe, job-scoped synthetic DSN, and `node scripts/run-regression.mjs --postgres`. This proves the local workflow text only; these changes are uncommitted and no matching hosted run exists for local HEAD `b09b1e13720cd16cd7538999d4c63386920b367c` in the Actions lookup.

## Hosted Actions and repository settings

Read-only GitHub Actions API inspection returned 95 historical runs, newest created 2026-10-16. The newest run, [run 38838415681](https://github.com/tjj1234/pt-test/actions/runs/38838415681), used commit `a2adbee64c326653dbf5bfed3f918dd09f96589d`, concluded failure, and predates the current split PostgreSQL job. Its job list had migration smoke and Node 20/22 syntax checks pass, Node 20 regression fail, and Node 22 regression cancelled; no `postgres-regression` job was present. A second read-only lookup confirmed `main` still points to `a2adbee64c326653dbf5bfed3f918dd09f96589`; the workflow-runs endpoint returned no newer runs and the lookup for local HEAD returned no PR-triggered runs.

A direct read-only GitHub branch object returned `protected=false` and `protection.enabled=false`, with required status checks `enforcement_level=off` and empty `contexts/checks`. The dedicated protection endpoint still returned HTTP 403 `Resource not accessible by integration`; the branch object nevertheless shows the current public branch is not protected and no checks are required. The readable repository rulesets endpoint returned an empty list.

## Conclusion / remaining gap

The plan unit test passes locally; hosted execution of the new PostgreSQL job remains unverified. Required-check enforcement is contradicted by current GitHub branch metadata (`main` is unprotected and required checks are off/empty). This workspace has no authorization to push or change repository settings. After user-authorized publication of the reviewed candidate, an administrator must enable protection and require the expected Node 20/22 jobs, then hosted CI must pass. This evidence does not upgrade T15 or acceptance status.

