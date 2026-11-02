"use strict";

const { MEDIA_ADAPTERS, validateResolvedMediaRoute } = require("../../business/media/powertokens.cjs");
const MEDIA_TASKS = Object.freeze({
  text2image: Object.freeze({ task: "textToImage", input: "text", output: "image" }),
  image2image: Object.freeze({ task: "imageToImage", input: "image", output: "image" }),
  text2video: Object.freeze({ task: "textToVideo", input: "text", output: "video" }),
  image2video: Object.freeze({ task: "imageToVideo", input: "image", output: "video" }),
});
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const fail = (code, detail = null) => ({ ok: false, code, detail });
const scopeOf = (candidate) => candidate.scopeId || candidate.capabilityScopeId;

function isVerified(candidate, task, adapter) {
  const verification = candidate.verifications?.[task];
  return candidate.states?.[task]?.verified === true && verification?.status === "passed" &&
    verification.modelId === candidate.id && verification.task === task &&
    verification.scopeId === scopeOf(candidate) && verification.capabilityRevision === candidate.capabilityRevision &&
    verification.adapterId === adapter.adapterId && verification.adapterVersion === adapter.version &&
    verification.endpoint === adapter.endpoint && text(verification.source) &&
    text(verification.verifiedAt) && Number.isFinite(Date.parse(verification.verifiedAt)) &&
    (!candidate.verificationNotBefore || Date.parse(verification.verifiedAt) >= Date.parse(candidate.verificationNotBefore));
}

function checkCandidate(candidate, taskType, availability, mode) {
  const requirements = MEDIA_TASKS[taskType];
  if (!record(candidate) || !text(candidate.id)) return { code: "CANDIDATE_INVALID" };
  if (scopeOf(candidate) !== availability.scopeId) return { code: "MODEL_SCOPE_MISMATCH" };
  if (candidate.availability !== "present" || !availability.modelIds.includes(candidate.id)) return { code: "MODEL_UNAVAILABLE" };
  if (candidate.permission !== true) return { code: "PERMISSION_UNKNOWN_OR_DENIED" };
  // The catalog's textChat default policy is model-wide. Media needs a
  // task-specific grant; an enabled chat policy cannot authorize paid media.
  if (candidate.localPolicy?.enabled !== true || !text(candidate.localPolicy.source) ||
      !text(candidate.localPolicy.version) || !Array.isArray(candidate.localPolicy.tasks) ||
      !candidate.localPolicy.tasks.includes(requirements.task)) return { code: "LOCAL_POLICY_UNKNOWN_OR_DENIED" };
  const task = candidate.tasks?.[requirements.task];
  if (task?.value !== true || !record(task.source)) return { code: task?.value === false ? "TASK_UNSUPPORTED" : "CAPABILITY_UNKNOWN" };
  const inputs = candidate.inputModalities, outputs = candidate.outputModalities;
  if (!Array.isArray(inputs?.value) || !Array.isArray(outputs?.value) || !record(inputs.source) || !record(outputs.source)) return { code: "MODALITY_UNKNOWN" };
  if (!inputs.value.includes(requirements.input) || !outputs.value.includes(requirements.output)) return { code: "MODALITY_UNSUPPORTED" };
  const adaptation = candidate.adaptations?.[requirements.task];
  const adapter = adaptation && Object.hasOwn(MEDIA_ADAPTERS, adaptation.adapterId) ? MEDIA_ADAPTERS[adaptation.adapterId] : null;
  if (!adapter || adaptation.version !== adapter.version || !text(adaptation.source) || !adapter.taskTypes.includes(taskType)) return { code: "MEDIA_ADAPTER_UNSUPPORTED" };
  if (adaptation.endpoint !== adapter.endpoint || candidate.states?.[requirements.task]?.adapted !== true || candidate.states?.[requirements.task]?.endpointCompatible !== true) return { code: "ADAPTER_ENDPOINT_MISMATCH" };
  if (!/^[a-f0-9]{64}$/.test(candidate.capabilityRevision || "")) return { code: "CAPABILITY_REVISION_INVALID" };
  const verified = isVerified(candidate, requirements.task, adapter);
  if (mode === "auto" && (!verified || candidate.states[requirements.task].autoEligible !== true)) return { code: "RUNTIME_UNVERIFIED" };
  return { adapter, verified };
}

/** Pure selection over host-owned, current-credential catalog evidence.
 * Budget admission belongs to the host after selection, before any submission.
 * Manual selection permits a first bounded qualification run, never bypassing
 * permission/policy/task/modality/adapter/endpoint checks.
 */
function routeMediaTask({ candidates, availability, taskType, selection = { mode: "auto" } } = {}) {
  if (!Object.hasOwn(MEDIA_TASKS, taskType)) return fail("MEDIA_TASK_UNSUPPORTED");
  if (!Array.isArray(candidates)) return fail("CANDIDATES_INVALID");
  if (!record(availability) || availability.status !== "available" || !text(availability.scopeId) || !Array.isArray(availability.modelIds)) return fail("AVAILABILITY_UNKNOWN");
  if (!record(selection) || !["auto", "manual"].includes(selection.mode)) return fail("SELECTION_MODE_INVALID");
  if (selection.mode === "manual" && !text(selection.modelId)) return fail("MANUAL_MODEL_REQUIRED");
  const ids = new Set();
  for (const candidate of candidates) {
    if (!text(candidate?.id)) continue;
    if (ids.has(candidate.id)) return fail("CANDIDATE_ID_AMBIGUOUS");
    ids.add(candidate.id);
  }
  const pool = selection.mode === "manual" ? candidates.filter((candidate) => candidate?.id === selection.modelId) : candidates;
  if (!pool.length && selection.mode === "manual") return fail("MANUAL_MODEL_NOT_CANDIDATE");
  const rejected = [];
  for (const candidate of pool) {
    const result = checkCandidate(candidate, taskType, availability, selection.mode);
    if (result.code) { rejected.push({ modelId: text(candidate?.id) ? candidate.id : null, code: result.code }); continue; }
    const { adapter, verified } = result;
    let resolvedRoute;
    try {
      resolvedRoute = validateResolvedMediaRoute({ schemaVersion: 1, taskType, model: candidate.id,
        scopeId: availability.scopeId, capabilityRevision: candidate.capabilityRevision,
        adapterId: adapter.adapterId, adapterVersion: adapter.version, endpoint: adapter.endpoint,
        provider: adapter.provider, kind: adapter.kind }, taskType);
    } catch { rejected.push({ modelId: candidate.id, code: "MEDIA_ROUTE_INVALID" }); continue; }
    return { ok: true, task: MEDIA_TASKS[taskType].task, taskType, mode: selection.mode,
      requestedModelId: selection.mode === "manual" ? selection.modelId : null,
      resolvedModelId: candidate.id, verificationRequired: !verified, resolvedRoute, rejected };
  }
  return fail(selection.mode === "manual" ? "MANUAL_MODEL_INELIGIBLE" : "NO_ELIGIBLE_MODEL", rejected);
}

/** Describe every current model/task pair without granting a route or budget.
 * The caller must have fetched this catalog with the credential that would be
 * used for submission. Stale, failed and display-only catalogs have no matrix.
 */
function buildMediaQualificationMatrix(catalog) {
  if (!record(catalog) || catalog.catalogDiagnostics?.state !== "fresh" ||
      catalog.catalogDiagnostics?.errorCode || !text(catalog.scopeId) ||
      !record(catalog.availability) || catalog.availability.status !== "available" ||
      !Array.isArray(catalog.availability.modelIds) || !Array.isArray(catalog.models)) {
    return fail("MEDIA_CATALOG_UNAVAILABLE");
  }
  const ids = new Set();
  for (const candidate of catalog.models) {
    if (!text(candidate?.id)) return fail("CANDIDATE_INVALID");
    if (ids.has(candidate.id)) return fail("CANDIDATE_ID_AMBIGUOUS");
    ids.add(candidate.id);
  }
  const availability = { ...catalog.availability, scopeId: catalog.scopeId };
  const counts = Object.fromEntries(Object.keys(MEDIA_TASKS).map((taskType) => [taskType, 0]));
  const rows = catalog.models.map((candidate) => {
    const tasks = {};
    for (const taskType of Object.keys(MEDIA_TASKS)) {
      const result = routeMediaTask({ candidates: [candidate], availability, taskType });
      // A route-ready model still needs an admitted Run budget and execution.
      const code = result.ok ? "ROUTE_READY" : result.detail?.[0]?.code || result.code;
      tasks[taskType] = code;
      if (result.ok) counts[taskType]++;
    }
    return { modelId: candidate.id, tasks };
  });
  return { ok: true, catalogState: "fresh", modelCount: rows.length, routeReadyCounts: counts, rows };
}

module.exports = { MEDIA_TASKS, MEDIA_ADAPTERS, routeMediaTask, buildMediaQualificationMatrix, validateResolvedMediaRoute };
