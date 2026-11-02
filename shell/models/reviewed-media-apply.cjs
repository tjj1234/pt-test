"use strict";

const { buildReviewedMediaQualificationMaps } = require("./reviewed-media-qualification.cjs");
const { MEDIA_TASKS } = require("./media-task-router.cjs");
const { isDeepStrictEqual } = require("node:util");

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const revision = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (code) => Object.assign(new Error("Reviewed media qualification could not be applied"), { code });
const sameValue = (left, right) => isDeepStrictEqual(left ?? null, right ?? null);

/**
 * Apply a host-reviewed media configuration to exactly the inspected scope
 * and model revisions. `applyUpdates` is a trusted storage callback with an
 * atomic compare-and-set contract over `scopeId` and `expectedRevisions`.
 * It must return { applied:true, previousRevisions, catalog } or
 * { applied:false } on a concurrent change. No Key enters this function.
 *
 * The result is a draft revision for administrator confirmation. A separate
 * runtime result may later establish verification; this function never does.
 */
async function applyReviewedMediaQualification({ catalog, reviews, applyUpdates } = {}) {
  if (typeof applyUpdates !== "function") throw fail("MEDIA_REVIEW_APPLIER_UNAVAILABLE");
  if (!Array.isArray(reviews) || !reviews.length) throw fail("MEDIA_REVIEW_INVALID");
  const maps = buildReviewedMediaQualificationMaps({ catalog, reviews });
  const inspected = new Map(catalog.models.map((model) => [model.id, model]));
  const expectedRevisions = Object.fromEntries(reviews.map((review) => [review.modelId, review.appliedCapabilityRevision &&
    inspected.get(review.modelId).capabilityRevision === review.appliedCapabilityRevision
    ? review.appliedCapabilityRevision : review.capabilityRevision]));
  let receipt;
  try {
    receipt = await applyUpdates({ scopeId: catalog.scopeId, expectedRevisions, maps });
  } catch { throw fail("MEDIA_REVIEW_APPLY_FAILED"); }
  if (receipt?.applied !== true) throw fail(receipt?.applied === false ? "MEDIA_REVIEW_CONFLICT" : "MEDIA_REVIEW_APPLY_INVALID");
  if (!plain(receipt.previousRevisions) ||
      Object.keys(expectedRevisions).length !== Object.keys(receipt.previousRevisions).length ||
      Object.entries(expectedRevisions).some(([id, hash]) => receipt.previousRevisions[id] !== hash)) {
    throw fail("MEDIA_REVIEW_CONFLICT");
  }
  const updated = receipt.catalog;
  if (!plain(updated) || updated.scopeId !== catalog.scopeId ||
      updated.catalogDiagnostics?.state !== "fresh" || updated.catalogDiagnostics?.errorCode ||
      updated.availability?.status !== "available" || !Array.isArray(updated.availability.modelIds) ||
      !Array.isArray(updated.models)) throw fail("MEDIA_REVIEW_APPLY_INVALID");
  const byId = new Map();
  for (const candidate of updated.models) {
    if (!plain(candidate) || typeof candidate.id !== "string" || byId.has(candidate.id)) throw fail("MEDIA_REVIEW_APPLY_INVALID");
    byId.set(candidate.id, candidate);
  }

  const confirmations = [];
  for (const review of reviews) {
    const before = inspected.get(review.modelId);
    const after = byId.get(review.modelId);
    const replay = before.capabilityRevision === review.appliedCapabilityRevision &&
      before.capabilityRevision !== review.capabilityRevision;
    if (!after || after.scopeId !== catalog.scopeId || !revision(after.capabilityRevision) ||
        (replay && after.capabilityRevision !== review.appliedCapabilityRevision) ||
        after.availability !== "present" || after.permission !== true ||
        !updated.availability.modelIds.includes(review.modelId) ||
        after.manualOverride?.source !== review.source ||
        after.manualOverride?.version !== review.version ||
        after.localPolicy?.source !== review.source ||
        after.localPolicy?.version !== review.version) throw fail("MEDIA_REVIEW_APPLY_INVALID");
    for (const item of review.tasks) {
      const task = MEDIA_TASKS[item.taskType].task;
      const adapter = maps.adaptations[review.modelId][task];
      if (after.tasks?.[task]?.value !== true ||
          !after.localPolicy?.tasks?.includes(task) ||
          !after.endpoints?.value?.includes(adapter.endpoint) ||
          !sameValue(after.adaptations?.[task], adapter) ||
          !sameValue(after.verifications?.[task], replay ? before.verifications?.[task] : null) ||
          (!replay && (after.states?.[task]?.verified === true || after.states?.[task]?.autoEligible === true))) {
        throw fail("MEDIA_REVIEW_APPLY_INVALID");
      }
    }
    confirmations.push(Object.freeze({
      modelId: review.modelId, scopeId: catalog.scopeId,
      previousCapabilityRevision: before.capabilityRevision,
      appliedCapabilityRevision: after.capabilityRevision,
      reviewVersion: review.version, status: "pending_admin_confirmation",
    }));
  }
  return Object.freeze({ status: "pending_admin_confirmation", confirmations });
}

module.exports = { applyReviewedMediaQualification };
