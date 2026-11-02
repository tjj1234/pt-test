"use strict";

const { routeMediaTask } = require("./media-task-router.cjs");
const { DEFAULT_BASE_URL } = require("../model-catalog.cjs");
const { DEFAULT_BASE_URL: MEDIA_POST_BASE_URL } = require("../../business/media/powertokens.cjs");

function admissionError(code) {
  return Object.assign(new Error("Media model qualification failed"), { code });
}

function mediaGatewayMatchesCatalog() {
  // The catalog base includes /v1; media POST appends /v1 to its own base.
  // Compare these effective bases without exposing either value in errors.
  const catalogRoot = DEFAULT_BASE_URL.replace(/\/v1\/?$/, "");
  return catalogRoot !== DEFAULT_BASE_URL && MEDIA_POST_BASE_URL.replace(/\/+$/, "") === catalogRoot;
}

/** The caller supplies the exact credential that will be used for submission.
 * A failed refresh cannot authorize a media request from a stale listing.
 */
async function resolveMediaRouteForRun({ identity, args, apiKey, getCatalog, selection = { mode: "auto" } }) {
  if (!identity?.userId || !apiKey || typeof getCatalog !== "function") throw admissionError("MEDIA_ROUTE_UNAVAILABLE");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw admissionError("MEDIA_TASK_UNSUPPORTED");
  if (["model", "modelId", "provider", "endpoint", "baseUrl", "resolvedRoute"].some((key) => Object.hasOwn(args, key))) {
    throw admissionError("MEDIA_ROUTE_ARGUMENT_OVERRIDE");
  }
  if (!mediaGatewayMatchesCatalog()) throw admissionError("MEDIA_GATEWAY_MISMATCH");
  let catalog;
  // Use the same credential scope as the user-visible model catalog. The
  // catalog cache hashes baseURL into scopeId even when its fetch defaults it.
  try { catalog = await getCatalog({ apiKey, baseURL: DEFAULT_BASE_URL, scopeId: identity.userId, force: true, fallback: [] }); }
  catch { throw admissionError("MEDIA_CATALOG_UNAVAILABLE"); }
  if (catalog?.catalogDiagnostics?.errorCode || catalog?.catalogDiagnostics?.state !== "fresh" ||
      catalog?.availability?.status !== "available" || !catalog.scopeId) throw admissionError("MEDIA_CATALOG_UNAVAILABLE");
  const route = routeMediaTask({
    candidates: catalog.models,
    availability: { ...catalog.availability, scopeId: catalog.scopeId },
    taskType: args.taskType,
    selection,
  });
  if (!route.ok) throw admissionError(route.code);
  return route.resolvedRoute;
}

module.exports = { resolveMediaRouteForRun };
