# T12 explicit zero memory budget boundary — 2026-10-22

**Finding and fix:** `memorySnapshot(userId, { maxChars: 0 })` previously treated zero as an invalid/absent budget and silently substituted the 4000-character default. This could inject saved memories when a caller explicitly requested no memory context. `shell/memory.cjs` now preserves an explicitly supplied numeric zero; omitted, null, negative, or non-finite budgets retain the existing default behavior. Positive finite budgets and `memoryLines()` array compatibility are unchanged.

**Verification:** `node --test tests/regression/memory-zero-budget-test.mjs` — **1/1 PASS**; `node tests/regression/memory-context-budget-test.mjs` — **focused mock + PGlite assertions passed**. The new regression verifies snapshot `maxChars`, empty `lines`, zero `includedChars`, accurate total/omitted counts, `memoryLines()` compatibility at zero, and unchanged default behavior. No model, server, UI, or external call was used.

**Boundary:** this repairs one input edge in the existing per-memory injection character budget. It does not implement total model-context budgeting, history compression, relevance retrieval, source/confirmation metadata, deletion invalidation of hot sessions, or user-visible inclusion summaries; T12 and AC14 remain incomplete.
