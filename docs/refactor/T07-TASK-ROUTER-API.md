# T07 text router API

`require("./models/task-router.cjs").routeTextTask(input)` is a pure selector for one normalized `textChat` task. It consumes catalog capability records, an explicit availability snapshot, and an explicit selection mode; it performs no I/O, ranking by model name, fallback, or mutation.

```js
routeTextTask({
  candidates: catalogModels,
  requirements: { task: "textChat", inputModalities: ["text"], outputModalities: ["text"] },
  selection: { mode: "auto" }, // or { mode: "manual", modelId: "..." }
  availability: { status: "available", modelIds: ["..."] },
});
```

The caller supplies candidates in its chosen deterministic order. Manual selection requires `availability: "present"`, `permission: true`, `localPolicy.enabled: true`, `tasks.textChat.value === true`, `states.textChat.adapted === true`, and known text input/output modalities. A manual first call may be routed while `verified === false`; it is marked `verificationRequired: true` and remains subject to the pre-call controlled qualification gate. AUTO additionally requires `states.textChat.verified === true` and `states.textChat.autoEligible === true`. PT-confirmed `supported_endpoint_types` values can supply task and minimum I/O facts with source provenance; arbitrary endpoint strings, `supported_endpoints` aliases, IDs, and names grant no eligibility.

Manual selection examines only the requested ID and returns an error if it is missing or ineligible. It never silently selects a different model. `routeTextTask` only selects: it does not consume or certify budget. Execute through `admitTextTask(input, { budget, estimateCost })`, supplying the existing Run budget and a synchronous `estimateCost(selectedCandidate)` callback when cost-limited. It selects first, rejects unconfigured policy, then calls `budget.admit({ type: "model", estimatedCost })` exactly once for the selected candidate. Ineligible selection and invalid estimates consume no admission; missing cost evidence is rejected by the existing budget implementation. Success returns `{ ...route, admission }`; the caller must invoke `admission.settle(...)` exactly once after execution, including failure. Do not pre-admit while filtering candidates or reuse admission for another model. Admission counts attempts conservatively and does not refund failed operations. Errors return `{ ok: false, code, detail? }`; success returns requested and resolved IDs separately. This module covers text chat only and does not establish actual provider execution or upstream-reported model identity.


2026-10-19: catalog/server selection is now wired through `routeTextTask`, including manual permission, policy, modality and runtime checks. `admitTextTask` remains a separately tested helper: the active runner budget currently counts duration/tools, not model operations, so this integration does not claim model-cost admission or accounting closure. Router independent regressions 6/6; catalog lifecycle 8/8 including immediate fresh/backoff permission revocation.

Conversation preference is persisted in migration 018. `GET /api/models?conversationId=...` and `POST /api/models/select {conversationId,model}` read/update only that owned conversation; omitting conversationId addresses the new-conversation default. New conversations snapshot that default. Legacy nullable preferences bind on first access atomically via COALESCE. Queued requests use server-owned v3 `modelSelection.requestedModelId`; client input cannot supply it. Runtime eligibility is rechecked at execution, manual choice never silently changes. Model-selection state events record requested/resolved IDs and unknown upstream identity.

v3 idempotency hashes the canonical client request and full attachment evidence, excluding server-generated model metadata. Retrying the same key after preference changes replays the original Run/selection; changed messages or evidence still conflict. Recovery accepts validated v1/v2/v3 queued requests while retaining external-operation guards. Older v1/v2 requests have no historical selection snapshot and use execution-time conversation preference. Controlled HTTP/store/UI validation does not establish real provider execution or AC05 acceptance; see [independent evidence](evidence/T07-conversation-model-20261019.md).
