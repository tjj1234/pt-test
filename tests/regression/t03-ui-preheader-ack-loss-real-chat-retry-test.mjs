import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
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
const source = fs.readFileSync(path.join(root, "shell/public/app.js"), "utf8");
const memorySource = source.slice(0, source.indexOf("/**\n * 某条对话的结果回来了"));
const epochSource = source.match(/^let conversationLoadSequence = 0;$/m)?.[0];
const stoppedMessageSource = source.slice(source.indexOf("function stoppedBarText("), source.indexOf("\nfunction stoppedChipText(", source.indexOf("function stoppedBarText(")));
const busySource = source.slice(source.indexOf("function applyComposerState()"), source.indexOf("/** 归档对话只读", source.indexOf("function applyComposerState()")));
const runSource = source.slice(source.indexOf("async function runChat(payload)"), source.indexOf("\nasync function ask(msg)", source.indexOf("async function runChat(payload)")));
assert.ok(epochSource, "production navigation epoch must be included");
assert.ok(runSource.includes('if (new URLSearchParams(location.search || "").get("northstarNoChatRetry") === "1") throw firstError;'), "production runChat must expose the controlled-trial no-retry gate");

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("timed out waiting for " + label);
}

function createUiHarness(fetchImpl) {
  const storage = new Map(), calls = [], rendered = [];
  const element = () => ({ querySelector: () => null, remove() {}, focus() {}, appendChild() {}, textContent: "", className: "", hidden: false });
  const context = vm.createContext({
    document: { querySelector: element, createElement: element },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    window: { crypto: { randomUUID: () => "t03-ui-retry-idempotency-key" } }, location: { search: "" },
    crypto: { randomUUID: () => "t03-ui-retry-idempotency-key" },
    TextDecoder, TextEncoder, URLSearchParams, Date, console, modelSelect: null,
    currentModelChat: () => true, thinking: element, formatElapsed: () => "",
    setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => { queueMicrotask(fn); },
    streamInto: (_element, text) => rendered.push({ kind: "stream", text }),
    renderChat: (messages) => rendered.push({ kind: "chat", messages }),
    renderMessage: (message) => rendered.push({ kind: "message", message }),
    refreshList: async () => {}, markUnread() {},
    pushArtifact() {}, mergeArtifacts() {}, openArtifactPane() {}, showConnecting() {},
    showStoppedBar() {}, stoppedChipText: () => "stopped", needKeyBubble() {}, bubbleSys: (text) => rendered.push({ kind: "error", text }),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET", key: options.headers?.["Idempotency-Key"] || null, body: options.body || null });
      return fetchImpl(url, options);
    },
  });
  vm.runInContext(
    memorySource + "\n" + epochSource + "\n" + stoppedMessageSource
      + "\nfunction isViewing(id) { return !!id && state.activeId === id; }\n"
      + busySource + runSource,
    context,
  );
  vm.runInContext("state.activeId='fixture-conversation'", context);
  return { context, calls, rendered, run: (payload) => context.runChat(payload) };
}

test("UI retries a pre-header connection loss after real /api/chat admission with the same key; fake runner executes once", { timeout: 50000 }, async () => {
  assert.equal(Object.keys(process.env).some((key) => key.startsWith("PT_PG_") && process.env[key]), false,
    "fixture must use isolated local PGlite");
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-t03-ui-http-retry-"));
  const runtimeDir = path.join(temp, "runtime"), dbDir = path.join(temp, "db"), masterKeyFile = path.join(temp, "master-key");
  const fakeRunLog = path.join(temp, "fake-runner.jsonl"), runnerStarted = path.join(temp, "runner-started"), releaseRunner = path.join(temp, "release-runner");
  const port = await freePort(), proxyPort = await freePort();
  const origin = "http://127.0.0.1:" + port, proxyOrigin = "http://127.0.0.1:" + proxyPort;
  const cookie = "pt_session";
  const preload = path.join(temp, "fixtures.cjs");
  let storage, appChild, proxy;
  let appOutput = "";
  let firstUpstreamRunId = null, firstResponseHeld = false, proxyError = null;
  const proxyRecords = [];

  const stopApp = async () => {
    if (!appChild || appChild.exitCode !== null) { appChild = null; return; }
    const done = new Promise((resolve) => appChild.once("close", resolve));
    appChild.kill("SIGTERM");
    await Promise.race([done, delay(6000)]);
    if (appChild && appChild.exitCode === null) {
      const killed = new Promise((resolve) => appChild.once("close", resolve));
      appChild.kill("SIGKILL");
      await killed;
    }
    appChild = null;
  };
  const closeProxy = async () => {
    if (!proxy) return;
    await new Promise((resolve) => proxy.close(resolve));
    proxy = null;
  };

  try {
    storage = await createStorage({ dataDir: dbDir, masterKeyFile });
    const registered = await storage.repositories.auth.register({
      username: "t03-ui-http-" + Date.now(),
      email: "t03-ui-http@example.test",
      password: "FixtureReview123",
    });
    assert.equal(registered.ok, true);
    const token = crypto.randomBytes(32).toString("hex");
    await storage.db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [
      registered.user.id, crypto.createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 120000).toISOString(),
    ]);
    await storage.close(); storage = null;

    fs.writeFileSync(preload, `const Module=require("node:module"),fs=require("node:fs");const load=Module._load;
Module._load=function(name,parent,isMain){const loaded=load.apply(this,arguments);
if(parent?.filename.endsWith('/server.cjs')&&name==='./models/dsh-configured-catalog.cjs')return {...loaded,configuredModels:()=>['fixture-ui-chat']};
if(parent?.filename.endsWith("/server.cjs")&&name==="./model-catalog.cjs")return {...loaded,getCatalog:async()=>({models:[{id:"fixture-ui-chat",name:"Fixture UI Chat",chat:true,capabilityStatus:"supported",runtimeStatus:"verified",availability:"present",permission:true,localPolicy:{enabled:true,tasks:['textChat']},tasks:{textChat:{value:true}},inputModalities:{value:["text"]},outputModalities:{value:["text"]},states:{textChat:{adapted:true,endpointCompatible:true,verified:true,autoEligible:true}}}],availability:{status:"available",modelIds:["fixture-ui-chat"]},syncedAt:Date.now()}),routeModelFor:()=>"fixture-ui-chat",pickDefaultModel:()=>"fixture-ui-chat"};
if(parent?.filename.endsWith("/server.cjs")&&name==="./tenant.cjs")return {...loaded,runDshForUser:async(uid,question,opts)=>{fs.appendFileSync(${JSON.stringify(fakeRunLog)},JSON.stringify({uid,question,model:opts.model})+"\\n");fs.writeFileSync(${JSON.stringify(runnerStarted)},"started");for(let i=0;i<1000&&!fs.existsSync(${JSON.stringify(releaseRunner)});i++)await new Promise(r=>setTimeout(r,10));if(!fs.existsSync(${JSON.stringify(releaseRunner)}))throw new Error("fixture runner release timed out");return {ok:true,text:"fake ui retry reply",steps:[]};}};
return loaded;};`);

    const env = {
      PATH: process.env.PATH, HOME: temp, PT_RUNTIME_DIR: runtimeDir, PT_DB_DIR: dbDir,
      PT_MASTER_KEY_FILE: masterKeyFile, PT_LOG_DIR: path.join(temp, "logs"),
      PT_SHELL_PORT: String(port), PT_LISTEN_HOST: "127.0.0.1", PT_KEY_LIVE_VERIFY: "0", PT_RUNS_GLOBAL: "1",
    };
    appChild = spawn(process.execPath, ["--require", preload, "shell/server.cjs", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    appChild.stdout.on("data", (chunk) => { appOutput = (appOutput + chunk).slice(-6000); });
    appChild.stderr.on("data", (chunk) => { appOutput = (appOutput + chunk).slice(-6000); });
    let ready = false;
    for (let i = 0; i < 180; i++) {
      if (appChild.exitCode !== null) throw new Error("server exited during startup:\n" + appOutput);
      try {
        const response = await fetch(origin + "/api/auth/me", { headers: { Cookie: cookie + "=" + token } });
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await delay(50);
    }
    assert.ok(ready, "real local shell server became ready: " + appOutput);

    const setupRequest = async (route, { method = "GET", body } = {}) => fetch(origin + route, {
      method, headers: { Cookie: cookie + "=" + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const setupJson = async (route, options) => {
      const response = await setupRequest(route, options), text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    assert.equal((await setupJson("/api/auth/key", { method: "POST", body: { key: "fixture-key-never-sent-to-provider" } })).ok, true);
    const conversation = await setupJson("/api/conversations", { method: "POST", body: {} });
    const conversationId = conversation.id || conversation.conversation?.id;
    assert.ok(conversationId);
    assert.equal((await setupJson("/api/models/select", { method: "POST", body: { model: "fixture-ui-chat" } })).model, "fixture-ui-chat");

    proxy = http.createServer((clientReq, clientRes) => {
      const chunks = [];
      clientReq.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      clientReq.on("end", () => {
        const requestBody = Buffer.concat(chunks);
        const headers = { ...clientReq.headers, host: "127.0.0.1:" + port, cookie: cookie + "=" + token };
        const isChatPost = clientReq.method === "POST" && clientReq.url === "/api/chat";
        const firstChat = isChatPost && proxyRecords.filter((record) => record.isChatPost).length === 0;
        const record = { isChatPost, key: headers["idempotency-key"] || null, body: requestBody.toString("utf8"), responseRunId: null };
        proxyRecords.push(record);
        const upstreamReq = http.request(origin + clientReq.url, { method: clientReq.method, headers }, (upstreamRes) => {
          record.responseRunId = upstreamRes.headers["x-agent-run-id"] || null;
          if (firstChat) {
            firstUpstreamRunId = record.responseRunId;
            firstResponseHeld = true;
            // The proxy intentionally withholds all response headers from the UI.
            // The UI test aborts this client connection only after the fake runner
            // records admission, producing a pre-header fetch rejection.
            upstreamRes.on("error", () => {});
            clientRes.on("close", () => upstreamRes.destroy());
            return;
          }
          clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
        });
        upstreamReq.on("error", (error) => {
          if (clientRes.destroyed) return;
          proxyError = error;
          clientRes.writeHead(502, { "Content-Type": "text/plain" });
          clientRes.end("fixture proxy upstream error");
        });
        clientRes.on("close", () => upstreamReq.destroy());
        upstreamReq.end(requestBody);
      });
    });
    await new Promise((resolve, reject) => proxy.once("error", reject).listen(proxyPort, "127.0.0.1", resolve));

    let chatAttempts = 0;
    const ui = createUiHarness(async (url, options = {}) => {
      if (url !== "/api/chat") throw new Error("unexpected UI request " + url);
      chatAttempts++;
      const controller = new AbortController();
      const actual = fetch(proxyOrigin + url, {
        method: options.method,
        headers: { ...options.headers, Cookie: cookie + "=" + token },
        body: options.body,
        signal: controller.signal,
      });
      if (chatAttempts === 1) {
        await waitFor(() => fs.existsSync(runnerStarted) && firstResponseHeld, "durable admission and held response headers");
        controller.abort();
        await assert.rejects(actual);
        throw new TypeError("connection closed before response headers");
      }
      const response = await actual;
      fs.writeFileSync(releaseRunner, "release");
      return response;
    });

    await ui.run({ conversationId, message: "one actual UI retry through local /api/chat" });
    assert.equal(chatAttempts, 2, "production runChat performs exactly one pre-header retry");
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.calls[0].key, "t03-ui-retry-idempotency-key");
    assert.equal(ui.calls[1].key, ui.calls[0].key, "production retry preserves the same Idempotency-Key");
    assert.equal(ui.calls[1].body, ui.calls[0].body, "production retry preserves the exact serialized request body");
    assert.equal(proxyError, null);
    const chatRecords = proxyRecords.filter((record) => record.isChatPost);
    assert.equal(chatRecords.length, 2, "both UI attempts reached the local HTTP fixture");
    assert.equal(chatRecords[0].key, chatRecords[1].key);
    assert.equal(chatRecords[0].body, chatRecords[1].body);
    assert.ok(firstUpstreamRunId, "server admitted the first request and generated a durable Run ID behind the response gate");
    assert.equal(chatRecords[0].responseRunId, chatRecords[1].responseRunId, "same-key retry receives the original Run ID");
    assert.equal(chatRecords[0].responseRunId, firstUpstreamRunId);
    assert.equal(fs.readFileSync(fakeRunLog, "utf8").trim().split("\n").length, 1, "the fake runner executes once");

    const runDetail = await setupJson("/api/runs/" + encodeURIComponent(firstUpstreamRunId));
    assert.equal(runDetail.run.state, "completed");
    const history = await setupJson("/api/conversations/" + encodeURIComponent(conversationId));
    assert.equal(history.conversation.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(history.conversation.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    fs.writeFileSync(releaseRunner, "release");
    await closeProxy();
    await stopApp();
    await storage?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

