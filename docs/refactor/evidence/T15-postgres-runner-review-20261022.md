# T15 PostgreSQL runner and plan review — 2026-10-22

## Decision and local execution

The regression plan has an explicit three-suite PostgreSQL group and rejects missing suites/unknown modes; CI separates it into a Node 20/22 job backed by a job-scoped PostgreSQL 16 service. The plan test now also asserts unique execution, helper-process exclusion in both modes, and duplicate-input suppression. `node tests/regression/regression-plan-test.mjs` passed.

I attempted the real local suites without a DSN using `env -u PT_PG_DSN node scripts/run-regression.mjs --postgres`. The runner discovered exactly three suites and reported 0 passed/3 failed; each suite failed immediately and explicitly because an isolated disposable database was not configured. This is a fail-closed environment result, not a PostgreSQL product regression and not a PostgreSQL pass. Docker probe `docker info --format '{{.ServerVersion}}'` failed because the Docker daemon socket is unavailable; `psql`, `pg_isready`, `postgres`, and `pg_ctl` were not installed/on PATH. No database service or network dependency was started or downloaded.

## Runner/CI semantics inspected

- `scripts/regression-plan.mjs` deduplicates `.mjs` entries, excludes `mock-dsh-runner.mjs`, runs the fixed PG group only in `postgres` mode, and fails when any required PG suite is absent.
- `scripts/run-regression.mjs --postgres` runs every planned suite as an individual child process; any nonzero status produces a nonzero runner result. Local output confirmed all three suites execute and their DSN preconditions fail distinctly.
- The three suites exercise real separate pools / HTTP processes. The lease and task-store suites reject inherited `PT_PG_*` variables other than the DSN; SSE creates child servers with an explicit environment allowlist.
- `.github/workflows/ci.yml` scopes a PostgreSQL 16 service and synthetic DSN to `postgres-regression`, with Node 20/22 matrix. The workflow source itself is not evidence of a hosted run.

## Remaining evidence boundary

No PostgreSQL suite passed against a database locally. Hosted Node 20 and 22 Actions results, service readiness, required-check/branch protection configuration, and broader T15 evidence (full acceptance matrix, real upgrade/restart/rollback, concurrency/tenant scenarios beyond these suites, desktop/mobile, performance distribution and independent acceptance) remain unverified. No overall T15/AC status is changed by this slice.

