import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForClose(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not exit")), timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("chat rate limit is 35 per authenticated account, independent of shared client IP", { timeout: 30_000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-chat-rate-account-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const shutdownToken = `fixture-${crypto.randomBytes(16).toString("hex")}`;
  const masterKeyFile = path.join(temp, "master.key");
  let storage, child;
  const tokens = [];
  const workspacePaths = [];
  let output = "";
  try {
    storage = await createStorage({ dataDir: path.join(temp, "db"), masterKeyFile });
    for (let i = 0; i < 2; i++) {
      const registered = await storage.repositories.auth.register({ username: `rate-account-${crypto.randomUUID()}`, password: "FixturePass123" });
      assert.equal(registered.ok, true);
      const user = registered.user;
      const token = crypto.randomBytes(32).toString("hex");
      tokens.push(token);
      await storage.db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [
        user.id, crypto.createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 120_000).toISOString(),
      ]);
      workspacePaths.push(path.join(root, "shell/runtime/workspaces", user.tenant_id), path.join(root, "shell/runtime/workspaces", `ws_${user.tenant_id}`));
    }
    assert.ok(workspacePaths.every((entry) => !fs.existsSync(entry)), "fixture workspace paths must not pre-exist");
    await storage.close(); storage = null;

    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin", HOME: path.join(temp, "home"), TMPDIR: path.join(temp, "tmp"),
      LANG: "C", PT_DB_DIR: path.join(temp, "db"), PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, "logs"), PT_SHELL_PORT: String(port), PT_LISTEN_HOST: "127.0.0.1",
      PT_TEST_SHUTDOWN_TOKEN: shutdownToken, PT_KEY_LIVE_VERIFY: "0", PT_HEARTBEAT_ENABLED: "0",
    };
    for (const name of ["HOME", "TMPDIR", "PT_LOG_DIR"]) fs.mkdirSync(env[name], { recursive: true });
    child = spawn(process.execPath, ["shell/server.cjs", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try { if ((await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* wait for the fixture listener */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, `fixture server did not start: ${output.slice(-2000)}`);

    const send = async (token) => {
      const response = await fetch(origin + "/api/chat", { method: "POST", headers: { Cookie: `pt_session=${token}` } });
      await response.arrayBuffer();
      return response.status;
    };
    for (let i = 0; i < 35; i++) assert.equal(await send(tokens[0]), 400, `request ${i + 1} should pass account limiter and fail chat validation`);
    assert.equal(await send(tokens[0]), 429, "the 36th request by the same account is limited");
    assert.equal(await send(tokens[1]), 400, "another account behind the same loopback IP has a separate quota");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { await fetch(origin + "/__test_shutdown", { method: "POST", headers: { "x-shutdown-token": shutdownToken }, signal: AbortSignal.timeout(1500) }); } catch { child.kill("SIGTERM"); }
      await waitForClose(child).catch(() => child.kill("SIGKILL"));
    }
    await storage?.close().catch(() => {});
    for (const entry of workspacePaths) fs.rmSync(entry, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
