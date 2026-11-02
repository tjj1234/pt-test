"use strict";

const nonempty = (value, max = 256) => typeof value === "string" && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (code) => Object.assign(new Error("Controlled media attempt was not admitted"), { code });

/**
 * Host-side pre-POST gate for a single expressly authorized test Run.
 * `grant` and `run` must come from trusted, owned durable records, never tool
 * arguments. `reserveAttempt` must atomically consume the grant and reserve
 * the credential-scope + model + task slot before any provider request. An
 * unknown outcome keeps that slot occupied until explicit reconciliation.
 *
 * This module does not alter the shipped zero-tool runtime policy and cannot
 * prove a monetary cap; production needs a durable reservation transaction.
 */
async function admitControlledMediaAttempt({ grant, run, credentialScopeId, route,
  requestId, retryCount = 0, reserveAttempt, now = () => Date.now() } = {}) {
  if (typeof reserveAttempt !== "function") throw fail("MEDIA_RESERVATION_UNAVAILABLE");
  if (typeof now !== "function") throw fail("MEDIA_CLOCK_UNKNOWN");
  let time;
  try { time = now(); } catch { throw fail("MEDIA_CLOCK_UNKNOWN"); }
  if (!Number.isFinite(time)) throw fail("MEDIA_CLOCK_UNKNOWN");
  if (!grant || grant.authorized !== true || grant.purpose !== "controlled_media_test" ||
      !nonempty(grant.grantId) || !nonempty(grant.userId) || !nonempty(grant.tenantId) ||
      !nonempty(grant.runId) || !nonempty(grant.credentialScopeId) ||
      !nonempty(grant.taskType) || !nonempty(grant.modelId) ||
      !digest(grant.capabilityRevision) || !nonempty(grant.adapterId) ||
      !nonempty(grant.adapterVersion) || grant.maxMediaCalls !== 1 ||
      grant.maxExternalSubmissions !== 1 || grant.maxRetries !== 0 ||
      !Number.isFinite(Date.parse(grant.issuedAt)) ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      Date.parse(grant.issuedAt) > time || Date.parse(grant.expiresAt) <= time) {
    throw fail("MEDIA_GRANT_INVALID");
  }
  if (!run || run.runId !== grant.runId || run.userId !== grant.userId ||
      run.tenantId !== grant.tenantId || run.state !== "running" ||
      run.activeLease !== true || !nonempty(run.leaseOwner) ||
      credentialScopeId !== grant.credentialScopeId || route?.scopeId !== credentialScopeId) {
    throw fail("MEDIA_GRANT_IDENTITY_MISMATCH");
  }
  if (!route || route.taskType !== grant.taskType || route.model !== grant.modelId ||
      route.capabilityRevision !== grant.capabilityRevision ||
      route.adapterId !== grant.adapterId || route.adapterVersion !== grant.adapterVersion) {
    throw fail("MEDIA_GRANT_ROUTE_MISMATCH");
  }
  if (retryCount !== 0) throw fail("MEDIA_RETRY_NOT_ALLOWED");
  if (!nonempty(requestId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw fail("MEDIA_REQUEST_INVALID");
  }
  const reservation = Object.freeze({
    grantId: grant.grantId, runId: run.runId, userId: run.userId, tenantId: run.tenantId,
    credentialScopeId, modelId: route.model, taskType: route.taskType,
    capabilityRevision: route.capabilityRevision,
    operationKey: `${run.runId}:${requestId}`,
  });
  let receipt;
  try { receipt = await reserveAttempt(reservation); }
  catch { throw fail("MEDIA_RESERVATION_FAILED"); }
  if (receipt?.accepted !== true || !nonempty(receipt.reservationId) ||
      receipt.grantId !== grant.grantId || receipt.operationKey !== reservation.operationKey ||
      receipt.scopeConflictChecked !== true || receipt.grantConsumed !== true) {
    throw fail(receipt?.accepted === false ? "MEDIA_RESERVATION_CONFLICT" : "MEDIA_RESERVATION_INVALID");
  }
  return Object.freeze({
    reservationId: receipt.reservationId, operationKey: reservation.operationKey,
    grantId: grant.grantId, runId: run.runId, credentialScopeId,
    unknownOutcomeKeepsReservation: true,
  });
}

module.exports = { admitControlledMediaAttempt };
