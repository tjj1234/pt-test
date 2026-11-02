# T07 manual router mismatch errors — 2026-10-22

## Change

Manual model rejection now returns a stable `MODEL_NOT_EXECUTABLE` code, bounded `reasonCodes`, and a user-readable message for the exact mismatch (availability, permission, local policy, textChat capability, adapter, runtime, or text modality). When a selected model loses permission before execution, the durable Run terminal payload preserves the reason code through the SSE completion event. AUTO continues to return `NO_ELIGIBLE_MODEL`; this change does not make unverified models AUTO-eligible. No model ID, credential, or provider response is added to the reason payload.

## Verification

`node --test tests/regression/conversation-model-preference-http-test.mjs` — **1/1 PASS**. The HTTP/PGlite fixture verifies that an unsupported textChat model selection returns `TASK_UNSUPPORTED`; after a previously selected model loses permission, execution ends with `MODEL_NOT_EXECUTABLE` and `PERMISSION_UNKNOWN_OR_DENIED`. The fake catalog and run fixture ensure the DSH/provider path is not invoked for this rejection.

The test initially caught a missing propagation layer: the server generated `reasonCodes` but durable completion sanitization removed the array. `shell/tasks/execution.cjs` now persists at most eight unique bounded codes; the legacy chat and run SSE framers forward the field.

## Boundary and next step

This is local HTTP/PGlite evidence for manual textChat mismatch handling. It does not verify a live PT key, target server, runtime adapter, or real model response. T07 remains partial and AC05/AC07 remain untested. The change is included in candidate-08; candidate-07 is obsolete. The maintainer must still deploy, return `/api/models` eligibility for a specific current-key model, and perform the already authorized one-request/zero-retry/zero-tool/180-second trial.
