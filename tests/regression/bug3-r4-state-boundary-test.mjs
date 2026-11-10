import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createWorkspaceMetaStore } = await import(path.join(root, "business/attribution/import/workspace-meta.js"));

test("State Boundary 1: firstConnectedAt immutability across independent store instances", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-state-test-1-"));
  try {
    const a = createWorkspaceMetaStore({ storageDir: dir });
    const b = createWorkspaceMetaStore({ storageDir: dir });
    a.save({ workspaceId: "fixture", firstConnectedAt: null, updatedAt: null });
    assert.equal(a.load("fixture").firstConnectedAt, null);

    b.markFirstConnected("fixture", "2026-11-09T00:00:00.000Z");
    a.markFirstConnected("fixture", "2026-11-09T01:00:00.000Z");

    const reopened = createWorkspaceMetaStore({ storageDir: dir });
    assert.equal(reopened.load("fixture").firstConnectedAt, "2026-11-09T00:00:00.000Z", "Initial stamped timestamp must never be overwritten");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Publication races/crashes now live in workspace-first-publication-test.mjs.
test("State Boundary 3: hasPartial accurately evaluates current turn partial state and runId isolation", () => {
  const app = fs.readFileSync(path.join(root, "shell/public/app.js"), "utf8");
  const match = app.match(/const hasPartial = (Array\.isArray\(obj\.messages\).*);/);
  assert.ok(match, "Production stopped-turn partial label expression required");

  // 1. Current turn stopped with zero output (last msg is user) -> MUST BE FALSE
  const stoppedZeroOutput = { messages: [
    { role: "user", text: "prior question" }, { role: "assistant", text: "prior completed answer" },
    { role: "user", text: "new question stopped before output" },
  ] };
  assert.equal(vm.runInNewContext(match[1], { obj: stoppedZeroOutput }), false);

  // 2. Current turn stopped with partial text matching runId -> MUST BE TRUE
  const stoppedWithPartial = { messages: [
    { role: "user", text: "prior question" }, { role: "assistant", text: "prior completed answer" },
    { role: "user", text: "new question" }, { role: "assistant", text: "half output", partial: true, runId: "run-cur" },
  ] };
  assert.equal(vm.runInNewContext(match[1], { runId: "run-cur", obj: stoppedWithPartial }), true);

  // 3. Last historical partial belongs to different old runId -> MUST BE FALSE (prevents cross-run pollution)
  const oldRunPartial = { messages: [
    { role: "user", text: "old question" },
    { role: "assistant", text: "old partial", partial: true, runId: "run-old" },
  ] };
  assert.equal(vm.runInNewContext(match[1], { runId: "run-cur", obj: oldRunPartial }), false);

  // 4. Prior turn had partial, but current turn stopped with zero output -> MUST BE FALSE
  const priorPartialCurrentZero = { messages: [
    { role: "user", text: "old question" }, { role: "assistant", text: "old partial", partial: true },
    { role: "user", text: "brand new question stopped with 0 output" },
  ] };
  assert.equal(vm.runInNewContext(match[1], { obj: priorPartialCurrentZero }), false);

  // 5. Completed full turn (not stopped partial) -> MUST BE FALSE
  const completeTurn = { messages: [
    { role: "user", text: "question" }, { role: "assistant", text: "full completed answer" },
  ] };
  assert.equal(vm.runInNewContext(match[1], { obj: completeTurn }), false);
});

test("State Boundary 4: bizLoadSchedule truthfully surfaces 503 errors and only displays uninitialized on confirmed empty data", async () => {
  const app = fs.readFileSync(path.join(root, "shell/public/app.js"), "utf8");
  const start = app.indexOf("async function bizLoadSchedule()");
  const end = app.indexOf("\n$(\"#scheduleUpload\")", start);
  assert.ok(start >= 0 && end > start);

  // Scenario 4A: 503 Service Unavailable -> Must display failure, NEVER "尚未接通" or "还没有上传记录"
  {
    const nodes = Object.fromEntries(["#scheduleStatus", "#scheduleConnected", "#scheduleHistory"].map(key =>
      [key, { textContent: "", replaceChildren() {} }]));
    await vm.runInNewContext(app.slice(start, end) + ";bizLoadSchedule()", {
      bizScheduleRequest: 0, bizImportApi: "/fixture", bizMock: false,
      $: selector => nodes[selector],
      bizRead: async () => { throw Object.assign(Error("Synthetic unavailable"), { status: 503 }); },
    });
    assert.equal(nodes["#scheduleConnected"].textContent.includes("尚未接通（待首次导入）"), false, "Must not disguise 503 as not connected");
    assert.ok(nodes["#scheduleConnected"].textContent.includes("无法读取首次接通时间"));
    assert.ok(nodes["#scheduleConnected"].textContent.includes("503"));
    assert.equal(nodes["#scheduleStatus"].textContent.includes("还没有上传记录"), false, "Must not disguise 503 as empty record");
    assert.ok(nodes["#scheduleStatus"].textContent.includes("调度与上传记录查询失败"));
    assert.ok(nodes["#scheduleStatus"].textContent.includes("503"));
  }

  // Scenario 4B: Confirmed 200 OK with empty jobs -> Truthfully displays uninitialized
  {
    const nodes = Object.fromEntries(["#scheduleStatus", "#scheduleConnected", "#scheduleHistory"].map(key =>
      [key, { textContent: "", replaceChildren() {} }]));
    await vm.runInNewContext(app.slice(start, end) + ";bizLoadSchedule()", {
      bizScheduleRequest: 0, bizImportApi: "/fixture", bizMock: false,
      $: selector => nodes[selector],
      bizRead: async (url) => {
        if (url.endsWith("/jobs")) return { data: { jobs: [] } };
        if (url.endsWith("/workspace")) return { data: { workspace: { firstConnectedAt: null } } };
        return { data: {} };
      },
      fmtTime: () => null,
      bizTable: () => {},
    });
    assert.ok(nodes["#scheduleConnected"].textContent.includes("尚未接通"));
    assert.ok(nodes["#scheduleStatus"].textContent.includes("还没有上传记录"));
  }
});

