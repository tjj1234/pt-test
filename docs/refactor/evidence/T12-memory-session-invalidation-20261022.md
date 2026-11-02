# T12 memory mutation and hot-session invalidation — 2026-10-22

**Scope:** local audit against Phase 1 v2.0 §T12 and AC14; no product-state file or WORKLOG changed. The source tree already had per-user memory reads, exact character-budget accounting, and an explicit zero-budget regression. This slice addressed one reproducible stale-context defect in the memory mutation path.

## Requirement and reproduced defect

T12 acceptance item ③ requires deletion or correction to stop later requests and existing hot sessions from applying the old memory; item ④ requires A's memory not to enter B's context. `shell/server.cjs` loads memory by the authenticated `userId`, but the `/api/memory` POST and DELETE handlers previously changed only `user_memory`; they left every existing DSH session for that user warm. `shell/runtime/dsh-adapter.cjs` reuses a warm session by conversation key, and `persistent-runner.mjs` keeps that agent transcript between follow-up tasks. A later task could therefore follow the old memory-bearing task in the same DSH conversation even though the database had been corrected or cleared.

Before the fix, the new HTTP regression successfully created two authenticated users and three conversations, posted user A's memory, and failed because zero `closeDshSession` calls were observed; the expected two A-owned conversation IDs were absent. This reproduces the production route omission without starting DSH or calling a model.

## Change

After a successful user-memory POST or DELETE, the server lists only that user's conversations and calls `tenantMod.closeDshSession()` for each. The current runtime removes the warm-session mapping, so a subsequent turn in that conversation starts a fresh DSH session and receives the current memory snapshot. Memory remains stored under `user_id`; no user or conversation data is copied between tenants. If any session invalidation call throws, the route returns HTTP 503 with `memorySaved` or `memoryDeleted` true and an explicit `MEMORY_CONTEXT_INVALIDATION_FAILED` code, rather than claiming the context was refreshed. The endpoint also reports the number of sessions targeted for reset.

## Verification

| Command | Result |
|---|---|
| `node --test tests/regression/memory-session-invalidation-http-test.mjs` | **1/1 PASS**. Real local HTTP + PGlite; tests POST correction and DELETE, reset all of A's conversations, leave B's conversation alone, keep A/B memory reads isolated, and report an injected close failure as 503 while truthfully indicating the DB write succeeded. |
| `node --test tests/regression/memory-zero-budget-test.mjs` | **1/1 PASS**. Explicit `maxChars: 0` includes no lines and is not replaced by the default. |
| `node tests/regression/memory-context-budget-test.mjs` | PASS. Mock paging and actual PGlite snapshot accounting, ordering, omission counts, and UTF-16 character caps. |
| `node tests/regression/tenant-mock-smoke.mjs` | **14/14 PASS**. Existing runtime-contract probe confirms a closed conversation starts cold (`fresh=true`) on its next turn. |
| `node --check shell/server.cjs`; `git diff --check` | PASS. |

The HTTP regression uses a test preload that records/fault-injects `closeDshSession`; it does not execute a live DSH child or prove the close RPC was acknowledged. The separate tenant mock verifies the runtime reset contract, but not real DSH transcript erasure.

## Remaining T12/AC14 evidence gaps

T12 remains `partial`, AC14 remains `untested`. No long-conversation real DSH test proves preservation of the current goal, constraints, pending actions, sources, and failure state; there is no UI-visible summary of memory/context budget or uncovered range; memory records still do not carry the full source/scope/invalidation metadata specified by T12; uploaded content and web pages have no end-to-end adversarial test proving they cannot create privileged memory. Target PostgreSQL, real DSH, browser, and cross-process deployment evidence are still absent.

## Later update — active Run cancellation (2026-10-22)

The paragraph in the original remaining-gaps section about in-flight Runs was accurate at the time of this audit and has since been superseded by the user's explicit decision and implementation recorded in `evidence/T12-memory-context-budget-20261021.md` / current WORKLOG and acceptance matrix: if a memory change affects content already sent upstream while its Run remains active, cancel that Run; queued Runs are retained. The cancellation helper and route wiring now implement that scope. This does not prove PT upstream cancellation, multi-instance propagation, or real DSH acknowledgement; those remain open verification gaps.
