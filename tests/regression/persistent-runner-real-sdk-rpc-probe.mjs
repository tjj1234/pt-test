/**
 * Controlled integration probe for the actual DSH CLI/SDK profile and shipped
 * persistent-runner. No HTTP server, credentials, network, or paid model calls.
 * Run: node --test tests/regression/persistent-runner-real-sdk-rpc-probe.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const waitFor = async (predicate, label, timeoutMs = 12000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const sdkHarness = String.raw`
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(path.join(process.env.NORTHSTAR_ROOT, "shell/package.json"));
const load = async (name) => import(pathToFileURL(require.resolve(name)));
const [{ Context }, { default: Agents }, { default: Sessions }, { default: Llm, LlmAdapter, CallId }, { default: Prompt }, { default: Tools }, { default: Loop }] = await Promise.all([
  "@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-agent-loop",
].map(load));
const ctx = new Context();
const fibers = [];
for (const [plugin, config] of [[Agents, undefined], [Sessions, undefined], [Llm, undefined], [Prompt, {}], [Tools, {}], [Loop, { agents: [] }]]) {
  const fiber = ctx.plugin(plugin, ...(config === undefined ? [] : [config])); fibers.push(fiber); await fiber;
}
ctx.provide("loader", { await: async () => {} });
ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "controlled", model: "initial-model" }) });
ctx.provide("persistentRunnerExecutors", {
  gaQuery: async (_args, { tenantId }) => ({ reportId: "report-" + tenantId, tenantId, source: "fixture" }),
});
ctx.provide("appExit", (code) => process.exit(code));
const logFile = process.env.NORTHSTAR_CONTROLLED_LLM_LOG;
const record = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
class ControlledAdapter extends LlmAdapter {
  async *stream(options) {
    const sid = String(options.sessionId), model = String(options.model);
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const text = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b && b.type === "text").map(b => b.text).join("\n");
    const counts = globalThis.__northstarCounts ||= new Map();
    const n = Number(counts.get(sid) || 0) + 1; counts.set(sid, n);
    record({ sessionId: sid, model, n, text });
    const block = { type: "block-start", index: 0 };
    const endBlock = (value) => ({ type: "block-end", index: 0, block: value });
    let answer;
    if (text.includes("hot-switch")) answer = { type: "text", text: "hot model " + model };
    else if (n === 1) answer = { type: "tool-call", id: CallId("media-" + sid), name: "media_route", arguments: { taskType: "text2image", prompt: "fixture " + sid } };
    else if (n === 2) answer = { type: "tool-call", id: CallId("report-" + sid), name: "ga_query", arguments: { metrics: ["sessions"], dateRange: { startDate: "2026-10-01", endDate: "2026-10-02" } } };
    else answer = { type: "text", text: "completed " + sid + " with " + model };
    yield { ...block, blockType: answer.type }; yield endBlock(answer);
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    yield { type: "finish", reason: { kind: answer.type === "tool-call" ? "tool-calls" : "stop" } };
  }
}
ctx.llm.registerAdapter(["controlled"], new ControlledAdapter());
const runnerPath = path.join(process.env.NORTHSTAR_RUNNER_PROFILE, "persistent-runner.mjs");
const { apply } = await import(pathToFileURL(runnerPath));
apply(ctx);
`;

test("real DSH SDK and persistent-runner isolate sessions across parent RPC and hot model changes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-real-runner-rpc-"));
  const dshHome = path.join(tmp, "dsh");
  const profile = path.join(dshHome, "profiles", "run-persistent");
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(path.join(root, "shell/node_modules"), path.join(profile, "node_modules"), "dir");
  fs.writeFileSync(path.join(profile, "persistent-runner.mjs"), fs.readFileSync(path.join(root, "shell/persistent-runner.mjs")));
  fs.copyFileSync(path.join(root, "shell/tasks/budget.cjs"), path.join(profile, "budget.cjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/usage.cjs"), path.join(profile, "usage.cjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/native-image-message.mjs"), path.join(profile, "native-image-message.mjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/dsh-native-context-r4-candidate.mjs"), path.join(profile, "dsh-native-context-r4-candidate.mjs"));
  fs.copyFileSync(path.join(root, "shell/runtime/published-skill-provider.mjs"), path.join(profile, "published-skill-provider.mjs"));
  fs.copyFileSync(path.join(root, "shell/skills/release-snapshot.cjs"), path.join(profile, "skill-release-snapshot.cjs"));
  fs.writeFileSync(path.join(profile, "run-budget.json"), JSON.stringify({ maxDurationMs: 15000, maxModelCalls: 8, maxToolCalls: 8, maxToolCallsPerKey: 4, maxRetries: 0 }));
  fs.copyFileSync(path.join(root, "business/media/presets.cjs"), path.join(profile, "presets.cjs"));
  fs.copyFileSync(path.join(root, "business/attribution/ga-connector/executor.js"), path.join(profile, "ga-query-executor.cjs"));
  const llmLog = path.join(tmp, "llm.jsonl");
  fs.writeFileSync(llmLog, "");

  const child = spawn(process.execPath, ["--input-type=module", "-e", sdkHarness], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, NORTHSTAR_ROOT: root, NORTHSTAR_RUNNER_PROFILE: profile, NORTHSTAR_CONTROLLED_LLM_LOG: llmLog, PT_DASH_INTERNAL_KEY: "", DASH_PORT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const frames = [];
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    let idx;
    while ((idx = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, idx).trim(); output = output.slice(idx + 1);
      try { const frame = JSON.parse(line); if (frame && frame.type) frames.push(frame); } catch { /* DSH startup notices are not runner frames. */ }
    }
  });
  const send = (frame) => child.stdin.write(JSON.stringify({ ...frame, protocolVersion: 1 }) + "\n");
  const rpc = (sid, name) => frames.find((frame) => frame.type === "tool_request" && frame.sessionId === sid && frame.name === name);
  const done = (sid) => frames.find((frame) => frame.type === "done" && frame.sessionId === sid);
  const llmCalls = () => fs.readFileSync(llmLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

  try {
    await waitFor(() => frames.some((frame) => frame.type === "ready"), "real runner ready");
    send({ type: "task", sessionId: "A", tenantId: "tenant-A", provider: "controlled", model: "model-a", task: "A first request" });
    send({ type: "task", sessionId: "B", tenantId: "tenant-B", provider: "controlled", model: "model-b", task: "B first request" });
    await waitFor(() => rpc("A", "media.route") && rpc("B", "media.route"), "both real SDK sessions request media RPC");

    // Hold A's host tool call. B's media result, local injected report executor,
    // and follow-up model request must all complete through the real runner.
    const requestB = rpc("B", "media.route");
    send({ type: "tool_response", sessionId: "B", requestId: requestB.requestId, ok: true,
      result: { taskType: "text2image", label: "fixture", model: "media-model-B", provider: "controlled", kind: "image", url: "/api/run-media/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.jpg", elapsedMs: 1,
        managed: { rel: "media-results/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.jpg", mime: "image/jpeg", size: 123, sha256: "a".repeat(64) } } });
    await waitFor(() => frames.some((frame) => frame.type === "step" && frame.sessionId === "B" && frame.name === "ga_query" && frame.phase === "call"), "B real SDK requests report executor");
    await waitFor(() => done("B"), "B completes while A media RPC remains unresolved");
    const doneB = done("B");
    assert.equal(doneB.ok, true);
    assert.equal(doneB.budget.snapshot.toolCalls, 2, "host tools must not be counted twice by the native gate");
    assert.equal(doneB.budget.snapshot.modelCalls, 3);
    assert.match(doneB.text, /completed session-B with model-b/);
    assert.deepEqual(doneB.media, [{ type: "image", url: "/api/run-media/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.jpg" }]);
    assert.deepEqual(doneB.report, [{ reportId: "report-tenant-B", tenantId: "tenant-B", source: "fixture" }]);
    assert.equal(done("A"), undefined, "A remains pending while B is complete");

    const aMedia = rpc("A", "media.route");
    send({ type: "abort", sessionId: "A" });
    await waitFor(() => frames.some((frame) => frame.type === "aborted" && frame.sessionId === "A"), "A cancellation acknowledgement");
    await waitFor(() => done("A"), "A canceled turn drains");
    assert.equal(frames.some((frame) => frame.type === "aborted" && frame.sessionId === "A"), true);
    assert.equal(done("A").media || null, null, "aborted A has no unowned media result");

    // Same DSH session identity remains warm; only its next task changes model.
    send({ type: "task", sessionId: "B", tenantId: "tenant-B", provider: "controlled", model: "model-hot", task: "hot-switch model request" });
    await waitFor(() => frames.filter((frame) => frame.type === "done" && frame.sessionId === "B").length === 2, "B hot-switch task completion");
    const bCalls = llmCalls().filter((entry) => entry.sessionId.endsWith("B"));
    assert.equal(bCalls.some((entry) => entry.model === "model-b"), true);
    assert.equal(bCalls.some((entry) => entry.model === "model-hot" && entry.text.includes("hot-switch")), true,
      "warm B request must reach the deterministic adapter with the new model");

    const bMediaStep = frames.find((frame) => frame.type === "step" && frame.sessionId === "B" && frame.phase === "result" && frame.name === "media_route");
    assert.equal(bMediaStep.modelName, "media-model-B");
    assert.equal(frames.some((frame) => frame.type === "tool_request" && frame.sessionId === "A" && frame.requestId === aMedia.requestId), true);
    assert.equal(stderr.includes("tenant-A"), false);
    send({ type: "exit" }); child.stdin.end();
    await waitFor(() => frames.some((frame) => frame.type === "bye"), "runner shutdown");
  } catch (error) {
    assert.fail(`${error.message}\nrunner stderr:\n${stderr}\nframes:\n${JSON.stringify(frames, null, 2)}`);
  }
});
