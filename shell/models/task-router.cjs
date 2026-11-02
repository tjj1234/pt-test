"use strict";

const { TASKS } = require("./capabilities.cjs");

const fail = (code, detail = null) => ({ ok: false, code, detail });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const factValue = (fact) => isRecord(fact) ? fact.value : null;

function normalizeTextRequirements(requirements) {
  if (!isRecord(requirements) || !TASKS.includes(requirements.task) || requirements.task !== "textChat") return null;
  const input = requirements.inputModalities ?? ["text"];
  const output = requirements.outputModalities ?? ["text"];
  if (!Array.isArray(input) || !Array.isArray(output) ||
      input.length !== 1 || output.length !== 1 || input[0] !== "text" || output[0] !== "text") return null;
  return Object.freeze({ task: "textChat", inputModalities: ["text"], outputModalities: ["text"] });
}

function checkAvailability(candidate, snapshot) {
  if (!isRecord(snapshot) || snapshot.status !== "available" || !Array.isArray(snapshot.modelIds)) {
    return "AVAILABILITY_UNKNOWN";
  }
  if (candidate.availability !== "present") return candidate.availability === "removed" ? "MODEL_REMOVED" : "AVAILABILITY_UNKNOWN";
  if (!snapshot.modelIds.includes(candidate.id)) return "MODEL_UNAVAILABLE";
  return null;
}

function checkCandidate(candidate, task, mode, availability) {
  if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id.trim()) return "CANDIDATE_INVALID";
  const availabilityError = checkAvailability(candidate, availability);
  if (availabilityError) return availabilityError;
  if (candidate.permission !== true) return "PERMISSION_UNKNOWN_OR_DENIED";
  if (candidate.dshConfigured === false) return "DSH_MODEL_NOT_CONFIGURED";
  if (candidate.localPolicy?.enabled !== true || !Array.isArray(candidate.localPolicy.tasks) ||
      !candidate.localPolicy.tasks.includes(task)) return "LOCAL_POLICY_UNKNOWN_OR_DENIED";
  const capability = factValue(candidate.tasks?.[task]);
  if (capability !== true) return capability === false ? "TASK_UNSUPPORTED" : "CAPABILITY_UNKNOWN";
  const state = candidate.states?.[task];
  if (!isRecord(state) || state.adapted !== true) return "ADAPTER_UNVERIFIED";
  if (state.endpointCompatible !== true) return state.endpointCompatible === false ? "ADAPTER_ENDPOINT_MISMATCH" : "ENDPOINT_COMPATIBILITY_UNKNOWN";
  if (state.verified !== true && mode !== "manual") return "RUNTIME_UNVERIFIED";
  const input = factValue(candidate.inputModalities);
  const output = factValue(candidate.outputModalities);
  if (!Array.isArray(input) || !Array.isArray(output)) return "MODALITY_UNKNOWN";
  if (!input.includes("text") || !output.includes("text")) return "TEXT_MODALITY_UNSUPPORTED";
  if(task==='imageUnderstanding'&&!input.includes('image'))return 'IMAGE_MODALITY_UNSUPPORTED';
  if (mode === "auto" && state.autoEligible !== true) return "NOT_AUTO_ELIGIBLE";
  return null;
}

/**
 * Route one normalized text task using explicit capability and runtime evidence.
 * Candidate order is the caller's deterministic policy order; this function
 * never ranks by model name or invents a fallback.
 */
function routeChatTask({ candidates, requirements, selection = { mode: "auto" }, availability } = {}) {
  const normalized = requirements?.task==='imageUnderstanding'
    ? normalizeImageRequirements(requirements) : normalizeTextRequirements(requirements);
  if (!normalized) return fail("TASK_REQUIREMENTS_INVALID");
  if (!Array.isArray(candidates)) return fail("CANDIDATES_INVALID");
  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (typeof candidate?.id !== "string" || !candidate.id.trim()) continue;
    if (candidateIds.has(candidate.id)) return fail("CANDIDATE_ID_AMBIGUOUS", candidate.id);
    candidateIds.add(candidate.id);
  }
  const mode = selection?.mode;
  if (mode !== "auto" && mode !== "manual") return fail("SELECTION_MODE_INVALID");
  if (mode === "manual" && (typeof selection.modelId !== "string" || !selection.modelId.trim())) return fail("MANUAL_MODEL_REQUIRED");

  const pool = mode === "manual" ? candidates.filter((candidate) => candidate?.id === selection.modelId) : candidates;
  if (mode === "manual" && !pool.length) return fail("MANUAL_MODEL_NOT_CANDIDATE", selection.modelId);
  const rejected = [];
  for (const candidate of pool) {
    const reason = checkCandidate(candidate, normalized.task, mode, availability);
    if (reason) { rejected.push({ modelId: typeof candidate?.id === "string" ? candidate.id : null, code: reason }); continue; }
    return {
      ok: true,
      task: normalized.task,
      mode,
      requestedModelId: mode === "manual" ? selection.modelId : null,
      resolvedModelId: candidate.id,
      verificationRequired: candidate.states?.[normalized.task]?.verified !== true,
      rejected,
    };
  }
  if (mode === "manual") return fail("MANUAL_MODEL_INELIGIBLE", { modelId: selection.modelId, reasons: rejected });
  return fail("NO_ELIGIBLE_MODEL", rejected);
}

function normalizeImageRequirements(requirements){
 if(!isRecord(requirements)||requirements.task!=='imageUnderstanding')return null;
 const input=requirements.inputModalities??['text','image'],output=requirements.outputModalities??['text'];
 if(!Array.isArray(input)||input.length!==2||new Set(input).size!==2||!input.includes('text')||!input.includes('image')||
   !Array.isArray(output)||output.length!==1||output[0]!=='text')return null;
 return Object.freeze({task:'imageUnderstanding',inputModalities:['text','image'],outputModalities:['text']});
}
function routeTextTask(input={}){
 if(!normalizeTextRequirements(input.requirements))return fail('TASK_REQUIREMENTS_INVALID');
 return routeChatTask(input);
}

// Admission belongs to the selected operation, never to candidate filtering.
// The estimate callback receives exactly the selected catalog record. The caller
// must settle the returned admission after execution, including failed calls.
function admitTextTask(input, { budget, estimateCost } = {}) {
  const route = routeTextTask(input);
  if (!route.ok) return route;
  if (!budget || typeof budget.snapshot !== "function" || typeof budget.admit !== "function") return fail("BUDGET_UNCONFIGURED");
  const snapshot = budget.snapshot();
  if (snapshot?.policyStatus !== "configured") return fail("BUDGET_UNCONFIGURED");
  if (snapshot.clockStatus !== "monotonic") return fail("BUDGET_UNVERIFIED");
  const candidate = input.candidates.find((model) => model?.id === route.resolvedModelId);
  let estimatedCost;
  try {
    estimatedCost = typeof estimateCost === "function" ? estimateCost(candidate) : undefined;
    if (estimatedCost && typeof estimatedCost.then === "function") {
      // Reject asynchronous estimates without leaving their rejection unhandled.
      Promise.resolve(estimatedCost).catch(() => {});
      return fail("BUDGET_ESTIMATE_INVALID");
    }
  } catch { return fail("BUDGET_ESTIMATE_INVALID"); }
  const admission = budget.admit({ type: "model", estimatedCost });
  if (admission.allowed !== true) return fail(admission.code || "BUDGET_DENIED");
  return { ...route, admission };
}

module.exports = { routeChatTask, routeTextTask, admitTextTask, normalizeTextRequirements, normalizeImageRequirements };
