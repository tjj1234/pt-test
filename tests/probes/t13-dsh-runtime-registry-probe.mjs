/**
 * T13 fail-closed runtime observability probe.
 * Boots the real CLI with a freshly generated product profile, without sending
 * a task, model request, or tool call. DSH currently exposes runner-ready but
 * no authoritative live agent/plugin registry frame to the parent process.
 * Exit 2 means the runtime registry assertion is blocked, never passed.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "shell/package.json"));
const { makeProfile, findDshEntry } = require(path.join(root, "shell/runtime/dsh-adapter.cjs"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t13-registry-probe-"));
const home = path.join(fs.realpathSync(tmp), "dsh-home");
const dshHomeEnv = { ...process.env, DSH_HOME: home, PT_DASH_INTERNAL_KEY: "", DASH_PORT: "0" };
let child;

function finish(status, details, code) {
  process.stdout.write(`${JSON.stringify({ probe: "T13_DSH_RUNTIME_REGISTRY", status, ...details }, null, 2)}\n`);
  process.exitCode = code;
}

try {
  const verified = findDshEntry();
  if (!verified.js) throw new Error(`verified DSH entry unavailable: ${verified.code || "unknown"}`);
  const generated = makeProfile(home, path.join(root, "shell/dsh-settings.yaml"), path.join(root, "shell/persistent-runner.mjs"));
  const manifestFile = path.join(generated.dir, "northstar-profile-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const manifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex");
  if (!manifest.files || !Object.hasOwn(manifest.files, "cordis.patch.yml") || !Object.hasOwn(manifest.files, "package.json")) {
    throw new Error("generated current product profile manifest does not bind both patch and dependency contract");
  }
  if (generated.name !== "run-persistent" || path.resolve(generated.dir) !== path.resolve(home, "profiles", "run-persistent")) {
    throw new Error(`unexpected generated product profile identity: ${generated.name} ${generated.dir}`);
  }
  const dump = spawnSync(process.execPath, [verified.js, "--profile", "run-persistent", "--dump-config"], {
    cwd: root, env: dshHomeEnv, encoding: "utf8", timeout: 15000,
  });
  if (dump.error || dump.status !== 0) throw new Error(`DSH effective-profile dump failed: ${dump.error?.message || dump.stderr || dump.status}`);
  if (!dump.stdout.includes("tool-skill") || !dump.stdout.includes("disabled: true")) {
    throw new Error(`effective DSH profile dump did not expose the expected product deny row: ${dump.stdout.slice(0, 1600)}`);
  }

  child = spawn(process.execPath, [verified.js, "--profile", "run-persistent"], {
    cwd: root, env: dshHomeEnv, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const frames = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      try { const frame = JSON.parse(line); if (frame && typeof frame.type === "string") frames.push(frame); } catch { /* non-protocol startup output */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !frames.some((frame) => frame.type === "ready" && frame.runner === "persistent-runner")) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const ready = frames.find((frame) => frame.type === "ready" && frame.runner === "persistent-runner");
  if (!ready) throw new Error(`real DSH boot did not reach product runner ready; exit=${child.exitCode}; stderr=${stderr}`);
  const registryFrames = frames.filter((frame) => frame.type === "registry" || frame.type === "agent_registry" || frame.type === "plugin_registry");
  const registryEvidence = registryFrames.some((frame) => {
    const entries = frame.plugins || frame.agents || frame.registry;
    return Array.isArray(entries) && entries.every((entry) => entry && typeof entry.id === "string");
  });
  if (!registryEvidence) {
    finish("BLOCKED_UNOBSERVABLE", {
      profile: generated.name,
      profileManifestFileSha256: manifestSha256,
      dshEntry: verified.js,
      effectiveProfileDumpContainsExpectedProductDenyRow: true,
      realDshRunnerReady: true,
      registryAssertion: "not evaluated: DSH CLI exposes no authoritative live agent/plugin registry evidence on the runner protocol",
      observedFrameTypes: [...new Set(frames.map((frame) => frame.type))].sort(),
      modelCalls: 0,
      toolCalls: 0,
    }, 2);
  } else {
    const entries = registryFrames.flatMap((frame) => frame.plugins || frame.agents || frame.registry);
    if (entries.some((entry) => entry.id === "tool-skill")) {
      finish("FAIL_SKILL_PRESENT", { profile: generated.name, observedFrameTypes: [...new Set(frames.map((frame) => frame.type))].sort() }, 1);
    } else {
      finish("PASS_RUNTIME_REGISTRY_NO_TOOL_SKILL", { profile: generated.name, observedFrameTypes: [...new Set(frames.map((frame) => frame.type))].sort() }, 0);
    }
  }
} catch (error) {
  finish("FAIL_PROBE", { reason: String(error?.message || error) }, 1);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
