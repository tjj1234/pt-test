import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../shell/public/app.js", import.meta.url), "utf8");
const memorySource = source.slice(0, source.indexOf("/**\n * 某条对话的结果回来了"));
const epochSource = source.match(/^let conversationLoadSequence = 0;$/m)?.[0];
const busySource = source.slice(source.indexOf("function applyComposerState()"), source.indexOf("/** 归档对话只读", source.indexOf("function applyComposerState()")));
const runSource = source.slice(source.indexOf("async function runChat(payload)"), source.indexOf("\nasync function ask(msg)", source.indexOf("async function runChat(payload)")));
assert.ok(epochSource && runSource);

const warning = "历史提示：外部任务状态未确认，需在运行记录中核对；当前状态以运行记录为准。";
const secretTaskId = "provider-task-id-must-stay-private";
const element = () => ({ querySelector: () => null, remove() {}, focus() {}, appendChild() {}, textContent: "" });

function harness(handler) {
  const storage = new Map();
  const visible = [];
  const unread = [];
  const context = vm.createContext({
    document: { querySelector: element, createElement: element },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    window: { crypto: { randomUUID: () => "manual-check-request" } },
    crypto: { randomUUID: () => "manual-check-request" },
    location: { search: "" }, TextDecoder, URLSearchParams, Date, console, modelSelect: null,
    currentModelChat: () => true, thinking: element, formatElapsed: () => "",
    setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => queueMicrotask(fn),
    streamInto() {}, renderMessage() {}, refreshList: async () => {},
    renderChat: () => { visible.length = 0; },
    bubbleSys: (text) => visible.push(text),
    markUnread: (id) => { if (!unread.includes(id)) unread.push(id); },
    pushArtifact() {}, mergeArtifacts() {}, openArtifactPane() {}, showConnecting() {}, showStoppedBar() {},
    stoppedChipText: () => "stopped", needKeyBubble() {}, composerNotice() {},
    fetch: (url, options) => handler(url, options, context),
  });
  vm.runInContext(memorySource + "\n" + epochSource + "\nfunction isViewing(id) { return !!id && state.activeId === id; }\n" + busySource + runSource, context);
  vm.runInContext("state.activeId='A'", context);
  return { context, visible, unread, run: (payload) => context.runChat(payload), view: (id) => vm.runInContext(`state.activeId=${JSON.stringify(id)}`, context) };
}

function streamResponse(frames, onRead = () => {}) {
  let read = 0;
  return {
    headers: { get: (name) => name === "content-type" ? "text/event-stream" : name === "x-agent-run-id" ? "run-A" : null },
    body: { getReader: () => ({ read: async () => {
      if (read >= frames.length) return { done: true };
      onRead(read);
      const value = new TextEncoder().encode(`id: ${read + 1}\ndata: ${JSON.stringify(frames[read])}\n\n`);
      read++;
      return { done: false, value };
    } }) },
  };
}

test("live chat SSE shows a fixed manual-check notice after final history repaint without exposing taskId", async () => {
  const h = harness(async (url) => {
    assert.equal(url, "/api/chat");
    return streamResponse([
      { operationStatus: "manual_check", taskId: secretTaskId },
      { done: true, ok: true, messages: [], turns: 1 },
    ]);
  });
  await h.run({ conversationId: "A", question: "create an image" });
  assert.deepEqual(h.visible, [warning]);
  assert.equal(JSON.stringify(h.visible).includes(secretTaskId), false);
});

test("durable event replay shows only the fixed notice in the same conversation", async () => {
  const h = harness(async (url) => {
    if (url.startsWith("/api/runs/run-A/events?")) return {
      ok: true, json: async () => ({ events: [
        { seq: 1, type: "state", payload: { operationStatus: "manual_check", taskId: secretTaskId } },
        { seq: 2, type: "done", payload: { state: "completed" } },
      ] }),
    };
    if (url === "/api/conversations/A") return { ok: true, json: async () => ({ conversation: { messages: [] } }) };
    throw new Error(`unexpected fetch ${url}`);
  });
  await h.run({ conversationId: "A", resumeRunId: "run-A" });
  assert.deepEqual(h.visible, [warning]);
  assert.equal(JSON.stringify(h.visible).includes(secretTaskId), false);
});

test("manual-check state for conversation A never writes into conversation B", async () => {
  let h;
  h = harness(async (url) => {
    assert.equal(url, "/api/chat");
    return streamResponse([
      { operationStatus: "manual_check", taskId: secretTaskId },
      { done: true, ok: true, messages: [], turns: 1 },
    ], (read) => { if (read === 0) h.view("B"); });
  });
  await h.run({ conversationId: "A", question: "create an image" });
  assert.deepEqual(h.visible, []);
  assert.deepEqual(h.unread, ["A"]);
});

test("manual-check replay for conversation A never writes into conversation B", async () => {
  let h;
  h = harness(async (url) => {
    if (url.startsWith("/api/runs/run-A/events?")) {
      h.view("B");
      return { ok: true, json: async () => ({ events: [
        { seq: 1, type: "state", payload: { operationStatus: "manual_check", taskId: secretTaskId } },
        { seq: 2, type: "done", payload: { state: "completed" } },
      ] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await h.run({ conversationId: "A", resumeRunId: "run-A" });
  assert.deepEqual(h.visible, []);
  assert.deepEqual(h.unread, ["A"]);
  h.view("A");
  h.context.renderChat([]);
  h.context.showManualCheckHistory("A");
  assert.deepEqual(h.visible, [warning], "returning to A restores only its historical notice");
  assert.match(source, /renderChat\(conv && conv\.messages \? conv\.messages : \[\]\);\s*showManualCheckHistory\(id\);/,
    "openConversation must restore the pending notice after loading A's history");
});
