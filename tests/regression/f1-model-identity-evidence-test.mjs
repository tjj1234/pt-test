import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { collectModelIdentity, normalizeModelIdentity } = require("../../shell/runtime/usage.cjs");
const assistant = (seq, model, responseModel) => ({ seq, type: "assistant/message", data: {
  message: { role: "assistant", source: { kind: "model", model,
    ...(responseModel === undefined ? {} : { replayState: { response: { kind: "pi-ai", version: 2, model, responseModel } } }) },
    content: [{ type: "text", text: "private response" }] },
} });

test("configured request model is not promoted to upstream identity", () => {
  const result = collectModelIdentity([assistant(4, "requested-a")], 0);
  assert.equal(result.coverage, "unknown");
  assert.deepEqual(result.responses, [{ responseSeq: 4, configuredModelId: "requested-a", providerReportedModelId: null, evidence: "upstream_identity_unavailable" }]);
  assert.equal(JSON.stringify(result).includes("private response"), false);
});

test("provider responseModel survives while another response remains unknown", () => {
  const result = collectModelIdentity([assistant(2, "old", "old-upstream"), assistant(8, "requested-a"), assistant(11, "requested-b", "provider-b")], 7);
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.responses.map((row) => row.providerReportedModelId), [null, "provider-b"]);
  assert.deepEqual(result.responses.map((row) => row.configuredModelId), ["requested-a", "requested-b"]);
});

test("adapter normalization rejects raw provider details and invalid identities", () => {
  const normalized = normalizeModelIdentity({ coverage: "reported", secret: "never forward", responses: [
    { responseSeq: 7, configuredModelId: "requested-b", providerReportedModelId: "provider-b", prompt: "private prompt" },
  ] });
  assert.equal(normalized.coverage, "reported");
  assert.equal(JSON.stringify(normalized).includes("private"), false);
  assert.deepEqual(normalizeModelIdentity({ responses: [{ responseSeq: 1, providerReportedModelId: "bad\nvalue" }] }), { coverage: "unavailable", responses: [] });
  assert.deepEqual(normalizeModelIdentity({ responses: [{ responseSeq: 1 }, { responseSeq: 1 }] }), { coverage: "unavailable", responses: [] });
});

test("no assistant message or invalid cursor never fabricates identity", () => {
  assert.deepEqual(collectModelIdentity([{ seq: 3, type: "assistant/chunk", data: { chunk: { model: "untrusted" } } }]), { coverage: "unavailable", responses: [] });
  const wrongReplay = assistant(4, "requested", "provider");
  wrongReplay.data.message.source.replayState.response.model = "other-request";
  assert.equal(collectModelIdentity([wrongReplay]).responses[0].providerReportedModelId, null);
  const topLevel = assistant(5, "requested");
  topLevel.data.message.responseModel = "untrusted";
  assert.equal(collectModelIdentity([topLevel]).responses[0].providerReportedModelId, null);
  assert.throws(() => collectModelIdentity([], -1), TypeError);
});
