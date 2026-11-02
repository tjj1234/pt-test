import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createStorage } = require("../../shell/storage/index.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test("real local /api/chat disconnect and same-key replay execute the fake runner once", { timeout: 45000 }, async (t) => {
  assert.equal(
    Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]),
    false,
    "fixture must use isolated local PGlite",
  );

  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-t03-chat-http-replay-"));
  const runtimeDir = path.join(temp, "runtime");
  const dbDir = path.join(temp, "db");
  const masterKeyFile = path.join(temp, "master-key");
  const recordFile = path.join(temp, "fake-runner.jsonl");
  const startedFile = path.join(temp, "runner-started");
  const releaseFile = path.join(temp, "runner-release");
  const diagnosticStartedFile = path.join(temp, "diagnostic-runner-started");
  const diagnosticReleaseFile = path.join(temp, "diagnostic-runner-release");
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const preload = path.join(temp, "fixtures.cjs");
  const cookieTokens = [];
  let storage;
  let child;
  let output = "";

  const stop = async () => {
    if (!child || child.exitCode !== null) { child = null; return; }
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await Promise.race([closed, delay(8000)]);
    if (child && child.exitCode === null) {
      const killed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await killed;
    }
    child = null;
  };

  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({
      username: "t03-chat-http-" + Date.now(),
      email: "t03-chat-http@example.test",
      password: "FixtureReview123",
    });
    assert.equal(registered.ok, true);
    const user = registered.user;
    const cookieToken = crypto.randomBytes(32).toString("hex");
    await storage.db.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
      [user.id, crypto.createHash("sha256").update(cookieToken).digest("hex"), new Date(Date.now() + 120000).toISOString()],
    );
    cookieTokens.push("pt_session=" + cookieToken);
    await storage.close();
    storage = null;

    fs.writeFileSync(preload, `const Module=require("node:module"),fs=require("node:fs");const load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>['fixture-http-chat']};
if(parent?.filename.endsWith("/server.cjs")&&name==="./model-catalog.cjs")return {...loaded,getCatalog:async()=>({models:[{id:"fixture-http-chat",name:"Fixture HTTP Chat",chat:true,capabilityStatus:"supported",runtimeStatus:"verified",availability:"present",permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:["text"]},outputModalities:{value:["text"]},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:"available",modelIds:["fixture-http-chat"]},syncedAt:Date.now()}),routeModelFor:()=>"fixture-http-chat",pickDefaultModel:()=>"fixture-http-chat"};
if(parent?.filename.endsWith("/server.cjs")&&name==="./tenant.cjs")return {...loaded,runDshForUser:async(uid,question,opts)=>{fs.appendFileSync(${JSON.stringify(recordFile)},JSON.stringify({uid,question,model:opts.model})+"\\n");if(question.includes("diagnostic")){fs.writeFileSync(${JSON.stringify(diagnosticStartedFile)},"started");for(let i=0;i<1000&&!fs.existsSync(${JSON.stringify(diagnosticReleaseFile)});i++)await new Promise(r=>setTimeout(r,10));if(!fs.existsSync(${JSON.stringify(diagnosticReleaseFile)}))throw new Error("diagnostic runner release timeout");return {ok:false,code:"AGENT_TURN_ABORTED",error:"Agent turn aborted by the runtime or upstream service; diagnostic details were withheld",text:"",steps:[]};}fs.writeFileSync(${JSON.stringify(startedFile)},"started");for(let i=0;i<1000&&!fs.existsSync(${JSON.stringify(releaseFile)});i++)await new Promise(r=>setTimeout(r,10));if(!fs.existsSync(${JSON.stringify(releaseFile)}))throw new Error("fake runner release timeout");return {ok:true,text:"local fake runner reply",steps:[]};}};
return loaded;};`);

    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      PT_RUNTIME_DIR: runtimeDir,
      PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile,
      PT_LOG_DIR: path.join(temp, "logs"),
      PT_SHELL_PORT: String(port),
      PT_LISTEN_HOST: "127.0.0.1",
      PT_KEY_LIVE_VERIFY: "0",
      PT_RUNS_GLOBAL: "1",
    };

    const start = async () => {
      output = "";
      child = spawn(process.execPath, ["--require", preload, "shell/server.cjs", "--port", String(port)], {
        cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
      child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
      for (let i = 0; i < 180; i++) {
        if (child.exitCode !== null) throw new Error("server exited during startup:\n" + output);
        try {
          const response = await fetch(origin + "/api/auth/me", { headers: { Cookie: cookieTokens[0] } });
          if (response.status === 200) return;
        } catch {}
        await delay(50);
      }
      throw new Error("server did not become ready:\n" + output);
    };

    const request = async (route, { method = "GET", body, key } = {}) => fetch(origin + route, {
      method,
      headers: {
        Cookie: cookieTokens[0],
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = async (route, options) => {
      const response = await request(route, options);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };

    await start();
    const savedKey = await json("/api/auth/key", { method: "POST", body: { key: "fixture-key-never-sent-to-provider" } });
    assert.equal(savedKey.ok, true);
    const conversation = await json("/api/conversations", { method: "POST", body: {} });
    const conversationId = conversation.id || conversation.conversation?.id;
    assert.ok(conversationId, "the real conversation route must return an ID");
    const selected = await json("/api/models/select", { method: "POST", body: { model: "fixture-http-chat" } });
    assert.equal(selected.model, "fixture-http-chat");

    const body = JSON.stringify({ conversationId, message: "controlled local retry fixture" });
    const idempotencyKey = "t03-http-lost-ack-same-key";
    const firstAttempt = await new Promise((resolve, reject) => {
      const req = http.request(origin + "/api/chat", {
        method: "POST",
        headers: {
          Cookie: cookieTokens[0],
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Idempotency-Key": idempotencyKey,
        },
      }, (response) => {
        const acknowledgement = { status: response.statusCode, runId: response.headers["x-agent-run-id"] };
        // Cut the SSE response after headers, as a disconnected local client would.
        response.on("error", () => {});
        response.destroy();
        resolve(acknowledgement);
      });
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(firstAttempt.status, 200);
    assert.ok(firstAttempt.runId, "the first accepted request must expose its durable Run ID");
    const recoveredByKey = await json("/api/runs/by-idempotency-key", { key: idempotencyKey });
    assert.equal(recoveredByKey.runId, firstAttempt.runId, "authorized key lookup recovers the durable Run without request-body persistence");
    assert.equal(recoveredByKey.conversationId, conversationId);
    for (let i = 0; i < 200 && !fs.existsSync(startedFile); i++) await delay(10);
    assert.ok(fs.existsSync(startedFile), "the fake runner must have started before replay");
    assert.equal(fs.readFileSync(recordFile, "utf8").trim().split("\n").length, 1);

    const replayResponse = await request("/api/chat", {
      method: "POST",
      body: { conversationId, message: "controlled local retry fixture" },
      key: idempotencyKey,
    });
    assert.equal(replayResponse.status, 200);
    const replayRunId = replayResponse.headers.get("x-agent-run-id");
    assert.equal(replayRunId, firstAttempt.runId, "same-key replay must attach to the same durable Run");
    assert.equal(fs.readFileSync(recordFile, "utf8").trim().split("\n").length, 1, "replay must not start a second fake runner");

    fs.writeFileSync(releaseFile, "release");
    const replayFrames = await replayResponse.text();
    assert.match(replayFrames, /"done":true/);
    assert.match(replayFrames, /local fake runner reply/);
    const runDetail = await json("/api/runs/" + encodeURIComponent(replayRunId));
    assert.equal(runDetail.run.state, "completed");
    assert.equal(fs.readFileSync(recordFile, "utf8").trim().split("\n").length, 1);
    const history = await json("/api/conversations/" + encodeURIComponent(conversationId));
    assert.equal(history.conversation.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(history.conversation.messages.filter((message) => message.role === "assistant").length, 1);

    const diagnosticBody = JSON.stringify({ conversationId, message: "controlled local diagnostic fixture" });
    const diagnosticKey = "t03-http-diagnostic-same-key";
    const diagnosticAttempt = await new Promise((resolve, reject) => {
      const req = http.request(origin + "/api/chat", {
        method: "POST",
        headers: {
          Cookie: cookieTokens[0],
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(diagnosticBody),
          "Idempotency-Key": diagnosticKey,
        },
      }, (response) => {
        const acknowledgement = { status: response.statusCode, runId: response.headers["x-agent-run-id"] };
        response.on("error", () => {});
        response.destroy();
        resolve(acknowledgement);
      });
      req.on("error", reject);
      req.end(diagnosticBody);
    });
    assert.equal(diagnosticAttempt.status, 200);
    assert.ok(diagnosticAttempt.runId);
    for (let i = 0; i < 200 && !fs.existsSync(diagnosticStartedFile); i++) await delay(10);
    assert.ok(fs.existsSync(diagnosticStartedFile), "diagnostic fake runner must be waiting before replay");
    assert.equal(fs.readFileSync(recordFile, "utf8").trim().split("\n").length, 2);

    const diagnosticReplay = await request("/api/chat", {
      method: "POST",
      body: { conversationId, message: "controlled local diagnostic fixture" },
      key: diagnosticKey,
    });
    assert.equal(diagnosticReplay.status, 200);
    assert.equal(diagnosticReplay.headers.get("x-agent-run-id"), diagnosticAttempt.runId);
    fs.writeFileSync(diagnosticReleaseFile, "release");
    const diagnosticFrames = await diagnosticReplay.text();
    const diagnosticDone = diagnosticFrames.split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).find(frame => frame.done === true);
    assert.ok(diagnosticDone, "same-key replay must return a terminal failure frame");
    assert.equal(diagnosticDone.ok, false);
    assert.equal(diagnosticDone.code, "AGENT_TURN_ABORTED");
    assert.equal(diagnosticDone.error, "Agent turn aborted by the runtime or upstream service; diagnostic details were withheld");
    const diagnosticEvents = await json("/api/runs/" + encodeURIComponent(diagnosticAttempt.runId) + "/events");
    const persistedDone = diagnosticEvents.events.find(event => event.type === "done");
    assert.equal(persistedDone?.payload?.code, "AGENT_TURN_ABORTED");
    assert.equal(persistedDone?.payload?.error, diagnosticDone.error);
    const failedRun = await json("/api/runs/" + encodeURIComponent(diagnosticAttempt.runId));
    assert.equal(failedRun.run.state, "failed");
    assert.equal(fs.readFileSync(recordFile, "utf8").trim().split("\n").length, 2, "same-key failed replay must not start a second runner");
  } finally {
    fs.writeFileSync(releaseFile, "release");
    fs.writeFileSync(diagnosticReleaseFile, "release");
    await stop();
    await storage?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

