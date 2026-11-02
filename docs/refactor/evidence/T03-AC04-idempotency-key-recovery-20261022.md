# T03/AC04 ambiguous submission recovery by idempotency key — 2026-10-22

## Change and boundary

When a chat POST has an ambiguous preheader outcome, the browser now stores only `{conversationId, idempotencyKey}` in `sessionStorage`, never prompt or attachment content. It keeps that conversation locked and uses authenticated GET `/api/runs/by-idempotency-key` to find the already-admitted Run; after a matching conversation ID is confirmed, it resumes through the existing Run event GET. It does not create a new POST during recovery. The lookup is owner/tenant-scoped and returns 404 without disclosing another owner's Run. If the user switches conversations before headers arrive, the old conversation remains locked and recovery still starts; mismatched conversation IDs remain unresolved.

This provides a local recovery path for the same submission. It does not prove browser restart across devices, multi-instance/host restart behavior, provider deduplication after an unknown admission, or paid-call behavior on the target host. Candidate-24 remains immutable; candidate-25 is the first package containing this change.

## Verification

- `node tests/regression/ui-conversation-isolation-test.mjs`: **43/43 PASS**. Its reset helper now clears per-case sessionStorage, active handles, and pending recovery state so a previous intentionally locked unknown request cannot contaminate the next isolated case.
- `node --test tests/regression/ui-run-resume-review-test.mjs`: **24/24 PASS**, including page reload lookup with GET only, retry after 404 and mismatched `conversationId`, no recovery POST, and same-Run event replay.
- `node --test tests/regression/t16-candidate19-ustar-release-test.mjs`: **8/8 PASS**, verifying immutable candidate-24 file hashes plus candidate-25 checksum, USTAR members, migration count, forbidden/AppleDouble paths, overlay bytes, and runbook bindings.
- `node --test tests/regression/task-store-test.mjs`: included in a combined run with T03 HTTP and UI/package tests; store ownership/recovery checks passed. The same combined run hit sandbox `listen EPERM` in the loopback HTTP test; the authorized local loopback rerun `node --test tests/regression/t03-chat-http-same-key-disconnect-replay-test.mjs` then passed **1/1**.
- `node --check` for `app.js`, `server.cjs`, and `store.cjs`, Python package script compilation, and `git diff --check`: **PASS**.
- After the controlled-trial retry harness and UI recovery timer fixtures were corrected, `node scripts/run-regression.mjs` completed **131/131 suites PASS** under the authorized local loopback environment.

## Frozen candidate

`candidate-25` is based on the immutable `candidate-24` archive and overlays exactly `shell/public/app.js`, `shell/server.cjs`, and `shell/tasks/store.cjs`. Archive SHA-256: `0c6cd34d6bba56c6434768653c0285a10e500caab5a0ddb16b9515cd82a239ad`; systemd unit SHA-256: `56e469177320a6a87d7be0e2c647305493ed1b20d80f11df257696dea6b94e52`. It contains 323 USTAR members and 20 SQL migrations, with no AppleDouble or forbidden paths, confirmed by the candidate regression. The numbered maintainer runbook is [`candidate-25`](../北极星受控试运行部署命令清单-20261022-candidate-25.md). The package is not deployed; no real model or media request was made.

## Relation to reported media truncation and DSH failure

This recovery change prevents a new chat Run POST while admission status for an earlier request remains ambiguous; it does not change image tool request IDs or infer PT billing. The screenshot's two partial “很抱歉，当前” replies remain separate from the `hello` DSH failure until target logs establish a shared path. For the three image attempts, T03/T11 acceptance still requires the Run/operation/request/task IDs, POST/poll times, terminal events and matching PT-side usage/billing records. For the `hello` event, child stdout/stderr, child exit/signal and Run terminal event are still required to identify whether DSH closed without a `done` frame or the runner emitted a classified failure.
