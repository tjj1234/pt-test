"use strict";

const TOKEN_FIELDS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]);
const TRUSTED_TOTAL_SEMANTICS = "dsh_pi_ai_disjoint_0_1_1_rc_2";
const token = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Counts observed SDK response events, not network attempts or internal retries.
// Missing evidence remains unknown; it must never become a zero-cost response.
function collectResponseUsage(events, firstSeq = 0) {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 0) throw new TypeError("A valid response cursor is required");
  const seen = new Map();
  const responses = [];
  const usageChunks = new Map();
  const messages = [];
  let trustedDshEvents = true;
  let started = !(events || []).some((event) => event?.type === "turn/start" && event.seq >= firstSeq);
  for (const event of events || []) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < firstSeq) continue;
    let signature;
    try { signature = JSON.stringify(event); } catch { trustedDshEvents = false; }
    if (seen.has(event.seq)) {
      if (seen.get(event.seq) !== signature) trustedDshEvents = false;
      continue;
    }
    seen.set(event.seq, signature);
    if (event.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      const turn = event.data?.turn;
      const step = event.data?.step;
      const raw = event.data.chunk.usage;
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || !raw || typeof raw !== "object") {
        trustedDshEvents = false;
      }
      usageChunks.set(event.seq, { seq: event.seq, turn, step, raw });
    } else if (event.type === "assistant/message") {
      if (!Number.isSafeInteger(event.data?.turn) || !Number.isSafeInteger(event.data?.step)
          || event.data?.message?.role !== "assistant") trustedDshEvents = false;
      messages.push(event);
    }
  }
  const consumedUsageChunks = new Set();
  const citedChunkOwners = new Map();
  for (const event of messages) {
    const refs = Array.isArray(event.sourceEventSeqs) ? new Set(event.sourceEventSeqs) : new Set();
    const referenced = [...usageChunks.values()].filter((chunk) => refs.has(chunk.seq)
      && chunk.turn === event.data?.turn && chunk.step === event.data?.step);
    const mismatchedCitation = [...usageChunks.values()].some((chunk) => refs.has(chunk.seq)
      && (chunk.turn !== event.data?.turn || chunk.step !== event.data?.step));
    const sameStep = [...usageChunks.values()].filter((chunk) => chunk.seq < event.seq
      && chunk.turn === event.data?.turn && chunk.step === event.data?.step);
    const duplicateCitation = referenced.some((chunk) => citedChunkOwners.has(chunk.seq));
    const futureCitation = referenced.some((chunk) => chunk.seq >= event.seq);
    for (const chunk of referenced) {
      consumedUsageChunks.add(chunk.seq);
      const priorResponse = citedChunkOwners.get(chunk.seq);
      if (priorResponse) priorResponse.usage = normalizeUsage(null);
    }
    // Without a cited usage chunk, same-step chunks may be the same response
    // or distinct retries. Collapse them into one unknown response rather
    // than treating the message and chunks as proven separate attempts.
    const lastCitedSeq = referenced.length ? Math.max(...referenced.map((chunk) => chunk.seq)) : -1;
    const uncitedAfterCitation = sameStep.some((chunk) => !refs.has(chunk.seq) && chunk.seq > lastCitedSeq);
    const ambiguous = (referenced.length === 0 && sameStep.length > 0) || uncitedAfterCitation;
    if (ambiguous) {
      trustedDshEvents = false;
      for (const chunk of sameStep) consumedUsageChunks.add(chunk.seq);
    }
    // A committed message and its cited chunk must agree before either can
    // establish a trusted total. One cited chunk is the locked SDK shape.
    const messageUsage = event.data?.usage;
    const conflict = duplicateCitation || futureCitation || mismatchedCitation || referenced.length > 1 || (messageUsage != null && referenced.length === 1
      && TOKEN_FIELDS.some((key) => normalizeUsage(messageUsage)[key] !== normalizeUsage(referenced[0].raw)[key]));
    if (conflict) trustedDshEvents = false;
    const raw = ambiguous || conflict ? null : messageUsage ?? referenced.at(-1)?.raw;
    const response = { responseSeq: event.seq, usage: normalizeUsage(raw) };
    responses.push(response);
    for (const chunk of referenced) citedChunkOwners.set(chunk.seq, response);
  }
  // A usage chunk not cited by a committed/interrupted message represents an
  // observed provider attempt that failed before message finalization (or a
  // retry that was superseded). Keep it under its own stable event sequence.
  for (const chunk of usageChunks.values()) {
    if (!consumedUsageChunks.has(chunk.seq)) {
      responses.push({ responseSeq: chunk.seq, usage: normalizeUsage(chunk.raw) });
    }
  }
  responses.sort((a, b) => a.responseSeq - b.responseSeq);
  if (!responses.length) return { usage: null, observedResponses: 0, responses: [], coverage: "unavailable", totalSemantics: "unknown" };
  const usage = {};
  for (const key of TOKEN_FIELDS) {
    const values = responses.map((response) => response.usage[key]);
    const total = values.every((value) => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
    usage[key] = Number.isSafeInteger(total) ? total : null;
  }
  const totalTokens = TOKEN_FIELDS.every((key) => usage[key] !== null)
    ? TOKEN_FIELDS.reduce((sum, key) => sum + usage[key], 0) : null;
  usage.totalTokens = Number.isSafeInteger(totalTokens) ? totalTokens : null;
  const coverage = responses.every((response) => TOKEN_FIELDS.every((key) => response.usage[key] !== null)) ? "complete" : "partial";
  const totalSemantics = coverage === "complete" && usage.totalTokens !== null && trustedDshEvents
    ? TRUSTED_TOTAL_SEMANTICS : "unknown";
  return { usage, observedResponses: responses.length, responses, coverage, totalSemantics };
}

function normalizeUsage(raw) {
  const normalized = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, token(raw?.[key])]));
  // The locked DSH pi-ai adapter omits cache fields only when pi-ai reports
  // zero. A present usage object therefore carries zero cache evidence for
  // omitted fields; a wholly absent usage object remains unknown.
  if (raw && typeof raw === "object") {
    for (const key of ["cacheReadTokens", "cacheWriteTokens"]) {
      if (raw[key] === undefined) normalized[key] = 0;
    }
  }
  // The locked pi-ai stream starts with a zero-filled usage object and can
  // emit it on done/error without any upstream usage frame. DSH currently
  // carries no usage-present bit, so an all-zero object cannot prove a free
  // provider response. Keep even a genuine zero unknown until that bit exists.
  if (TOKEN_FIELDS.every((key) => normalized[key] === 0)) {
    return Object.fromEntries(TOKEN_FIELDS.map((key) => [key, null]));
  }
  return normalized;
}

// Locked pi-ai stores the configured request model in DSH message.source.model.
// It stores a differing upstream chunk.model in
// message.source.replayState.response.responseModel. Absence cannot prove
// which model served the request.
function modelId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
function responseCoordinates(row) {
  return Number.isSafeInteger(row?.turn) && row.turn >= 0 && Number.isSafeInteger(row?.step) && row.step >= 0
    ? { turn: row.turn, step: row.step } : {};
}

function collectModelIdentity(events, firstSeq = 0) {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 0) throw new TypeError("A valid response cursor is required");
  const responses = [];
  let overflow = false;
  for (const event of events || []) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < firstSeq || event.type !== "assistant/message") continue;
    if (responses.length >= 32) { overflow = true; break; }
    const message = event.data?.message;
    if (!message || message.role !== "assistant" || message.source?.kind !== "model") continue;
    const configuredModelId = modelId(message.source.model);
    const replay = message.source.replayState?.response;
    const providerReportedModelId = replay?.kind === "pi-ai" && replay.version === 2 &&
      replay.model === configuredModelId ? modelId(replay.responseModel) : null;
    responses.push({ responseSeq: event.seq, configuredModelId, providerReportedModelId,
      ...responseCoordinates(event.data),
      evidence: providerReportedModelId ? "provider_response_model" : "upstream_identity_unavailable" });
  }
  const reported = responses.filter((response) => response.providerReportedModelId !== null).length;
  return { coverage: overflow ? "truncated" : !responses.length ? "unavailable" : !reported ? "unknown" : reported === responses.length ? "reported" : "partial", responses };
}

function normalizeModelIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.responses) || value.responses.length > 32) {
    return { coverage: "unavailable", responses: [] };
  }
  const responses = [];
  let previousSeq = -1;
  for (const row of value.responses) {
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.responseSeq) || row.responseSeq < 0 ||
        row.responseSeq <= previousSeq ||
        (row.configuredModelId != null && !modelId(row.configuredModelId)) ||
        (row.providerReportedModelId != null && !modelId(row.providerReportedModelId))) return { coverage: "unavailable", responses: [] };
    previousSeq = row.responseSeq;
    const providerReportedModelId = modelId(row.providerReportedModelId);
    responses.push({ responseSeq: row.responseSeq, configuredModelId: modelId(row.configuredModelId), providerReportedModelId,
      ...responseCoordinates(row),
      evidence: providerReportedModelId ? "provider_response_model" : "upstream_identity_unavailable" });
  }
  const reported = responses.filter((response) => response.providerReportedModelId !== null).length;
  return { coverage: value.coverage === "truncated" ? "truncated" : !responses.length ? "unavailable" : !reported ? "unknown" : reported === responses.length ? "reported" : "partial", responses };
}

module.exports = { collectResponseUsage, collectModelIdentity, normalizeModelIdentity, TOKEN_FIELDS, TRUSTED_TOTAL_SEMANTICS };
