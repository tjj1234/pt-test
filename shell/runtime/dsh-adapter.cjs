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
const { assembleSystemPrompt } = require("./contract.cjs");
const artifactsMod = require("./artifacts.cjs");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");


/* ---- 产出文件（artifact）识别：B2「生成 PDF/HTML + 左侧预览」----
 * DSH 侧写文件的工具名各家不一（write_file / Write / fs_write / create_file…），
 * 而且 Agent 用 bash + python 生成 PDF 时根本不经过工具调用帧。
 * 所以这里只是「提前量」：一旦认出写文件调用就立刻通知前端先把面板弹出来；
 * 认不出来也没关系 —— 任务结束时 collectArtifacts(dir) 会扫目录兜底，那才是准的。
 */

/** 这个工具名像不像「写文件」（宽松匹配，宁可多认也别漏；认错只是多弹一次面板）。 */
function toolWroteFile(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/^(write|create|save|new)_?(file|files|document|doc)s?$/i.test(n)) return true;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(n)) return true;
  if (/(file_write|fs_write|write_to_file|write_file|create_file|save_file)/i.test(n)) return true;
  return false;
}

/** 从工具入参里掏出文件路径。args 可能是对象，也可能是被 stringify（甚至截断）的字符串。 */
function pathFromToolArgs(args) {
  let a = args;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch (e) {
      const m = a.match(/"(?:path|file_path|filePath|filename|file_name|target_file|file)"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    }
  }
  if (!a || typeof a !== "object") return null;
  for (const k of ["path", "file_path", "filePath", "filename", "file_name", "target_file", "file"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * 把工具调用里写的路径换算成 workspace 相对路径（/api/artifact 只认相对路径）。
 * 绝对路径且在 workspace 内 -> 取相对部分；绝对路径在 workspace 外或本身就是相对路径 -> 退化为文件名
 * （Agent 常见的写法是相对 workspace 根的 "report.pdf"，或绝对路径 <ws>/out/report.pdf）。
 */
function artifactRelFromToolPath(workspace, p) {
  const raw = String(p || "").trim();
  if (!raw) return null;
  const base = raw.split(/[\\/]+/).pop();
  if (!artifactsMod.isArtifactName(base)) return null;
  const norm = raw.split(/[\\/]+/).join("/");
  if (/^[a-zA-Z]:\//.test(norm) || norm.charAt(0) === "/") {
    const ws = String(workspace || "").split(/[\\/]+/).join("/").replace(/\/+$/, "");
    if (ws && norm.indexOf(ws + "/") === 0) return norm.slice(ws.length + 1);
    return base;
  }
  const clean = norm.replace(/^\.\//, "");
  return artifactsMod.isSafeRel(clean) ? clean : base;
}

/** 一条工具调用 step 是否写了可预览文件；是则返回归一化产物，否则 null（不影响兜底扫描）。 */
function artifactFromToolStep(step, workspace) {
  if (!step || step.isError) return null;
  if (!toolWroteFile(step.name)) return null;
  const p = pathFromToolArgs(step.args);
  if (!p) return null;
  const rel = artifactRelFromToolPath(workspace, p);
  if (!rel) return null;
  return artifactsMod.normalizeArtifact({
    name: rel.split("/").pop(), rel, size: 0, mtime: Date.now(),
  });
}

/** 任务收尾时扫目录，捞出本轮期间新增/改过的可预览文件。扫不动就返回 []，绝不抛错。 */
function collectRoundArtifacts(workspace, sinceMs) {
  return artifactsMod.collectArtifacts(workspace, sinceMs, { maxFiles: 20 });
}

/* 视频生成（文生视频 / 图生视频）内部轮询预算是 1 小时
 * （business/media/powertokens.cjs：pollVideoTask 的本地守护超时 3600000ms）。
 * 外层 DSH 任务超时必须给足余量，否则会被默认 3 分钟预算提前掐断 ——
 * 表现为「视频还没生成完就被 abort，前端只显示一句分不清原因的『已停止』」。
 */
const VIDEO_TASK_TIMEOUT_MS = 65 * 60 * 1000;

/** 视频类 media_route 任务（与前端 mediaRouteStepMessage 的判定保持一致）。 */
function isVideoTaskType(taskType) {
  return taskType === "text2video" || taskType === "image2video";
}

/**
 * 从 media_route 步骤的 args 里取 taskType。
 * args 可能是对象，也可能是 JSON 字符串 —— 基座下发工具入参时会 stringify 并截断
 * （truncate 200 字符），截断会让 JSON.parse 失败，所以解析失败时退回正则兜底。
 */
function mediaRouteTaskType(args) {
  if (args == null) return null;
  if (typeof args === "object") return args.taskType || null;
  if (typeof args !== "string") return null;
  try {
    const o = JSON.parse(args);
    if (o && typeof o === "object") return o.taskType || null;
  } catch (e) { /* 截断导致 JSON 不完整，走下面的正则兜底 */ }
  const m = args.match(/"taskType"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

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

  // media.route 依赖的 PowerTokens 调用层：与 persistent-runner.mjs 同目录，
  // 供其 createRequire(import.meta.url) + require("./powertokens.cjs") 引用。
  const mediaModule = persistentRunner
    ? path.resolve(path.dirname(persistentRunner), "..", "business", "media", "powertokens.cjs")
    : null;
  if (mediaModule && fs.existsSync(mediaModule)) {
    try { fs.copyFileSync(mediaModule, path.join(dir, "powertokens.cjs")); }
    catch (e) { process.stderr.write("[DSH] powertokens.cjs 复制失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 business/media/powertokens.cjs（" + mediaModule + "）\n");
  }

  // media.route 风格预设：powertokens.cjs / persistent-runner.mjs 都 require("./presets.cjs")，
  // 需一并复制到 profile 同目录。
  const presetsModule = persistentRunner
    ? path.resolve(path.dirname(persistentRunner), "..", "business", "media", "presets.cjs")
    : null;
  if (presetsModule && fs.existsSync(presetsModule)) {
    try { fs.copyFileSync(presetsModule, path.join(dir, "presets.cjs")); }
    catch (e) { process.stderr.write("[DSH] presets.cjs 复制失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 business/media/presets.cjs（" + presetsModule + "）\n");
  }

  // ga.query 依赖的 GA4 连接器 executor（自包含：仅 node:http/node:crypto）：
  // persistent-runner.mjs 按相对路径 require("./ga-query-executor.cjs")。
  const gaQueryModule = persistentRunner
    ? path.resolve(path.dirname(persistentRunner), "..", "business", "attribution", "ga-connector", "executor.js")
    : null;
  if (gaQueryModule && fs.existsSync(gaQueryModule)) {
    try { fs.copyFileSync(gaQueryModule, path.join(dir, "ga-query-executor.cjs")); }
    catch (e) { process.stderr.write("[DSH] ga-query-executor.cjs 复制失败：" + e.message + "\n"); }
  } else {
    process.stderr.write("[DSH] 警告：缺 business/attribution/ga-connector/executor.js（" + gaQueryModule + "）\n");
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
        if (!w) break;
        if (frame.phase === "call") {
          // 工具调用开始：先记到待合并区（按 callId），并把「开始」步下发给前端展示过程。
          if (frame.callId != null) {
            if (!w.pendingSteps) w.pendingSteps = new Map();
            w.pendingSteps.set(frame.callId, { name: frame.name, args: frame.args });
          }
          // 观察到 agent 真的发起了视频类 media_route：把这一轮的超时预算放宽到 65 分钟。
          // 不能只依赖前端预先声明的 taskType —— 自动模式下前端不传 taskType，只能靠这里动态识别。
          if (frame.name === "media_route" && isVideoTaskType(mediaRouteTaskType(frame.args))) {
            if (w && typeof w.extendDeadline === "function") w.extendDeadline(VIDEO_TASK_TIMEOUT_MS);
          }
          if (typeof w.onStep === "function") { try { w.onStep({ name: frame.name, args: frame.args }); } catch (e) {} }
        } else {
          // 工具调用结束：与开始帧合并成一条 step（带真实耗时），供 tool_calls 日志补记；
          // 同时把「结束」步下发给前端展示结果 / 错误。
          let pending = null;
          if (frame.callId != null && w.pendingSteps) {
            pending = w.pendingSteps.get(frame.callId);
            w.pendingSteps.delete(frame.callId);
          }
          const step = {
            name: frame.name || (pending && pending.name) || "tool",
            args: pending ? pending.args : frame.args,
            result: frame.result,
            isError: frame.isError,
            durationMs: frame.durationMs,
            modelName: frame.modelName,
          };
          if (Array.isArray(w.steps)) w.steps.push(step);
          if (typeof w.onStep === "function") { try { w.onStep({ name: step.name, args: step.args, result: step.result, isError: step.isError }); } catch (e) {} }
          // 认出「写了一个可预览文件」就立刻通知前端弹面板（提前量；准不准由收尾扫描兜底）
          if (typeof w.onArtifact === "function") {
            const art = artifactFromToolStep(step, w.wsDir);
            if (art) { try { w.onArtifact(art); } catch (e) {} }
          }
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
          if (w) { proc.waiters.delete(sid); w.resolve({ ok: false, error: frame.message, text: "", steps: w.steps || [] }); }
        }
        break;
      }
      case "aborted": {
        const sid = frame.sessionId;
        if (sid) {
          const w = proc.waiters.get(sid);
          if (w) {
            proc.waiters.delete(sid);
            const byTimeout = w.timedOut === true || proc.timedOut === true;
            w.resolve({
              ok: false, text: "", stopped: true,
              error: byTimeout ? "生成超时，已中断" : "已停止",
              stopReason: byTimeout ? "timeout" : "user",
              steps: w.steps || [],
            });
          }
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
      existing.userId = spec.userId; // 记录最近一次使用该进程的 userId，供活跃心跳目标解密 key
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
      userId: spec.userId,               // 该常驻进程属于哪个 userId（1 用户 = 1 租户）
      lastSize: 0, lastUsed: Date.now(),
      waiters: new Map(), lineBuf: "", ready: false,
      pollTimer: null, killedByUser: false, timedOut: false, idleTimer: null,
    };
    proc.pollTimer = setInterval(() => pollProc(proc), 50);
    persistentProcesses.set(key, proc);

    child.on("close", () => {
      try { clearInterval(proc.pollTimer); } catch (e) {}
      for (const [sid, w] of [...proc.waiters.entries()]) {
        proc.waiters.delete(sid);
        const byTimeout = proc.timedOut === true;
        w.resolve({
          ok: false, text: "",
          error: byTimeout ? "生成超时，已中断" : (proc.killedByUser ? "已停止" : "常驻 DSH 进程退出"),
          stopped: proc.killedByUser || byTimeout,
          stopReason: byTimeout ? "timeout" : (proc.killedByUser ? "user" : undefined),
          steps: w.steps || [],
        });
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

      // M4：系统提示四段式组装（基础/约束/上下文/能力 + 记忆/图片/历史/问题）。
      // 历史仅冷启动注入（热会话由 DSH session 持有轨迹）。
      const fullTask = assembleSystemPrompt({
        persona: spec.persona,
        constraints: spec.constraints,
        capabilities: spec.capabilities,
        context: spec.context,
        memory: spec.memory,
        imageNote: spec.imageNote,
        docNote: spec.docNote,
        mediaNote: spec.mediaNote,
        gaNote: spec.gaNote,
        history: !warm ? spec.history : undefined,
        question: spec.question,
      });

      const t0 = Date.now();
      let waiter; // 声明提前，供 job.abort() 引用 steps（避免 TDZ）
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
          stopped: true, stopReason: "user", steps: waiter.steps || [], fresh: !warm,
          artifacts: collectRoundArtifacts(workspace, t0),
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

      waiter = {
        onArtifact: spec.onArtifact,
        wsDir: workspace,
        onDelta: spec.onDelta,
        onStep: spec.onStep,
        timedOut: false,
        extendDeadline,
        steps: [],
        resolve: (frame) => {
          const stopped = frame.stopped === true || frame.canceled === true || waiter.timedOut === true;
          const stopReason = stopped ? (frame.stopReason || (waiter.timedOut ? "timeout" : "user")) : undefined;
          resolve({
            ok: frame.ok !== false,
            text: frame.text || "",
            media: Array.isArray(frame.media) ? frame.media : null,
            artifacts: collectRoundArtifacts(workspace, t0),
            report: frame.report || null,
            usage: frame.usage || null,
            ms: frame.ms || (Date.now() - t0),
            error: frame.error || (frame.reasonDetail ? (frame.reasonDetail.code + ": " + frame.reasonDetail.message) : null),
            stopped,
            stopReason,
            steps: waiter.steps || [],
            fresh: !warm,
            workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")),
          });
        },
      };
      proc.waiters.set(sessionId, waiter);
      writeJson(proc, { type: "task", sessionId, task: fullTask, model: spec.model, tenantId });

      // 成功发送后标记 warm（会话在 DSH 侧存活；记录实际 sessionId）
      if (sessionKey) warmSessions.set(sessionKey, { tenantId, sessionId });

      // 超时保护：先按 sessionId 优雅取消，3 秒没收敛再杀进程并返回超时。
      // deadline 可被 extendDeadline() 动态放宽 —— 视频生成等长任务靠它把 3 分钟提到 65 分钟。
      const budget0 = spec.timeoutMs || taskTimeoutMs;
      let deadline = Date.now() + budget0;
      let timeoutTimer = setTimeout(fireTimeout, budget0);
      function fireTimeout() {
        if (!proc.waiters.has(sessionId)) return;
        proc.timedOut = true;                    // 标记「这一轮是被超时掐断的」，与用户手动停止区分
        const w0 = proc.waiters.get(sessionId);
        if (w0) w0.timedOut = true;
        writeJson(proc, { type: "abort", sessionId });
        setTimeout(() => {
          if (!proc.waiters.has(sessionId)) return;
          proc.waiters.delete(sessionId);
          proc.killedByUser = true;
          try { proc.child.kill(); } catch (e) {}
          resolve({
            ok: false, code: "TIMEOUT", text: "", ms: Date.now() - t0,
            error: "生成超时，已中断", stopped: true, stopReason: "timeout", steps: w0 ? (w0.steps || []) : [], fresh: !warm,
            artifacts: collectRoundArtifacts(workspace, t0),
            workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")),
          });
        }, 3000);
      }
      /** 放宽这一轮的超时预算到 now + ms（只放宽、不收紧），供视频生成等长任务动态提额。 */
      function extendDeadline(ms) {
        const now = Date.now();
        const next = now + ms;
        if (next <= deadline) return false;
        deadline = next;
        try { clearTimeout(timeoutTimer); } catch (e) {}
        timeoutTimer = setTimeout(fireTimeout, Math.max(0, deadline - now));
        return true;
      }

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

  // 保活心跳：走与真实对话完全相同的 DSH 进程 + runner task 路径，向默认模型发一个
  // 最小成本请求，目的仅是让底层 newapi 网关与上游模型的连接保持活跃，避免空闲回收后
  // 首字要重新走 TCP/TLS 握手（实测可达 35 秒）。不注册业务 waiter、不经过 shell 的
  // runningJobs 锁；每次用全新 sessionId，用完即 close，避免 agentMap 内存堆积与上下文增长。
  function pulse(spec) {
    const tenantId = String(spec.tenantId || "").trim();
    return new Promise((resolve) => {
      // 心跳只针对「已存在且仍存活」的常驻进程，绝不为其冷启动新进程：
      // 这样才不会把心跳浪费在很久没登录、进程早已被回收的账号上。
      const proc = persistentProcesses.get(tenantId);
      if (!proc || !proc.child || proc.child.exitCode !== null || proc.child.killed) {
        return resolve({ ok: false, skipped: true, error: "非活跃租户，跳过心跳（常驻进程已被回收）" });
      }
      const sessionId = "hb-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
      const task = String(spec.prompt || "ping").trim();
      const t0 = Date.now();
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        writeJson(proc, { type: "close", sessionId }); // 用完即弃，防内存堆积 / 上下文增长
        resolve(r);
      };
      const waiter = {
        onDelta: () => {},
        onStep: () => {},
        steps: [],
        resolve: (frame) => finish({ ok: frame.ok !== false, ms: frame.ms || (Date.now() - t0), error: frame.error || null, usage: frame.usage || null }),
      };
      proc.waiters.set(sessionId, waiter);
      writeJson(proc, { type: "task", sessionId, task, model: spec.model, tenantId });
      setTimeout(() => {
        if (proc.waiters.has(sessionId)) {
          proc.waiters.delete(sessionId);
          finish({ ok: false, error: "保活请求超时" });
        }
      }, spec.timeoutMs || 60000);
    });
  }

  // 返回当前仍存活的常驻进程租户列表（即「最近还在用」的租户）。
  // 每个元素带 tenantId + userId（用于解密该租户的 PT key）+ lastUsed。
  function activeTenants() {
    const out = [];
    for (const [tenantId, proc] of persistentProcesses.entries()) {
      if (proc && proc.child && proc.child.exitCode === null && !proc.child.killed) {
        out.push({ tenantId, userId: proc.userId || tenantId, lastUsed: proc.lastUsed || null });
      }
    }
    return out;
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

  return { run, pulse, activeTenants, abort, closeSession, close };
}

module.exports = {
  toolWroteFile,
  pathFromToolArgs,
  artifactRelFromToolPath,
  artifactFromToolStep,
  collectRoundArtifacts,
  VIDEO_TASK_TIMEOUT_MS,
  mediaRouteTaskType,
  isVideoTaskType,
  createDshRuntime,
  findDshEntry,
  dshMissingHint,
  makeProfile,
};
