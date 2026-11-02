# T15 · Local attribution/quality/GA recheck (2026-10-22)

**Local suites: PASS; T15 remains blocked pending hosted workflow and enforcement evidence.** This worktree reran the 25 files enumerated by `.github/workflows/ci.yml`'s `attribution-regression` job on Node v24 with localhost binding allowed:

- `tests/attribution/*.test.js`: **19/19 files PASS** (`node --test` reported 19/19 top-level tests).
- `business/attribution/quality/quality.test.js`, `business/attribution/skills/tracking-quality-audit.test.js`, and `business/attribution/ga-connector/*.test.js`: **6/6 files**, **30/30 tests PASS**.
- `node scripts/verify-a7-scope.mjs`: PASS for the original A7 commit range and protected paths.

The former dirty-worktree `git diff HEAD` assertion was removed from the functional `wire-funnel-collect` test and moved to a separate `attribution-scope-integrity` workflow job using full history. Both the functional suite and historical-range verifier pass locally. The current worktree is still uncommitted, so this does not demonstrate hosted Actions execution. It also does not prove Node 20/22 results, required-check enforcement, branch protection, end-to-end Northstar acceptance, browser/mobile behavior, or performance/recovery targets.
