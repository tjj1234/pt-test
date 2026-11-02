# T11 run-budget usage event limits (2026-10-22)

## Finding

`persistent-runner.mjs` produces a sanitized Run budget summary with the configured caps (`safeBudgetSummary`, lines 17–37). The durable chat event projection in `server.cjs` previously retained only `maxDurationMs`, `maxToolCalls`, and `maxToolCallsPerKey`, and filtered out zero values (`persistBudgetUsage`, previously lines 866–889). This omitted `maxModelCalls`, `maxRetries`, and `maxOutputTokens`; for a supported `maxRetries: 0` or `maxToolCalls: 0`, it also erased the explicit prohibition. The limits govern execution, but the persisted `run_budget` event did not accurately describe them, weakening T11/AC22 field-to-source and audit evidence.

## Change

Added `shell/tasks/run-budget-event.cjs` as a pure allowlisted projection and wired `server.cjs` `persistBudgetUsage` to it. The projection preserves all six supported integer limits (`maxDurationMs`, `maxModelCalls`, `maxToolCalls`, `maxToolCallsPerKey`, `maxRetries`, `maxOutputTokens`), including valid zero caps, and omits malformed/unknown fields. It retains `costStatus` as a status only and excludes `spent`, `reserved`, cost estimates, and actual-cost amounts; this does not invent or imply a real bill.

Added `tests/regression/run-budget-event-test.mjs` to verify the zero caps, full supported limit set, malformed/unknown field rejection, and absence of cost amount fields.

## Verification

- `node --test tests/regression/run-budget-event-test.mjs` — targeted projection regression.
- `node --check shell/server.cjs` and `node --check shell/tasks/run-budget-event.cjs` — syntax validation.
- This is a local event-projection test, not a live DSH/provider/HTTP accounting test. Existing working-tree changes in `server.cjs` were preserved; only the budget event import and projection call were added here.

## Boundary and next dependency

No real tool/provider/model call or external system was used. The stored limits report policy configuration, not actual provider attempts, actual fees, or UI visibility. AC13 still lacks production cost evidence and end-to-end failure/retry/cancel accounting; AC22 still lacks field-to-real-source mapping, permissions, complete UI and browser/mobile checks. T05/AC16 security remains blocked by the reviewed child process exposure of the user's BYOK key and missing OS/network isolation; removing that key from the child would break the current provider path and needs a host-side model gateway plus target OS boundary validation. AC12 remains untested for multi-report persistence and evidence display. This change does not modify task status or the acceptance matrix. Any later deployment candidate must be rebuilt and rehashed to include the current server change; the existing candidate-07 artifact was not modified or revalidated here.
