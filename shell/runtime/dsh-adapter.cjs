"use strict";
/**
 * runtime/dsh-adapter.cjs —— 真实 DSH Adapter（实现 Runtime Contract）
 * ============================================================================
 * 从 shell/tenant.cjs 抽出的 DSH 集成层：每租户常驻 DSH 进程 + stdin/stdout
 * JSON-lines 协议 + 会话生命周期（冷/热启动、空闲回收、超时保护、停止）。
 *
 * 与 tenant.cjs 的边界：
 *   · 这里只负责「spawn DSH + 协议 + 会话生命周期 + 事件适配」；
 *   · PT key 解密、workspace 初始化、人设/记忆/历史读取、模型列表 —— 留在 tenant.cjs（业务壳）。
 *
 * 通过 createDshRuntime(opts) 构造；返回实例满足 Runtime Contract（见 contract.cjs）。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/* ============================================================================
 * DSH 入口发现（跨平台）
 * ========================================================================== */
function findDshEntry(explicit) {
  if (explicit && fs.existsSync(explicit)) return { js: explicit, nodePath: null };
  if (process.env.DSH_JS) {
    const envJs = path.resolve(process.cwd(), process.env.DSH_JS);
    if (fs.existsSync(envJs)) return { js: envJs, nodePath: null };
    process.stderr.write("[DSH] DSH_JS 指向的文件不存在：" + envJs + "（继续尝试自动发现…）\n");
  }
  const roots = [];
  const pushUp = (start, depth) => {
    let cur = start;
    for (let i = 0; i < depth; i++) {
      roots.push(path.join(cur, "node_modules"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  pushUp(path.dirname(process.execPath), 6);
  pushUp(process.cwd(), 6);
  try {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0 && r.stdout) roots.push(String(r.stdout).trim());
  } catch (e) { /* 忽略 */ }
  for (const r of roots) {
    if (!r) continue;
    const js = path.join(r, "@deepseek-ai", "dsh", "lib", "bin.js");
    if (fs.existsSync(js)) {
      let nodePath = null;
      try {
        const cmd = fs.readFileSync(path.join(r, ".bin", "dsh.cmd"), "utf8");
        const m = cmd.match(/SET "NODE_PATH=([^"]+)"/i);
        if (m) nodePath = m[1];
      } catch (e) { /* 无 NODE_PATH 也可跑 */ }
      return { js, nodePath };
    }
  }
  return { js: null, nodePath: null };
}

function dshMissingHint() {
  return (
    "找不到 DSH 的 JS 入口（@deepseek-ai/dsh/lib/bin.js）。请二选一：\n" +
    "  ① 设环境变量 DSH_JS 指向该 bin.js 的绝对路径；\n" +
    "  ② 安装 dsh：npm install -g @deepseek-ai/dsh（或装到本仓库 node_modules），装好后重试。"
  );
}

/* ============================================================================
 * profile：常驻 profile（dsh-base + persistent-runner，无 headless）
 * ========================================================================== */
const PROFILE_NAME = "run-persistent";
const PROFILE_PATCH = [
  "- id: hmr",
  "  disabled: true",
  "",
  "- insert:",
  "    - id: persistent-runner",
  "      name: './persistent-runner.mjs'",
  "      inject: [agentDefaultModel, agents, sessions]",
  "",
].join("\n");

function ensureDshHomeConfig(dshHome, settingsTemplate) {
  const home = dshHome;
  const dst = path.join(home, "settings.yaml");
  if (fs.existsSync(dst)) return;
  fs.mkdirSync(home, { recursive: true });
  if (settingsTemplate && fs.existsSync(settingsTemplate)) {
    try { fs.copyFileSync(settingsTemplate, dst); }
    catch (e) { process.stderr.write("[DSH] settings.yaml 播种失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 dsh-settings.yaml 模板，DSH 将回退默认模型路由\n");
  }
}

function makeProfile(dshHome, settingsTemplate, persistentRunner) {
  ensureDshHomeConfig(dshHome, settingsTemplate);
  const name = PROFILE_NAME;
  const dir = path.join(dshHome, "profiles", name);
  fs.mkdirSync(dir, { recursive: true });

  const pkgFile = path.join(dir, "package.json");
  const pkgWant = JSON.stringify({
    name: "dsh-profile-" + name, private: true, dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  if (!fs.existsSync(pkgFile) || fs.readFileSync(pkgFile, "utf8") !== pkgWant) {
    fs.writeFileSync(pkgFile, pkgWant, "utf8");
  }

  const wsFile = path.join(dir, "pnpm-workspace.yaml");
  if (!fs.existsSync(wsFile)) {
    fs.writeFileSync(wsFile, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
  }

  const patchFile = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(patchFile) || fs.readFileSync(patchFile, "utf8") !== PROFILE_PATCH) {
    fs.writeFileSync(patchFile, PROFILE_PATCH, "utf8");
  }

  const runnerFile = path.join(dir, "persistent-runner.mjs");
  if (persistentRunner && fs.existsSync(persistentRunner)) {
    try { fs.copyFileSync(persistentRunner, runnerFile); }
    catch (e) { process.stderr.write("[DSH] persistent-runner.mjs 复制失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 persistent-runner.mjs（" + persistentRunner + "）\n");
  }
  return { name, dir };
}

/* ============================================================================
 * createDshRuntime —— 构造满足 Runtime Contract 的真实 DSH 实例
 * ========================================================================== */
function createDshRuntime(opts = {}) {
  const dshHome = opts.dshHome;
  const settingsTemplate = opts.settingsTemplate;
  const persistentRunner = opts.persistentRunner;
  const tmpDir = opts.tmpDir;
  const idleMs = opts.idleMs || (15 * 60 * 1000);
  const taskTimeoutMs = opts.taskTimeoutMs || (3 * 60 * 1000);
  const entry = opts.dshEntry || findDshEntry().js;

  const persistentProcesses = new Map(); // tenantId -> proc
  const warmSessions = new Map();        // sessionKey -> { tenantId, sessionId }

  function writeJson(proc, obj) {
    try { proc.child.stdin.write(JSON.stringify(obj) + "\n"); } catch (e) { /* 进程已退 */ }
  }

  function dispatchFrame(proc, frame) {
    switch (frame.type) {
      case "ready": proc.ready = true; break;
      case "pong": case "bye": case "closed": break;
      case "delta": {
        const w = proc.waiters.get(frame.sessionId);
        if (w && typeof w.onDelta === "function") { try { w.onDelta(frame.text); } catch (e) {} }
        break;
      }
      case "step": {
        const w = proc.waiters.get(frame.sessionId);
        if (w) {
          const step = { name: frame.name, args: frame.args, result: frame.result, isError: frame.isError };
          if (Array.isArray(w.steps)) w.steps.push(step);
          if (typeof w.onStep === "function") { try { w.onStep(step); } catch (e) {} }
        }
        break;
      }
      case "done": {
        const w = proc.waiters.get(frame.sessionId);
        if (w) { proc.waiters.delete(frame.sessionId); w.resolve(frame); }
        break;
      }
      case "error": {
        const sid = frame.sessionId;
        if (sid) {
          const w = proc.waiters.get(sid);
          if (w) { proc.waiters.delete(sid); w.resolve({ ok: false, error: frame.message, text: "" }); }
        }
        break;
      }
      case "aborted": {
        const sid = frame.sessionId;
        if (sid) {
          const w = proc.waiters.get(sid);
          if (w) { proc.waiters.delete(sid); w.resolve({ ok: false, error: "已停止", text: "", stopped: true }); }
        }
        break;
      }
    }
  }

  function pollProc(proc) {
    let chunk;
    try {
      const st = fs.statSync(proc.outFile);
      if (st.size <= proc.lastSize) return;
      const len = st.size - proc.lastSize;
      const buf = Buffer.alloc(len);
      const rfd = fs.openSync(proc.outFile, "r");
      try { fs.readSync(rfd, buf, 0, len, proc.lastSize); } finally { fs.closeSync(rfd); }
      proc.lastSize = st.size;
      chunk = buf.toString("utf8");
    } catch (e) { return; }
    proc.lineBuf += chunk;
    let idx;
    while ((idx = proc.lineBuf.indexOf("\n")) >= 0) {
      const line = proc.lineBuf.slice(0, idx).trim();
      proc.lineBuf = proc.lineBuf.slice(idx + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (e) { continue; }
      dispatchFrame(proc, frame);
    }
  }

  function getOrSpawnProcess(spec) {
    const key = spec.tenantId;
    const existing = persistentProcesses.get(key);
    if (existing && existing.child && existing.child.exitCode === null && !existing.child.killed) {
      existing.lastUsed = Date.now();
      return { proc: existing, fresh: false };
    }

    if (existing) {
      try { clearInterval(existing.pollTimer); } catch (e) {}
      persistentProcesses.delete(key);
      for (const [sid, rec] of [...warmSessions.entries()]) if (rec && rec.tenantId === key) warmSessions.delete(sid);
    }

    if (!entry) return { proc: null, fresh: false, spawnError: dshMissingHint() };

    const tdir = tmpDir;
    fs.mkdirSync(tdir, { recursive: true });
    const safe = String(key).replace(/[^A-Za-z0-9_-]/g, "");
    const outFile = path.join(tdir, "persist-" + safe + "-" + Date.now().toString(36) + ".txt");
    const errFile = outFile + ".err";
    const fdOut = fs.openSync(outFile, "w");
    const fdErr = fs.openSync(errFile, "w");

    const profile = makeProfile(dshHome, settingsTemplate, persistentRunner);
    const env = Object.assign({}, process.env, { DSH_HOME: dshHome });
    if (opts.nodePath) env.NODE_PATH = opts.nodePath;
    env.POWERTOKENS_API_KEY = String(spec.apiKey || "");

    let child;
    try {
      child = spawn(process.execPath, [entry, "--profile", profile.name], {
        cwd: spec.workspace, env, stdio: ["pipe", fdOut, fdErr], windowsHide: true,
      });
    } catch (e) {
      try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e2) {}
      return { proc: null, fresh: false, spawnError: String((e && e.message) || e) };
    }

    const proc = {
      child, outFile, errFile, fdOut, fdErr,
      lastSize: 0, lastUsed: Date.now(),
      waiters: new Map(), lineBuf: "", ready: false,
      pollTimer: null, killedByUser: false, idleTimer: null,
    };
    proc.pollTimer = setInterval(() => pollProc(proc), 50);
    persistentProcesses.set(key, proc);

    child.on("close", () => {
      try { clearInterval(proc.pollTimer); } catch (e) {}
      for (const [sid, w] of [...proc.waiters.entries()]) {
        proc.waiters.delete(sid);
        w.resolve({ ok: false, error: proc.killedByUser ? "已停止" : "常驻 DSH 进程退出", text: "", stopped: proc.killedByUser });
      }
    });

    return { proc, fresh: true };
  }

  function run(spec) {
    const sessionKey = String(spec.sessionKey || "").trim();
    const tenantId = String(spec.tenantId || "").trim();
    const workspace = spec.workspace;

    return new Promise((resolve) => {
      const { proc, fresh, spawnError } = getOrSpawnProcess(spec);
      if (spawnError || !proc) {
        return resolve({
          ok: false, code: "SPAWN", text: "", ms: 0, error: spawnError || "常驻进程启动失败",
          workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")), fresh: false,
        });
      }

      // 冷/热判断：新鲜进程 = 无存活 session，视为冷启动（补历史 + 用全新 sessionId）
      const warmRec = sessionKey ? warmSessions.get(sessionKey) : null;
      const warm = !fresh && warmRec && warmRec.tenantId === tenantId;
      const sessionId = warm ? warmRec.sessionId : ((sessionKey || "adhoc") + "-" + crypto.randomBytes(6).toString("hex"));

      // 组装任务：人设 + 长期记忆 + 图片说明 +（冷启动才补历史）+ 当前问题
      const parts = [];
      if (spec.persona) parts.push("【系统设定】\n" + spec.persona);
      if (spec.memory) parts.push("用户长期记忆：\n" + spec.memory);
      if (spec.imageNote) parts.push(spec.imageNote);
      if (!warm && spec.history) parts.push("以下是本次对话的历史（仅供理解上下文，不要复述）：\n" + spec.history);
      parts.push("用户现在问：" + String(spec.question || ""));
      const fullTask = parts.join("\n\n");

      const t0 = Date.now();
      const job = {
        stopped: false,
        abort() {
          this.stopped = true;
          writeJson(proc, { type: "abort", sessionId });
          // 立即 resolve 为 stopped=true，不依赖 DSH done 帧
          if (proc.waiters.has(sessionId)) {
            proc.waiters.delete(sessionId);
            resolve({
          ok: false, text: "", ms: Date.now() - t0, error: "已停止",
          stopped: true, steps: [], fresh: !warm,
          workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")),
        });
          }
        },
        kill() {
          this.abort();
          setTimeout(() => {
            if (proc.waiters.has(sessionId)) {
              proc.killedByUser = true;
              try { proc.child.kill(); } catch (e) {}
            }
          }, 3000);
        },
      };
      if (typeof spec.onSpawn === "function") { try { spec.onSpawn(job); } catch (e) {} }

      const waiter = {
        onDelta: spec.onDelta,
        onStep: spec.onStep,
        steps: [],
        resolve: (frame) => {
          resolve({
            ok: frame.ok !== false,
            text: frame.text || "",
            ms: frame.ms || (Date.now() - t0),
            error: frame.error || (frame.reasonDetail ? (frame.reasonDetail.code + ": " + frame.reasonDetail.message) : null),
            stopped: frame.stopped === true || frame.canceled === true,
            steps: waiter.steps || [],
            fresh: !warm,
            workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")),
          });
        },
      };
      proc.waiters.set(sessionId, waiter);
      writeJson(proc, { type: "task", sessionId, task: fullTask, model: spec.model });

      // 成功发送后标记 warm（会话在 DSH 侧存活；记录实际 sessionId）
      if (sessionKey) warmSessions.set(sessionKey, { tenantId, sessionId });

      // 超时保护：先按 sessionId 优雅取消，3 秒没收敛再杀进程并返回超时
      setTimeout(() => {
        if (!proc.waiters.has(sessionId)) return;
        writeJson(proc, { type: "abort", sessionId });
        setTimeout(() => {
          if (!proc.waiters.has(sessionId)) return;
          proc.waiters.delete(sessionId);
          proc.killedByUser = true;
          try { proc.child.kill(); } catch (e) {}
          resolve({
            ok: false, code: "TIMEOUT", text: "", ms: Date.now() - t0,
            error: "常驻 DSH 进程响应超时", fresh: !warm,
            workspace, tenantId, keySha256: sha256(String(spec.apiKey || "")),
          });
        }, 3000);
      }, spec.timeoutMs || taskTimeoutMs);

      // 空闲回收：定时扫，超时退出进程
      if (!proc.idleTimer) {
        proc.idleTimer = setInterval(() => {
          if (Date.now() - proc.lastUsed > idleMs && proc.waiters.size === 0) {
            try { clearInterval(proc.idleTimer); proc.idleTimer = null; } catch (e) {}
            writeJson(proc, { type: "exit" });
            setTimeout(() => { try { proc.child.kill(); } catch (e) {} }, 3000);
          }
        }, 60 * 1000);
      }
    });
  }

  function abort(sessionKey) {
    // 按 sessionKey 优雅取消当前轮（P1-4：agent.cancel）
    const sid = String(sessionKey || "").trim();
    if (!sid) return;
    const rec = warmSessions.get(sid);
    const dshSid = (rec && rec.sessionId) || sid;
    for (const proc of persistentProcesses.values()) {
      if (proc && proc.child && proc.child.exitCode === null) {
        writeJson(proc, { type: "abort", sessionId: dshSid });
      }
    }
  }

  function closeSession(sessionKey) {
    const sid = String(sessionKey || "").trim();
    if (!sid) return;
    const rec = warmSessions.get(sid);
    warmSessions.delete(sid);
    const dshSid = (rec && rec.sessionId) || sid;
    for (const proc of persistentProcesses.values()) {
      if (proc && proc.child && proc.child.exitCode === null) {
        writeJson(proc, { type: "close", sessionId: dshSid });
      }
    }
  }

  function close() {
    warmSessions.clear();
    for (const [key, proc] of [...persistentProcesses.entries()]) {
      try { clearInterval(proc.pollTimer); } catch (e) {}
      try { clearInterval(proc.idleTimer); } catch (e) {}
      persistentProcesses.delete(key);
      writeJson(proc, { type: "exit" });
      setTimeout(() => { try { proc.child.kill(); } catch (e) {} }, 3000);
    }
  }

  return { run, abort, closeSession, close };
}

module.exports = {
  createDshRuntime,
  findDshEntry,
  dshMissingHint,
  makeProfile,
};
