"use strict";
/**
 * tenant.cjs —— 多租户租户隔离（U3.2 · 常驻 agent 架构）
 * ============================================================================
 * 变化（相对 v6 headless 一次性 spawn）：
 *   · 每租户一个【常驻 DSH 进程】（懒启动 + 空闲回收），进程内按 sessionId 复用 Agent；
 *   · session 持久（DSH 自己持有轨迹），历史上下文交给 DSH session，不再每问冷启动；
 *   · 与常驻进程之间走 stdin/stdout JSON-lines 协议（见 persistent-runner.mjs）；
 *   · 逐字流式：常驻进程把 text-delta 以 JSON 帧写到输出文件，这里轮询增量回调 onDelta。
 *
 * 保留（与 v6 一致）：
 *   · workspace 隔离（1 用户 = 1 租户）；PT key 只在 spawn 时注入 env，不落盘；
 *   · key 来源三级回退（decryptApiKey / db / PT_U3_STUB_KEYS）；
 *   · 人设 persona 注入（agent-persona.md）；模型读取/选择。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const SHELL = __dirname;
const REPO_ROOT = path.resolve(SHELL, "..");
const RUNTIME = path.join(REPO_ROOT, "runtime");

const WORKSPACES_ROOT = path.join(RUNTIME, "workspaces");
const DSH_HOME = path.join(RUNTIME, "dsh-home");
const SHARED_WORKSPACE = path.join(RUNTIME, "workspace");
const SKILLS_SOURCE = path.join(SHARED_WORKSPACE, ".dsh", "skills");
const TMP = path.join(RUNTIME, "_tmp");
const PERSONA_FILE = path.join(SHELL, "agent-persona.md");
const PERSISTENT_RUNNER = path.join(SHELL, "persistent-runner.mjs");

const NO_API_KEY_CODE = "NO_API_KEY";
const NO_KEY_SOURCE_CODE = "NO_KEY_SOURCE";

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
const DSH = findDshEntry();

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
const SETTINGS_TEMPLATE = path.join(SHELL, "dsh-settings.yaml");
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

function ensureDshHomeConfig(dshHome) {
  const home = dshHome || DSH_HOME;
  const dst = path.join(home, "settings.yaml");
  if (fs.existsSync(dst)) return;
  fs.mkdirSync(home, { recursive: true });
  if (fs.existsSync(SETTINGS_TEMPLATE)) {
    try { fs.copyFileSync(SETTINGS_TEMPLATE, dst); }
    catch (e) { process.stderr.write("[DSH] settings.yaml 播种失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：仓库缺 dsh-settings.yaml 模板，DSH 将回退默认模型路由\n");
  }
}

function makeProfile(dshHome) {
  const home = dshHome || DSH_HOME;
  ensureDshHomeConfig(home);
  const name = PROFILE_NAME;
  const dir = path.join(home, "profiles", name);
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

  // 常驻 patch（每次覆盖，保证与代码一致）
  const patchFile = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(patchFile) || fs.readFileSync(patchFile, "utf8") !== PROFILE_PATCH) {
    fs.writeFileSync(patchFile, PROFILE_PATCH, "utf8");
  }

  // 常驻 runner 插件（每次覆盖，保证最新）
  const runnerFile = path.join(dir, "persistent-runner.mjs");
  if (fs.existsSync(PERSISTENT_RUNNER)) {
    try { fs.copyFileSync(PERSISTENT_RUNNER, runnerFile); }
    catch (e) { process.stderr.write("[DSH] persistent-runner.mjs 复制失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 persistent-runner.mjs（" + PERSISTENT_RUNNER + "）\n");
  }
  return { name, dir };
}

/* ============================================================================
 * 租户 workspace 路径 + 初始化
 * ========================================================================== */
function getTenantWorkspace(tenantId, opts = {}) {
  const root = opts.workspacesRoot || WORKSPACES_ROOT;
  const id = String(tenantId || "").trim();
  if (!id) throw new Error("tenantId 不能为空");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("tenantId 含非法字符：" + id);
  return path.join(root, id);
}

const SKIP_DIRS = new Set(["node_modules", "data"]);
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const t = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith("_")) continue;
      copyDir(s, t);
    } else if (e.isFile()) {
      if (e.name.startsWith("_")) continue;
      fs.copyFileSync(s, t);
    }
  }
}

function initTenantWorkspace(tenantId, opts = {}) {
  const workspace = getTenantWorkspace(tenantId, opts);
  const skillsDir = path.join(workspace, ".dsh", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const source = opts.skillsSource || SKILLS_SOURCE;
  const skills = [];
  let seeded = false;
  if (fs.existsSync(source)) {
    for (const d of fs.readdirSync(source, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const dst = path.join(skillsDir, d.name);
      if (!fs.existsSync(dst)) { copyDir(path.join(source, d.name), dst); seeded = true; }
      skills.push(d.name);
    }
  }
  return { ok: true, workspace, skillsDir, skills, seeded };
}
const ensureTenantWorkspace = initTenantWorkspace;

/* ============================================================================
 * decryptApiKey 来源解析（三级回退）
 * ========================================================================== */
async function stubDecryptApiKey(userId) {
  const raw = process.env.PT_U3_STUB_KEYS || "";
  const map = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return map[String(userId)] || null;
}

async function resolveDecryptApiKey(opts = {}) {
  if (typeof opts.decryptApiKey === "function") return opts.decryptApiKey;
  if (opts.db) {
    const keysMod = require("./keys.cjs");
    const keys = await keysMod.initKeys({ db: opts.db, masterKeyFile: opts.masterKeyFile });
    if (keys && typeof keys.decryptApiKey === "function") return keys.decryptApiKey;
    throw new Error("initKeys 返回的对象缺 decryptApiKey");
  }
  if (process.env.PT_U3_STUB_KEYS) return stubDecryptApiKey;
  return null;
}

/* ============================================================================
 * 人设 / 模型
 * ========================================================================== */
function readPersona() {
  try {
    const t = fs.readFileSync(PERSONA_FILE, "utf8").trim();
    return t || "";
  } catch (e) { return ""; }
}

function readModels() {
  try {
    const txt = fs.readFileSync(SETTINGS_TEMPLATE, "utf8");
    const models = [];
    const re = /- id:\s*(\S+)\s*\n(?:[ \t]+name:\s*(.+))?/g;
    let m;
    while ((m = re.exec(txt))) models.push({ id: m[1], name: (m[2] || m[1]).trim() });
    return models;
  } catch (e) { return []; }
}

function defaultModel() {
  try {
    const txt = fs.readFileSync(SETTINGS_TEMPLATE, "utf8");
    const m = txt.match(/agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/);
    return m ? m[2] : "deepseek-v4-pro";
  } catch (e) { return "deepseek-v4-pro"; }
}

function applyModel(dshHome, model) {
  // 常驻模式下模型走每请求 opts.model，不再写 settings.yaml；
  // 保留此函数仅为兼容旧调用（幂等空操作）。
  return;
}

/* ============================================================================
 * 组装一次常驻调用的 spec（含 env / key，不落盘明文 key）
 * ========================================================================== */
function buildSpec(tenantId, workspace, userId, opts, apiKey) {
  const dshHome = opts.dshHome || DSH_HOME;
  const entry = opts.dshEntry || DSH.js;
  const nodePath = (opts.nodePath !== undefined) ? opts.nodePath : DSH.nodePath;
  const profile = makeProfile(dshHome);

  const env = Object.assign({}, process.env, { DSH_HOME: dshHome });
  if (nodePath) env.NODE_PATH = nodePath;
  env.POWERTOKENS_API_KEY = String(apiKey);

  return {
    env, cwd: workspace, profile, dshHome, entry, userId, tenantId,
    keySha256: sha256(String(apiKey)),
  };
}

/* ============================================================================
 * 常驻进程管理：每租户一个 DSH 进程，stdin/stdout JSON-lines 协议
 * ========================================================================== */
const persistentProcesses = new Map(); // tenantId -> proc
const warmSessions = new Map();        // conversationId -> tenantId（DSH session 是否存活）
const PROC_IDLE_MS = 15 * 60 * 1000;   // 15 分钟空闲回收
const PROC_TASK_TIMEOUT_MS = 3 * 60 * 1000;

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

function getOrSpawnProcess(spec, opts) {
  const key = spec.tenantId;
  const existing = persistentProcesses.get(key);
  if (existing && existing.child && existing.child.exitCode === null && !existing.child.killed) {
    existing.lastUsed = Date.now();
    return { proc: existing, fresh: false };
  }

  // 清理旧进程引用
  if (existing) {
    try { clearInterval(existing.pollTimer); } catch (e) {}
    persistentProcesses.delete(key);
    // 该租户进程已重来，其所有 DSH session 都已丢失
    for (const [cid, tid] of [...warmSessions.entries()]) if (tid === key) warmSessions.delete(cid);
  }

  const tmpDir = opts.tmpDir || TMP;
  fs.mkdirSync(tmpDir, { recursive: true });
  const safe = String(key).replace(/[^A-Za-z0-9_-]/g, "");
  const outFile = path.join(tmpDir, "persist-" + safe + "-" + Date.now().toString(36) + ".txt");
  const errFile = outFile + ".err";
  const fdOut = fs.openSync(outFile, "w");
  const fdErr = fs.openSync(errFile, "w");

  let child;
  try {
    child = spawn(process.execPath, [spec.entry, "--profile", spec.profile.name], {
      cwd: spec.cwd, env: spec.env, stdio: ["pipe", fdOut, fdErr], windowsHide: true,
    });
  } catch (e) {
    try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e2) {}
    return { proc: null, fresh: false, spawnError: String((e && e.message) || e) };
  }

  const proc = {
    child, outFile, errFile, fdOut, fdErr,
    lastSize: 0, lastUsed: Date.now(),
    waiters: new Map(), lineBuf: "", ready: false,
    pollTimer: null, killedByUser: false,
  };
  proc.pollTimer = setInterval(() => pollProc(proc), 50);
  persistentProcesses.set(key, proc);

  child.on("close", () => {
    try { clearInterval(proc.pollTimer); } catch (e) {}
    // 进程退出：所有待处理 waiter 以失败收尾（停止 = killedByUser 标记）
    for (const [sid, w] of [...proc.waiters.entries()]) {
      proc.waiters.delete(sid);
      w.resolve({ ok: false, error: proc.killedByUser ? "已停止" : "常驻 DSH 进程退出", text: "", stopped: proc.killedByUser });
    }
  });

  return { proc, fresh: true };
}

function runDshPersistent(spec, opts) {
  const conversationId = String(opts.conversationId || "").trim();
  const sessionId = conversationId || ("adhoc-" + crypto.randomBytes(6).toString("hex"));

  return new Promise((resolve) => {
    const { proc, fresh, spawnError } = getOrSpawnProcess(spec, opts);
    if (spawnError || !proc) {
      return resolve({
        ok: false, code: "SPAWN", text: "", ms: 0, error: spawnError || "常驻进程启动失败",
        workspace: spec.cwd, tenantId: spec.tenantId, keySha256: spec.keySha256, fresh: false,
      });
    }

    // 新鲜进程 = 无任何存活 session；该会话视为冷启动（补历史）
    const warm = !fresh && warmSessions.get(sessionId) === spec.tenantId;

    // 组装任务：人设 + 长期记忆 + 图片说明 +（冷启动才补历史）+ 当前问题
    const persona = readPersona();
    const parts = [];
    if (persona) parts.push("【系统设定】\n" + persona);
    if (opts.memory) parts.push("用户长期记忆：\n" + opts.memory);
    if (opts.imageNote) parts.push(opts.imageNote);
    if (!warm && opts.history) parts.push("以下是本次对话的历史（仅供理解上下文，不要复述）：\n" + opts.history);
    parts.push("用户现在问：" + String(opts.question || ""));
    const fullTask = parts.join("\n\n");

    const t0 = Date.now();
    // 停止句柄：kill 整个常驻进程（该租户所有会话一并释放；历史靠下次冷启动补回）
    const job = {
      stopped: false,
      kill() {
        this.stopped = true;
        proc.killedByUser = true;
        try { proc.child.kill(); } catch (e) {}
      },
    };
    if (typeof opts.onSpawn === "function") { try { opts.onSpawn(job); } catch (e) {} }

    const waiter = {
      onDelta: opts.onDelta,
      onStep: opts.onStep,
      steps: [],
      resolve: (frame) => {
        resolve({
          ok: frame.ok !== false,
          text: frame.text || "",
          ms: frame.ms || (Date.now() - t0),
          error: frame.error || (frame.reasonDetail ? (frame.reasonDetail.code + ": " + frame.reasonDetail.message) : null),
          stopped: frame.stopped === true,
          steps: waiter.steps || [],
          fresh,
          workspace: spec.cwd, tenantId: spec.tenantId, userId: spec.userId, keySha256: spec.keySha256,
        });
      },
    };
    proc.waiters.set(sessionId, waiter);
    writeJson(proc, { type: "task", sessionId, task: fullTask, model: opts.model });

    // 成功发送后标记 warm（会话在 DSH 侧存活）
    if (conversationId) warmSessions.set(sessionId, spec.tenantId);

    // 超时保护
    setTimeout(() => {
      if (proc.waiters.has(sessionId)) {
        proc.waiters.delete(sessionId);
        resolve({
          ok: false, code: "TIMEOUT", text: "", ms: Date.now() - t0,
          error: "常驻 DSH 进程响应超时", fresh,
          workspace: spec.cwd, tenantId: spec.tenantId, keySha256: spec.keySha256,
        });
      }
    }, opts.timeoutMs || PROC_TASK_TIMEOUT_MS);

    // 空闲回收：定时扫，超时退出进程
    if (!proc.idleTimer) {
      proc.idleTimer = setInterval(() => {
        if (Date.now() - proc.lastUsed > PROC_IDLE_MS && proc.waiters.size === 0) {
          try { clearInterval(proc.idleTimer); proc.idleTimer = null; } catch (e) {}
          writeJson(proc, { type: "exit" });
          setTimeout(() => { try { proc.child.kill(); } catch (e) {} }, 3000);
        }
      }, 60 * 1000);
    }
  });
}

function closeDshSession(conversationId) {
  // 关掉某个对话对应的 DSH session（删对话时调用）
  const sid = String(conversationId || "").trim();
  if (!sid) return;
  warmSessions.delete(sid);
  for (const proc of persistentProcesses.values()) {
    if (proc && proc.child && proc.child.exitCode === null) {
      writeJson(proc, { type: "close", sessionId: sid });
    }
  }
}

/* ============================================================================
 * runDshForUser(userId, question, opts) —— 常驻版
 * ========================================================================== */
async function runDshForUser(userId, question, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, code: "NO_USER", error: "缺少 userId" };
  if (!String(question || "").trim()) return { ok: false, code: "NO_TASK", error: "任务不能为空" };

  const tenantId = String(opts.tenantId || userId || "").trim();
  const { workspace } = initTenantWorkspace(tenantId, opts);

  let decrypt = null;
  try {
    decrypt = await resolveDecryptApiKey(opts);
  } catch (e) {
    return { ok: false, code: "DECRYPT_FAILED", error: "初始化 key 解密失败：" + (e && e.message ? e.message : e), workspace, tenantId };
  }
  if (!decrypt) {
    return { ok: false, code: NO_KEY_SOURCE_CODE,
             error: "服务端没接到 PT key 解密来源（未传 decryptApiKey / db，也未设 PT_U3_STUB_KEYS）", workspace, tenantId };
  }

  let apiKey = null;
  try {
    apiKey = await decrypt(uid);
  } catch (e) {
    return { ok: false, code: "DECRYPT_FAILED", error: "读不到你的 PT key：" + (e && e.message ? e.message : e), workspace, tenantId };
  }
  if (!apiKey || !String(apiKey).trim()) {
    return { ok: false, code: NO_API_KEY_CODE,
             error: "还没保存你的 PT key（BYOK）。请先到「设置」页保存 key，再开始对话。", workspace, tenantId };
  }

  const spec = buildSpec(tenantId, workspace, userId, opts, apiKey);
  if (opts.dryRun) return { ok: true, dryRun: true, ...spec };
  return runDshPersistent(spec, opts);
}

module.exports = {
  WORKSPACES_ROOT,
  DSH_HOME,
  NO_API_KEY_CODE,
  NO_KEY_SOURCE_CODE,
  getTenantWorkspace,
  initTenantWorkspace,
  ensureTenantWorkspace,
  runDshForUser,
  closeDshSession,
  resolveDecryptApiKey,
  findDshEntry,
  dshMissingHint,
  makeProfile,
  stubDecryptApiKey,
  readModels,
  defaultModel,
  applyModel,
};
