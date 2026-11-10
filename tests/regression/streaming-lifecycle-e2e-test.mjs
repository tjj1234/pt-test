import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "shell/package.json"));
const { createStorage } = require("./storage/index.cjs");

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test("streaming lifecycle E2E interruption persistence and consistency across server, run, adapter, and db", { timeout: 60_000 }, async () => {
  assert.equal(
    Object.keys(process.env).some((k) => k.startsWith("PT_PG_") && process.env[k]),
    false,
    "Fixture must use isolated local PGlite, no external PG"
  );

  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "northstar-streaming-e2e-"));
  const dbDir = path.join(temp, "db");
  const masterKeyFile = path.join(temp, "master.key");
  const runtimeDir = path.join(temp, "runtime");
  const logDir = path.join(temp, "logs");
  const idempCountFile = path.join(temp, "idemp-count.txt");

  // 1. 初始化生产持久化存储并注册测试用户
  const storage = await createStorage({ dataDir: dbDir, masterKeyFile });
  const reg = await storage.repositories.auth.register({
    username: "e2e-streaming-user-" + Date.now(),
    password: "Password12345!"
  });
  assert.equal(reg.ok, true);
  const user = reg.user;
  const cookieToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(cookieToken).digest("hex");
  await storage.db.query("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1, $2, $3)", [
    user.id, tokenHash, new Date(Date.now() + 300_000).toISOString()
  ]);
  const cookie = `pt_session=${cookieToken}`;
  await storage.close();

  // 2. 构造符合 DSH persistent-runner 协议的真实子进程 runner
  const runnerFile = path.join(temp, "dsh-runner.cjs");
  fs.writeFileSync(runnerFile, `
    const fs = require("node:fs");
    const path = require("node:path");
    const idempFile = ${JSON.stringify(idempCountFile)};
    let executionCount = 0;

    function emit(obj) {
      process.stdout.write(JSON.stringify({ protocolVersion: 1, ...obj }) + "\\n");
    }
    emit({
      type: "ready",
      runner: "persistent-runner",
      capabilities: ["task-v1", "tool-rpc-v1", "abort-v1", "native-context-v1", "model-intent-v1"]
    });

    let buf = "";
    process.stdin.on("data", chunk => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const cmd = JSON.parse(line);
          if (cmd.type === "task") {
            const sid = cmd.sessionId;
            const taskStr = String(cmd.task || "");
            if (taskStr.includes("[SCENARIO:USER_STOP]")) {
              emit({ type: "delta", sessionId: sid, text: "方案第一阶段：定位受众画像；" });
              emit({ type: "delta", sessionId: sid, text: "渠道预算配置与转化率预估。" });
              // 保持会话开启，等待外部中止
            } else if (taskStr.includes("[SCENARIO:TIMEOUT]")) {
              emit({ type: "delta", sessionId: sid, text: "正在执行深度归因聚合运算阶段一..." });
              // 保持静默，等待服务端/adapter 设定的短超时触发
            } else if (taskStr.includes("[SCENARIO:ERROR]")) {
              emit({ type: "delta", sessionId: sid, text: "正在拉取外部业务报表数据..." });
              emit({ type: "error", sessionId: sid, code: "RUNNER_QUEUE_FAILED", error: "Parent command could not be processed" });
            } else if (taskStr.includes("[SCENARIO:DISCONNECT]")) {
              emit({ type: "delta", sessionId: sid, text: "长文本流式分析第一段：用户流失率上升。" });
              // 延迟 1200ms 发送第二段与完成，让客户端在收到首段后有充分确定性时机主动断开连接
              setTimeout(() => {
                emit({ type: "delta", sessionId: sid, text: "第二段：建议优化新手引导流程。" });
                emit({ type: "done", sessionId: sid, ok: true, text: "长文本流式分析第一段：用户流失率上升。第二段：建议优化新手引导流程。" });
              }, 1200);
            } else if (taskStr.includes("[SCENARIO:SESSION_A]")) {
              emit({ type: "delta", sessionId: sid, text: "会话A第一阶段分析结果；" });
              // 保持会话开启，等待外部仅中止 A
            } else if (taskStr.includes("[SCENARIO:SESSION_B]")) {
              emit({ type: "delta", sessionId: sid, text: "会话B第一阶段分析结果；" });
              setTimeout(() => {
                emit({ type: "delta", sessionId: sid, text: "会话B方案顺利完成出炉。" });
                emit({ type: "done", sessionId: sid, ok: true, text: "会话B第一阶段分析结果；会话B方案顺利完成出炉。" });
              }, 600);
            } else if (taskStr.includes("[SCENARIO:LATE_FRAMES]")) {
              emit({ type: "delta", sessionId: sid, text: "首轮正常产出内容。" });
              emit({ type: "done", sessionId: sid, ok: true, text: "首轮正常产出内容。" });
              // 故意在 done 之后 80ms 吐出迟到帧，验证 adapter 安全忽略
              setTimeout(() => {
                emit({ type: "delta", sessionId: sid, text: "【迟到的流式片段】" });
              }, 80);
            } else if (taskStr.includes("[SCENARIO:IDEMPOTENCY]")) {
              executionCount++;
              try { fs.writeFileSync(idempFile, String(executionCount)); } catch (_) {}
              emit({ type: "delta", sessionId: sid, text: "幂等性校验首发执行完毕。" });
              emit({ type: "done", sessionId: sid, ok: true, text: "幂等性校验首发执行完毕。" });
            } else if (taskStr.includes("[SCENARIO:WHITESPACE_ONLY]")) {
              emit({ type: "delta", sessionId: sid, text: "   \\n\\t  \\n  " });
            } else {
              emit({ type: "delta", sessionId: sid, text: "默认问答正常回复。" });
              emit({ type: "done", sessionId: sid, ok: true, text: "默认问答正常回复。" });
            }
          } else if (cmd.type === "abort") {
            emit({ type: "aborted", sessionId: cmd.sessionId });
            emit({ type: "done", sessionId: cmd.sessionId, ok: false, stopped: true, stopReason: "user" });
            // 模拟取消后的迟到 step、迟到 done 及重复 aborted 终态帧
            setTimeout(() => {
              emit({ type: "step", sessionId: cmd.sessionId, stepIndex: 99, stepType: "tool", ok: false });
              emit({ type: "done", sessionId: cmd.sessionId, ok: false, stopped: true, stopReason: "user" });
              emit({ type: "aborted", sessionId: cmd.sessionId });
            }, 60);
          } else if (cmd.type === "ping") {
            emit({ type: "pong" });
          } else if (cmd.type === "exit") {
            emit({ type: "bye" });
            process.exit(0);
          }
        } catch (e) {}
      }
    });
  `);

  // 3. 构造 preload 模块：注入受控模型目录及 DSH runner 发现
  const preloadFile = path.join(temp, "preload.cjs");
  fs.writeFileSync(preloadFile, `
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function(name, parent) {
      const loaded = load.apply(this, arguments);
      if (parent?.filename.endsWith('/dsh-adapter.cjs') && name === './dsh-installation.cjs') {
        return {
          ...loaded,
          resolveDshInstallation: () => ({
            entry: ${JSON.stringify(runnerFile)},
            packageRoot: ${JSON.stringify(temp)},
            version: "0.1.1-rc.2",
            manifestSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            vendorSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            lockfileSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            packageFileCount: 20,
            scope: "dsh-cli-package-only"
          })
        };
      }
      if (parent?.filename.endsWith('/tenant.cjs') && name === './runtime/dsh-adapter.cjs') {
        return {
          ...loaded,
          createDshRuntime: (opts) => loaded.createDshRuntime({
            ...opts,
            taskTimeoutMs: process.env.PT_TEST_DSH_TIMEOUT_MS ? Number(process.env.PT_TEST_DSH_TIMEOUT_MS) : opts.taskTimeoutMs,
          })
        };
      }
      if (parent?.filename.endsWith('/server.cjs') && name === './models/dsh-configured-catalog.cjs') {
        return { ...loaded, configuredModels: () => ["fixture-streaming-model"] };
      }
      if (parent?.filename.endsWith('/server.cjs') && name === './model-catalog.cjs') {
        return {
          ...loaded,
          getCatalog: async () => ({
            models: [{
              id: "fixture-streaming-model",
              name: "Fixture Streaming Model",
              chat: true,
              capabilityStatus: "supported",
              runtimeStatus: "verified",
              availability: "present",
              permission: true,
              localPolicy: { enabled: true, tasks: ["textChat"] },
              tasks: { textChat: { value: true } },
              inputModalities: { value: ["text"] },
              outputModalities: { value: ["text"] },
              states: { textChat: { adapted: true, endpointCompatible: true, verified: true, autoEligible: true } }
            }],
            availability: { status: "available", modelIds: ["fixture-streaming-model"] },
            syncedAt: Date.now()
          }),
          routeModelFor: () => "fixture-streaming-model",
          pickDefaultModel: () => "fixture-streaming-model"
        };
      }
      return loaded;
    };
  `);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: temp,
    PT_RUNTIME_DIR: runtimeDir,
    PT_DB_DIR: dbDir,
    PT_MASTER_KEY_FILE: masterKeyFile,
    PT_LOG_DIR: logDir,
    PT_SHELL_PORT: String(port),
    PT_LISTEN_HOST: "127.0.0.1",
    PT_KEY_LIVE_VERIFY: "0",
    PT_RUNS_GLOBAL: "4",
    PT_RUNS_PER_USER: "4",
    PT_TEST_DSH_TIMEOUT_MS: "1200", // 测试短超时，1.2s 超时
  };
  for (const d of [env.HOME, env.PT_RUNTIME_DIR, env.PT_LOG_DIR]) fs.mkdirSync(d, { recursive: true });

  const child = spawn(process.execPath, ["--require", preloadFile, "shell/server.cjs", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"]
  });

  const stopServer = async () => {
    if (!child || child.exitCode !== null) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  };

  try {
    // 等待本地服务就绪
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error("Server process exited prematurely during startup");
      try {
        const res = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
        if (res.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ready, true, "HTTP server must become healthy");

    // 保存测试 API Key
    const keyRes = await fetch(`${origin}/api/auth/key`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "fixture-encrypted-key-for-dsh" })
    });
    assert.equal(keyRes.status, 200);

    const httpJson = async (route, opts = {}) => {
      const { headers: customHeaders, ...restOpts } = opts;
      const res = await fetch(`${origin}${route}`, {
        ...restOpts,
        headers: {
          Cookie: cookie,
          ...(restOpts.body ? { "Content-Type": "application/json" } : {}),
          ...(customHeaders || {})
        },
      });
      const data = await res.json();
      return { status: res.status, data };
    };

    const createConversation = async () => {
      const { status, data } = await httpJson("/api/conversations", { method: "POST", body: JSON.stringify({}) });
      assert.equal(status, 200);
      return data.id || data.conversation?.id;
    };

    console.log("\n[Scenario 1] Real HTTP/Run/Adapter User Manual Stop with Partial Retention...");
    {
      const convId = await createConversation();
      const chatPromise = fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:USER_STOP] 请起草一份营销方案" })
      });

      // 异步等待流式片段到达客户端
      await new Promise((r) => setTimeout(r, 400));

      // 调用生产停止接口 POST /api/chat/stop
      const { status: stopStatus, data: stopData } = await httpJson("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: convId })
      });
      assert.equal(stopStatus, 200);
      assert.equal(stopData.ok, true);
      assert.equal(stopData.stopped, true);

      const chatRes = await chatPromise;
      assert.equal(chatRes.status, 200);
      const text = await chatRes.text();
      assert.ok(text.includes('"delta":"方案第一阶段：定位受众画像；"'));
      assert.ok(text.includes('"delta":"渠道预算配置与转化率预估。"'));
      assert.ok(text.includes('"stopped":true'));
      assert.ok(text.includes('"stopReason":"user"'));

      // 模拟前端刷新页面 / 退出重进：调用真实 GET /api/conversations/:id
      const { status: reloadStatus, data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      assert.equal(reloadStatus, 200);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2, "Persisted conversation must contain user prompt and assistant partial answer");
      assert.equal(msgs[0].role, "user");
      assert.equal(msgs[1].role, "assistant");
      assert.equal(msgs[1].partial, true, "Interrupted turn must be marked partial: true");
      assert.equal(msgs[1].stopReason, "user");
      assert.equal(msgs[1].text, "方案第一阶段：定位受众画像；渠道预算配置与转化率预估。");

      console.log("  ✔ Scenario 1: User stop correctly persisted partial text in real DB");
    }

    console.log("\n[Scenario 2] Adapter Timeout Interruption Partial Retention...");
    {
      const convId = await createConversation();
      const chatRes = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:TIMEOUT] 执行超长深度运算" })
      });
      assert.equal(chatRes.status, 200);
      const text = await chatRes.text();
      assert.ok(text.includes('"stopped":true'));
      assert.ok(text.includes('"stopReason":"timeout"'));

      // 刷新回查数据库持久化记录
      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1].role, "assistant");
      assert.equal(msgs[1].partial, true);
      assert.equal(msgs[1].stopReason, "timeout");
      assert.equal(msgs[1].text, "正在执行深度归因聚合运算阶段一...");

      console.log("  ✔ Scenario 2: Timeout interruption correctly preserved partial text with stopReason: timeout");
    }

    console.log("\n[Scenario 3] Execution Error with Streamed Content Retention...");
    {
      const convId = await createConversation();
      const chatRes = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:ERROR] 拉取远端报表" })
      });
      assert.equal(chatRes.status, 200);
      const text = await chatRes.text();
      assert.ok(text.includes('"ok":false'));
      assert.ok(text.includes("DSH 执行失败") || text.includes("RUNNER_QUEUE_FAILED"));

      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1].role, "assistant");
      assert.ok(msgs[1].text.includes("DSH 执行失败") || msgs[1].text.includes("RUNNER_QUEUE_FAILED"));
      assert.ok(msgs[1].text.includes("正在拉取外部业务报表数据..."), "Error turn must preserve partial text");

      console.log("  ✔ Scenario 3: Error response properly retained partial text in conversation error record");
    }

    console.log("\n[Scenario 4] Client Mid-Stream Connection Abrupt Disconnect Barrier with In-Flight Verification...");
    {
      const convId = await createConversation();
      const controller = new AbortController();
      const chatRes = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:DISCONNECT] 客户端中途断开连接" }),
        signal: controller.signal
      });
      assert.equal(chatRes.status, 200);

      // 真实 HTTP 流式读取：使用 reader 在流式首段已到达、done 尚未发送时真实断开
      const reader = chatRes.body.getReader();
      const dec = new TextDecoder();
      let firstChunkSeen = false;
      let lastChunk = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lastChunk = dec.decode(value);
        if (lastChunk.includes("长文本流式分析第一段")) {
          firstChunkSeen = true;
          // 断开瞬间断言：流式尚未发出 done 终态
          assert.equal(lastChunk.includes('"done":true'), false, "Must NOT have received done frame at disconnect point");
          // 通过服务端状态接口真实核验：Run 此时处于活跃 running 状态
          const { data: runsData } = await httpJson("/api/runs?limit=10");
          const activeRun = runsData.runs?.find(r => r.conversationId === convId);
          assert.ok(activeRun, "Active run must exist in TaskStore");
          assert.equal(activeRun.state, "running", "Run must strictly be in 'running' state at moment of disconnect");
          // 确定性验证：确认首段已到、Run 在运行且 done 尚未发时立即断开连接
          controller.abort();
          break;
        }
      }
      assert.equal(firstChunkSeen, true, "First delta chunk must have reached client before abort");

      // 等待服务端后台按照既有策略安全收敛并将内容持久化至 DB
      await new Promise((r) => setTimeout(r, 1500));

      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2, "Disconnected turn completes and safely persists in DB");
      assert.equal(msgs[1].role, "assistant");
      assert.ok(msgs[1].text.includes("长文本流式分析第一段"));

      console.log("  ✔ Scenario 4: Disconnected client request with confirmed in-flight running state safely completes and persists in DB");
    }

    console.log("\n[Scenario 5] Concurrent Multi-Session Physical Isolation with Dual Active In-Flight Verification...");
    {
      const convA = await createConversation();
      const convB = await createConversation();

      // 会话 A 和会话 B 同时发起 HTTP 聊天流
      const streamA = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convA, message: "[SCENARIO:SESSION_A] 会话A发起" })
      });
      const streamB = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convB, message: "[SCENARIO:SESSION_B] 会话B发起" })
      });

      const readerA = streamA.body.getReader();
      const readerB = streamB.body.getReader();
      const dec = new TextDecoder();

      // 使用 barrier 确定性核验两会话同时处于流式活动中 (Dual in-flight)
      let activeA = false, activeB = false;
      while (!activeA) {
        const { value, done } = await readerA.read();
        if (done) break;
        if (dec.decode(value).includes("会话A第一阶段")) activeA = true;
      }
      while (!activeB) {
        const { value, done } = await readerB.read();
        if (done) break;
        if (dec.decode(value).includes("会话B第一阶段")) activeB = true;
      }
      assert.equal(activeA, true, "Session A is actively in-flight");
      assert.equal(activeB, true, "Session B is actively in-flight simultaneously");

      // 通过服务端接口确证：两任务在同一时刻均处于 running 状态
      const { data: dualRuns } = await httpJson("/api/runs?limit=10");
      const runA = dualRuns.runs?.find(r => r.conversationId === convA);
      const runB = dualRuns.runs?.find(r => r.conversationId === convB);
      assert.equal(runA?.state, "running", "Run A must be running concurrently");
      assert.equal(runB?.state, "running", "Run B must be running concurrently");

      // 在 A 与 B 同时处于流式活跃中时，仅停止会话 A
      const { data: stopAData } = await httpJson("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: convA })
      });
      assert.equal(stopAData.stopped, true);

      // 读取 A 的剩余流式帧，断言包含 stopped
      let textA = "";
      while (true) {
        const { value, done } = await readerA.read();
        if (done) break;
        textA += dec.decode(value);
      }
      assert.ok(textA.includes('"stopped":true'));

      // 确证 A 停止后，B 仍然处于 running 状态不受干扰
      const { data: runsAfterStopA } = await httpJson("/api/runs?limit=10");
      const runBRunning = runsAfterStopA.runs?.find(r => r.conversationId === convB);
      assert.equal(runBRunning?.state, "running", "Run B must remain running after A stopped");

      // 会话 B 应当正常继续产出并完成，不受会话 A 的停止影响
      let textB = "";
      while (true) {
        const { value, done } = await readerB.read();
        if (done) break;
        textB += dec.decode(value);
      }
      assert.ok(textB.includes('"ok":true') || textB.includes("会话B方案顺利完成出炉"));

      const { data: reloadA } = await httpJson(`/api/conversations/${convA}`);
      const { data: reloadB } = await httpJson(`/api/conversations/${convB}`);
      assert.equal(reloadA.conversation.messages[1].partial, true);
      assert.equal(reloadA.conversation.messages[1].stopReason, "user");
      assert.equal(reloadA.conversation.messages[1].text, "会话A第一阶段分析结果；");
      assert.equal(Boolean(reloadB.conversation.messages[1].partial), false, "Session B must be fully completed");
      assert.equal(reloadB.conversation.messages[1].text, "会话B第一阶段分析结果；会话B方案顺利完成出炉。");

      console.log("  ✔ Scenario 5: Concurrent multi-session physical isolation and dual running state 100% verified");
    }

    console.log("\n[Scenario 6] Late Frames and Cancel Post-Events Immunity...");
    {
      const convId = await createConversation();
      const res = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:LATE_FRAMES] 验证迟到帧" })
      });
      assert.equal(res.status, 200);
      await res.text();

      // 等待 runner 故意发送的迟到帧触发完毕
      await new Promise((r) => setTimeout(r, 200));

      // 检查回存数据未被迟到帧篡改或追加
      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1].text, "首轮正常产出内容。");
      assert.equal(msgs[1].text.includes("迟到的流式片段"), false, "Late frames must be safely discarded");

      console.log("  ✔ Scenario 6: Late frames safely ignored without state pollution");
    }

    console.log("\n[Scenario 7] Idempotency Key Replay Semantics and Runner Re-execution Prevention...");
    {
      const convId = await createConversation();
      const idempKey = "e2e-idemp-" + crypto.randomUUID();

      const res1 = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": idempKey },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:IDEMPOTENCY] 幂等性校验首发" })
      });
      assert.equal(res1.status, 200);
      const text1 = await res1.text();

      // 重复发送同一幂等键
      const res2 = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": idempKey },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:IDEMPOTENCY] 幂等性校验首发" })
      });
      assert.equal(res2.status, 200);
      const text2 = await res2.text();

      // 验证底层 runner 仅执行了一次，未触发第二次实际执行
      const count = Number(fs.readFileSync(idempCountFile, "utf8").trim());
      assert.equal(count, 1, "Idempotency replay must NOT execute runner a second time");

      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 2, "Idempotent replay must not append duplicate turns in DB");
      assert.equal(msgs[1].text, "幂等性校验首发执行完毕。");

      console.log("  ✔ Scenario 7: Idempotent replay safely prevented duplicate turn commits and runner re-execution");
    }

    console.log("\n[Scenario 8] Whitespace-Only Interrupted Stream Leaves Clean DB...");
    {
      const convId = await createConversation();
      const chatPromise = fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message: "[SCENARIO:WHITESPACE_ONLY] 空白测试" })
      });

      await new Promise((r) => setTimeout(r, 350));
      await httpJson("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: convId })
      });
      await (await chatPromise).text();

      const { data: reloadData } = await httpJson(`/api/conversations/${convId}`);
      const msgs = reloadData.conversation?.messages || [];
      assert.equal(msgs.length, 1, "Whitespace-only stream must not leave empty partial assistant message");

      console.log("  ✔ Scenario 8: Whitespace-only stream leaves clean conversation history in DB");
    }

    console.log("\n[Scenario 9] Cold Storage Shutdown, Reopen Consistency and Lease Loss Fencing...");
    {
      // 优雅关闭 HTTP 服务进程
      await stopServer();

      // 直接从磁盘重新打开 PGlite 数据库，验证持久层物理一致性
      const directStorage = await createStorage({ dataDir: dbDir, masterKeyFile });
      const rows = (await directStorage.db.query("SELECT id, messages FROM conversations ORDER BY created_at ASC")).rows;
      assert.ok(rows.length >= 7, "All created conversations must physically persist on disk");

      for (const row of rows) {
        const msgs = typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
        assert.ok(Array.isArray(msgs), "Messages column must be an array");
        // 验证用户问题始终在第 0 项
        assert.equal(msgs[0].role, "user");
        if (msgs[1] && msgs[1].partial) {
          assert.ok(msgs[1].text.length > 0, "Persisted partial messages must not be empty");
          assert.ok(["user", "timeout"].includes(msgs[1].stopReason), "stopReason must be either user or timeout");
        }
      }

      // 验证租约转移与旧 worker 迟到写防篡改围栏 (Lease Loss & Transfer Fencing)
      const { createTaskStore } = require("./tasks/store.cjs");
      const taskStore = createTaskStore(directStorage.adapter);
      const identity = { userId: user.id, tenantId: user.tenant_id };
      const fenceConv = await directStorage.repositories.conversations.create(identity.userId);
      const oldRun = (await taskStore.createRun(identity, {
        conversationId: fenceConv.id,
        idempotencyKey: "lease-transfer-test",
        request: { question: "lease transfer" }
      }, { owner: "worker-1", ttlMs: 10_000 })).run;

      // 任务在 worker-1 下进入 running 态，获得会话独占租约
      await taskStore.transition(identity, oldRun.runId, "running", oldRun.revision, "worker-1");
      assert.equal(await taskStore.acquireConversationLease(identity, oldRun.runId, "worker-1", 10_000), true);

      // 真实模拟运行中租约被转移给 worker-2 (Failover / Transfer)
      await directStorage.db.query(
        "UPDATE agent_runs SET lease_owner='worker-2', lease_expires_at=clock_timestamp()+interval '10 seconds' WHERE run_id=$1",
        [oldRun.runId]
      );
      await directStorage.db.query(
        "UPDATE agent_conversation_leases SET lease_owner='worker-2', lease_expires_at=clock_timestamp()+interval '10 seconds' WHERE run_id=$1",
        [oldRun.runId]
      );

      // 旧 worker-1 使用其真实原身份发起迟到提交，因已失去租约所有权必须被数据库排他围栏强行拒绝
      let worker1Rejected = false;
      try {
        await taskStore.saveConversationMessages(identity, oldRun.runId, "worker-1", fenceConv.id, [
          { role: "user", text: "旧 worker-1 迟到写" },
          { role: "assistant", text: "旧 worker-1 迟到答案" }
        ]);
      } catch (err) {
        worker1Rejected = true;
        assert.equal(err.code, "LEASE_LOST", "Old owner must receive LEASE_LOST upon lease transfer");
      }
      assert.equal(worker1Rejected, true, "Old worker-1 must not be permitted to commit after lease transfer");

      // 新有权持有者 worker-2 进行有权提交，成功持久化入库
      await taskStore.saveConversationMessages(identity, oldRun.runId, "worker-2", fenceConv.id, [
        { role: "user", text: "有权新 worker-2 写入问题" },
        { role: "assistant", text: "有权新 worker-2 写入结果", partial: false }
      ]);
      const savedConv = await directStorage.repositories.conversations.get(identity.userId, fenceConv.id);
      assert.equal(savedConv.messages.length, 2);
      assert.equal(savedConv.messages[1].text, "有权新 worker-2 写入结果");

      // 旧 worker-1 再次试图追加错误/close 终态，仍然被排他围栏彻底拦截
      let worker1CloseRejected = false;
      try {
        await taskStore.saveConversationMessages(identity, oldRun.runId, "worker-1", fenceConv.id, [
          { role: "user", text: "旧 worker-1 重复终态" }
        ]);
      } catch (err) {
        worker1CloseRejected = true;
        assert.equal(err.code, "LEASE_LOST");
      }
      assert.equal(worker1CloseRejected, true);

      // 租约过期自动回收验证
      await directStorage.db.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1", [oldRun.runId]);
      await directStorage.db.query("UPDATE agent_conversation_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1", [oldRun.runId]);
      const recovered = await taskStore.recoverExpiredLeases({ limit: 10 });
      assert.ok(recovered.some(r => r.runId === oldRun.runId), "Expired lease run must be cleanly recovered");

      await directStorage.close();

      console.log("  ✔ Scenario 9: Cold DB restart and lease loss fencing/recovery 100% verified");
    }

  } finally {
    await stopServer();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }

  console.log("\n=== ALL STREAMING LIFECYCLE E2E TESTS PASSED WITH REAL HTTP, RUN, ADAPTER, SERVER AND PERSISTENT DB ===");
});
