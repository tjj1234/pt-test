"use strict";

const { MEDIA_TASKS, MEDIA_ADAPTERS } = require("./media-task-router.cjs");

const own = (value, key) => Object.hasOwn(value, key);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() === value && value.length > 0;
const revision = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const error = (code) => Object.assign(new Error("Reviewed media qualification is unavailable"), { code });

/**
 * Build host-owned qualification updates from a review bound to one fresh
 * credential-scoped catalog revision. This prepares a bounded manual trial;
 * it never creates a runtime verification or an AUTO route.
 *
 * Review shape: { modelId, scopeId, capabilityRevision, appliedCapabilityRevision?,
 *   version, source, reviewedAt,
 *   tasks: [{ taskType, source, adapterId, endpoint }] }.
 * The source of each task must identify a reviewed model-specific declaration,
 * not a model-name inference or a generic PT endpoint label.
 * `capabilityRevision` is the pre-apply snapshot. After an administrator
 * inspects the resulting model, they may record its new hash as
 * `appliedCapabilityRevision` for exact, idempotent replay. Any third hash
 * requires a new review. This function does not write that review record.
 */
function buildReviewedMediaQualificationMaps({ catalog, reviews = [] } = {}) {
  if (!plain(catalog) || catalog.catalogDiagnostics?.state !== "fresh" ||
      catalog.catalogDiagnostics?.errorCode || !text(catalog.scopeId) ||
      catalog.availability?.status !== "available" ||
      !Array.isArray(catalog.availability.modelIds) || !Array.isArray(catalog.models)) {
    throw error("MEDIA_CATALOG_UNAVAILABLE");
  }
  if (!Array.isArray(reviews)) throw error("MEDIA_REVIEW_INVALID");
  const byId = new Map();
  for (const candidate of catalog.models) {
    if (!plain(candidate) || !text(candidate.id) || byId.has(candidate.id)) throw error("MEDIA_CATALOG_AMBIGUOUS");
    byId.set(candidate.id, candidate);
  }

  const overrides = {}, policies = {}, adaptations = {}, verifications = {};
  const seen = new Set();
  for (const review of reviews) {
    if (!plain(review) || !text(review.modelId) || seen.has(review.modelId) ||
        review.scopeId !== catalog.scopeId || !revision(review.capabilityRevision) ||
        (review.appliedCapabilityRevision != null && !revision(review.appliedCapabilityRevision)) ||
        !text(review.version) || !text(review.source) || !text(review.reviewedAt) ||
        !Number.isFinite(Date.parse(review.reviewedAt)) ||
        !Array.isArray(review.tasks) || !review.tasks.length) throw error("MEDIA_REVIEW_INVALID");
    seen.add(review.modelId);
    const candidate = byId.get(review.modelId);
    if (!candidate || candidate.scopeId !== catalog.scopeId ||
        candidate.availability !== "present" || candidate.permission !== true ||
        !catalog.availability.modelIds.includes(review.modelId)) throw error("MEDIA_REVIEW_STALE_OR_UNAUTHORIZED");
    const initial = candidate.capabilityRevision === review.capabilityRevision;
    const replay = !initial && review.appliedCapabilityRevision != null &&
      candidate.capabilityRevision === review.appliedCapabilityRevision;
    if (!initial && !replay) throw error("MEDIA_REVIEW_STALE_OR_UNAUTHORIZED");
    if (replay && (candidate.manualOverride?.source !== review.source ||
        candidate.manualOverride?.version !== review.version ||
        candidate.localPolicy?.source !== review.source ||
        candidate.localPolicy?.version !== review.version)) throw error("MEDIA_REVIEW_REPLAY_MISMATCH");

    const previousOverride = plain(candidate.manualOverride) ? candidate.manualOverride : null;
    const taskFacts = { ...(previousOverride?.tasks || {}) };
    const inputs = new Set(previousOverride?.inputModalities || []);
    const outputs = new Set(previousOverride?.outputModalities || []);
    const endpoints = new Set(previousOverride?.endpoints || []);
    const grants = new Set();
    const adapterMap = { ...(candidate.adaptations || {}) };
    const verificationMap = { ...(candidate.verifications || {}) };
    const priorTasks = candidate.localPolicy?.enabled === true &&
      Array.isArray(candidate.localPolicy.tasks) && text(candidate.localPolicy.source) &&
      text(candidate.localPolicy.version) ? candidate.localPolicy.tasks : [];
    const policyTasks = new Set(priorTasks);

    for (const item of review.tasks) {
      const requirements = plain(item) && own(MEDIA_TASKS, item.taskType) ? MEDIA_TASKS[item.taskType] : null;
      const adapter = plain(item) && own(MEDIA_ADAPTERS, item.adapterId) ? MEDIA_ADAPTERS[item.adapterId] : null;
      if (!requirements || grants.has(requirements.task) || !text(item.source) ||
          !adapter || !adapter.taskTypes.includes(item.taskType) ||
          item.endpoint !== adapter.endpoint) throw error("MEDIA_REVIEW_TASK_INVALID");
      if (replay && (candidate.manualOverride?.tasks?.[requirements.task] !== true ||
          !candidate.manualOverride?.inputModalities?.includes(requirements.input) ||
          !candidate.manualOverride?.outputModalities?.includes(requirements.output) ||
          !candidate.manualOverride?.endpoints?.includes(adapter.endpoint) ||
          !candidate.localPolicy?.tasks?.includes(requirements.task) ||
          candidate.adaptations?.[requirements.task]?.adapterId !== adapter.adapterId ||
          candidate.adaptations?.[requirements.task]?.version !== adapter.version ||
          candidate.adaptations?.[requirements.task]?.endpoint !== adapter.endpoint ||
          candidate.adaptations?.[requirements.task]?.source !== `${review.source}; ${item.source}`)) {
        throw error("MEDIA_REVIEW_REPLAY_MISMATCH");
      }
      grants.add(requirements.task);
      if (initial) delete verificationMap[requirements.task];
      taskFacts[requirements.task] = true;
      inputs.add(requirements.input);
      outputs.add(requirements.output);
      endpoints.add(adapter.endpoint);
      policyTasks.add(requirements.task);
      adapterMap[requirements.task] = {
        adapterId: adapter.adapterId, version: adapter.version, endpoint: adapter.endpoint,
        source: `${review.source}; ${item.source}`,
      };
    }

    overrides[review.modelId] = {
      id: review.modelId, source: review.source, version: review.version,
      tasks: taskFacts, inputModalities: [...inputs].sort(),
      outputModalities: [...outputs].sort(), endpoints: [...endpoints].sort(),
    };
    policies[review.modelId] = {
      enabled: true, source: review.source, version: review.version,
      tasks: [...policyTasks].sort(),
    };
    adaptations[review.modelId] = adapterMap;
    // Invalidate only the reviewed media tasks. A reviewed chat task on the
    // same model keeps its independent verification and Agent availability.
    // An exact replay keeps a later, scope/revision/adapter-bound media result.
    verifications[review.modelId] = verificationMap;
  }
  return { overrides, policies, adaptations, verifications };
}

module.exports = { buildReviewedMediaQualificationMaps };
