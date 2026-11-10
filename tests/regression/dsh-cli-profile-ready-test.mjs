/** Controlled boot of the real DSH CLI and temporary run-persistent profile. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "shell/package.json"));
const dshEntry = require.resolve("@deepseek-ai/dsh/lib/bin.js");
const { makeProfile, findDshEntry } = require(path.join(root, "shell/runtime/dsh-adapter.cjs"));
const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("real DSH CLI boots isolated run-persistent profile and reaches runner ready without model calls", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-dsh-cli-ready-"));
  const verified = findDshEntry();
  assert.equal(verified.js, dshEntry, "real CLI boot must use the release-verified entry");
  assert.equal(verified.installation.packageFileCount, 20);
  assert.match(verified.installation.manifestSha256, /^[a-f0-9]{64}$/);
  const dshHome = path.join(tmp, "dsh");
  makeProfile(dshHome, path.join(root, "shell/dsh-settings.yaml"), path.join(root, "shell/persistent-runner.mjs"));
  const profile = path.join(dshHome, "profiles", "run-persistent");
  assert.equal(fs.existsSync(path.join(profile, "node_modules")), false,
    "boot must resolve the shipped installation without a fixture-injected dependency tree");
  const child = spawn(process.execPath, [dshEntry, "--profile", "run-persistent"], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, PT_DASH_INTERNAL_KEY: "", DASH_PORT: "0" },
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

  let buffer = "",startup="";
  let stderr = "";
  const frames = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    startup+=chunk;buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      try { const frame = JSON.parse(line); if (frame && frame.type) frames.push(frame); } catch { /* startup text is not a JSONL runner frame */ }
    }
  });
  try{await waitFor(() => frames.some((frame) => frame.type === "ready" && frame.runner === "persistent-runner")||child.exitCode!==null, "runner ready");if(!frames.some(f=>f.type==='ready'))throw Error('CLI exited before ready');}
  catch(error){const diagnostics=(stderr+'\n'+startup).split('\n').filter(line=>/error|Error|not found|Cannot|duplicate|failed|Failed|pending|\[E\]|missing|未知|失败|未找到/i.test(line)&&!/api.?key|Authorization|Bearer|token|secret|password/i.test(line)).slice(-12).join('\n');throw Error(error.message+'; exit='+child.exitCode+'; '+diagnostics+'; '+JSON.stringify(frames.filter(f=>f.type==='setup_diagnostic')));}

  const ready = frames.find((frame) => frame.type === "ready");
  assert.equal(ready.protocolVersion, 1);
  assert.ok(Array.isArray(ready.capabilities));
  for (const capability of ["task-v1", "tool-rpc-v1", "abort-v1"]) {
    assert.ok(ready.capabilities.includes(capability), `missing runner capability: ${capability}`);
  }
  assert.equal(child.exitCode, null, `CLI exited after ready (${child.exitCode}); stderr=${stderr}; frames=${JSON.stringify(frames)}`);
  assert.equal(stderr.includes("ERR_MODULE_NOT_FOUND"), false, stderr);
  assert.equal(frames.some((frame) => frame.type === "done" || frame.type === "tool_request"), false, "no task was sent, so no model/tool call can be made");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, "CLI remains alive after ready while idle");
  assert.equal(child.signalCode, null, "CLI must not have been terminated by a signal while idle");
});
