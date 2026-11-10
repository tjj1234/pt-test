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
const { spawn } = require("child_process");
const { assembleSystemPrompt } = require("./contract.cjs");
const artifactsMod = require("./artifacts.cjs");
const { normalizeModelIdentity } = require("./usage.cjs");

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
  try {
    const verified = require("./dsh-installation.cjs").resolveDshInstallation({ explicitEntry: explicit, envEntry: process.env.DSH_JS });
    const installation = {
      source: "host_release_verification", version: verified.version,
      manifestSha256: verified.manifestSha256, vendorSha256: verified.vendorSha256,
      lockfileSha256: verified.lockfileSha256, packageFileCount: verified.packageFileCount,
      scope: "dsh-cli-package-only",
    };
    return { js: verified.entry, nodePath: null, installation };
  } catch (error) {
    return { js: null, nodePath: null, code: error.code || "DSH_INSTALLATION_INVALID", error: "DSH 发布安装校验失败" };
  }
}

function dshMissingHint() {
  return "DSH 发布安装校验失败。请用 shell/package-lock.json 恢复仓库内安装，核对 runtime/dsh-release-manifest.json 与 vendor 发布包。DSH_JS/--dsh 仅可指向该包的绝对 lib/bin.js 路径。";
}

/* ============================================================================
 * profile：常驻 profile（dsh-base + persistent-runner，无 headless）
 * ========================================================================== */
const PROFILE_NAME = "run-persistent";
const RPC_PROTOCOL_VERSION = 1;
const RUNNER_CONTROL_ERRORS = Object.freeze({
  RUNNER_SETUP_FAILED: "Persistent runner setup failed",
  RUNNER_QUEUE_FAILED: "Parent command could not be processed",
  PARENT_FRAME_INVALID: "Parent frame is not valid JSON",
  PARENT_COMMAND_UNSUPPORTED: "Parent command is not supported",
  TASK_FRAME_INVALID: "Parent task frame is invalid",
  PROTOCOL_VERSION_MISMATCH: "Parent protocol version mismatch",
});
const RUNNER_CONTROL_ERROR_FALLBACK = "DSH runner reported a control error";

function normalizeRunnerControlError(frame) {
  const candidate = typeof frame?.code === "string" ? frame.code : "";
  const code = Object.prototype.hasOwnProperty.call(RUNNER_CONTROL_ERRORS, candidate) ? candidate : "DSH_RUNNER_ERROR";
  return { code, error: RUNNER_CONTROL_ERRORS[code] || RUNNER_CONTROL_ERROR_FALLBACK };
}
const PROFILE_FORMAT_VERSION = 1;
const PROFILE_MANIFEST = "northstar-profile-manifest.json";
const PROFILE_SOURCE_FILES = Object.freeze({
  "run-budget-billing.json":runner=>path.resolve(path.dirname(runner),"runtime/run-budget-billing.json"),
  "native-web-provider.mjs":runner=>path.resolve(path.dirname(runner),'runtime/native-web-provider.mjs'),
  "run-budget-web.json":runner=>path.resolve(path.dirname(runner),'runtime/run-budget-web.json'),
  "persistent-runner.mjs": (runner) => runner,
  "powertokens.cjs": (runner) => path.resolve(path.dirname(runner), "..", "business", "media", "powertokens.cjs"),
  "presets.cjs": (runner) => path.resolve(path.dirname(runner), "..", "business", "media", "presets.cjs"),
  "ga-query-executor.cjs": (runner) => path.resolve(path.dirname(runner), "..", "business", "attribution", "ga-connector", "executor.js"),
  "budget.cjs": (runner) => path.resolve(path.dirname(runner), "tasks", "budget.cjs"),
  "usage.cjs": (runner) => path.resolve(path.dirname(runner), "runtime", "usage.cjs"),
  "dsh-native-context-r4-candidate.mjs": (runner) => path.resolve(path.dirname(runner), "runtime", "dsh-native-context-r4-candidate.mjs"),
  "published-skill-provider.mjs": (runner) => path.resolve(path.dirname(runner), "runtime", "published-skill-provider.mjs"),
  "skill-release-snapshot.cjs": (runner) => path.resolve(path.dirname(runner), "skills", "release-snapshot.cjs"),
  "native-image-message.mjs": (runner) => path.resolve(path.dirname(runner), "runtime", "native-image-message.mjs"),
  "native-question-provider.mjs": (runner) => path.resolve(path.dirname(runner), "runtime", "native-question-provider.mjs"),
  "run-budget-questions.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-questions.json"),
  "run-budget.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget.json"),
  "run-budget-skill.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-skill.json"),
  "run-budget-skill-csv.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-skill-csv.json"),
  "run-budget-skill-media.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-skill-media.json"),
  "run-budget-csv.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-csv.json"),
  "run-budget-media.json": (runner) => path.resolve(path.dirname(runner), "runtime", "run-budget-media.json"),
});
const PROFILE_PATCH = [
  "- id: web", "  config:", "    searchProvider: northstar-host", "    fetchProvider: northstar-host", "",
  "- id: hmr",
  "  disabled: true",
  ...["session-title-llm", "command-compact", "tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "skill-filesystem", "subagent", "subagent-spawn-in-process", "subagent-fork-in-process", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork", "tool-subagent-report", "workflow-worker-thread", "tool-workflow", "tool-result-pruner", "tool-todo", "tool-goal", "tool-ralph", "tool-str-replace-editor", "repeat-tool-reminder", "tool-web"].flatMap((id) => ["", `- id: ${id}`, "  disabled: true"]),
  "",
  "- id: compaction-basic",
  "  config:",
  "    maxTokens: 128",
  "    compactionRetries: 0",
  "",
  "- insert:",
  "    - id: northstar-patch-watch-compat",
  "      name: './northstar-patch-watch-compat.mjs'",
  "    - id: persistent-runner",
  "      name: './persistent-runner.mjs'",
  "      inject: [agentDefaultModel, agents, sessions, attachments, userQuestions, tools]",
  "",
].join("\n");

function profileManifest(files) {
  return {
    formatVersion: PROFILE_FORMAT_VERSION,
    rpcProtocolVersion: RPC_PROTOCOL_VERSION,
    files: Object.fromEntries(Object.keys(files).sort().map((name) => [
      name,
      crypto.createHash("sha256").update(files[name]).digest("hex"),
    ])),
  };
}

function profileError(code, message) {
  return Object.assign(new Error(message), { code });
}

function profileFiles(persistentRunner) {
  if (typeof persistentRunner !== "string" || !fs.existsSync(persistentRunner)) {
    throw profileError("PROFILE_SOURCE_MISSING", "Persistent DSH runner source is unavailable");
  }
  const { buildProfileDependencyContract, PROFILE_DEPENDENCY_FILE } = require("./profile-dependencies.cjs");
  const dependencyContract = buildProfileDependencyContract({
    plugins: ["@deepseek-ai/dsh-tool-ask-user","@deepseek-ai/dsh-tool-web"],
    lockfile: fs.readFileSync(path.resolve(__dirname, "../package-lock.json")),
    npmrc: fs.readFileSync(path.resolve(__dirname, "../.npmrc")),
  });
  const packageJson = JSON.stringify({
    name: "dsh-profile-" + PROFILE_NAME, private: true, dependencies: dependencyContract.dependencies,
    dsh: { profile: { bundles: dependencyContract.bundles } },
  });
  const files = {
    "package.json": Buffer.from(packageJson),
    [PROFILE_DEPENDENCY_FILE]: Buffer.from(JSON.stringify(dependencyContract.releaseInput, null, 2) + "\n"),
    "pnpm-workspace.yaml": Buffer.from("packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"),
    "cordis.patch.yml": Buffer.from(PROFILE_PATCH),
    // This DSH release's app-boot unconditionally asks hmr.registerConfig()
    // to watch user patch layers, but the locked cordis-plugin-hmr API has no
    // registerConfig method. Northstar uses a generated, manifest-covered
    // no-op service: runtime config changes take effect on process restart.
    // This avoids enabling broad filesystem HMR in a tenant DSH profile.
    "northstar-patch-watch-compat.mjs": Buffer.from([
      "export default (ctx) => {",
      "  ctx.provide('hmr', {",
      "    async registerConfig(filename) {",
      "      if (typeof filename !== 'string' || !filename) throw new TypeError('patch filename is required');",
      "      return async () => {};",
      "    },",
      "  });",
      "};",
      "",
    ].join("\n")),
  };
  for (const [targetName, resolveSource] of Object.entries(PROFILE_SOURCE_FILES)) {
    const source = resolveSource(persistentRunner);
    if (!fs.existsSync(source)) throw profileError("PROFILE_SOURCE_MISSING", `Required profile source is missing: ${targetName}`);
    try { files[targetName] = fs.readFileSync(source); }
    catch { throw profileError("PROFILE_SOURCE_UNREADABLE", `Required profile source is unreadable: ${targetName}`); }
  }
  return files;
}

function makeProfile(dshHome, settingsTemplate, persistentRunner) {
  const files = profileFiles(persistentRunner);
  return require("./profile-lifecycle.cjs").manageProfile({
    dshHome, settingsTemplate, files, manifest: profileManifest(files),
  });
}

// Explicit maintenance only: callers must stop runtime processes before upgrade
// or recovery. Automatic startup never rebuilds or takes over stale locks.
function rebuildProfile(dshHome, settingsTemplate, persistentRunner) {
  const files = profileFiles(persistentRunner);
  return require("./profile-lifecycle.cjs").manageProfile({
    dshHome, settingsTemplate, files, manifest: profileManifest(files), mode: "rebuild",
  });
}
function recoverProfile(dshHome, recovery) {
  return require("./profile-lifecycle.cjs").manageProfile({ dshHome, mode: "recover", recovery });
}

/* ============================================================================
 * 子进程环境白名单 + 身份隔离（C2 安全边界）
 * ============================================================================
 * DSH 子进程不再继承父进程完整 process.env：原来 Object.assign({}, process.env)
 * 会把服务端自己的密钥 / DB 连接串 / 登录口令 / 模型 API Key / 看板只读 token 等
 * 原样透给每个租户的子进程。这里改成白名单：
 *   · 只复制平台运行必需的键（PATH / HOME / TEMP / Windows SystemRoot …）；
 *   · 只显式注入业务真正需要的键（DSH_HOME / NODE_PATH / POWERTOKENS_*）。
 * 其余一律不下发。
 */

// 平台运行必需变量：缺失时 node 自身或 DSH/npm 会直接起不来（跨平台白名单）。
const RUNTIME_ENV_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
  "LANG", "LC_ALL", "LC_CTYPE",
];

function buildDshChildEnv(parentEnv, opts = {}) {
  const env = {};
  for (const k of RUNTIME_ENV_KEYS) {
    if (parentEnv && parentEnv[k] != null) env[k] = parentEnv[k];
  }
  if (opts.dshHome != null) env.DSH_HOME = String(opts.dshHome);
  if (opts.nodePath) env.NODE_PATH = opts.nodePath;
  if (opts.powerTokensApiKey != null) env.POWERTOKENS_API_KEY = String(opts.powerTokensApiKey);
  if (opts.powerTokensBaseUrl) env.POWERTOKENS_BASE_URL = opts.powerTokensBaseUrl;
  return env;
}

/**
 * 子进程 OS 身份隔离评估（C2）：
 *   · Windows：spawn 不支持 uid/gid，无法做 OS 级身份隔离 —— 依赖「每租户 cwd
 *     工作目录隔离 + 白名单 env」这一层，返回空身份。
 *   · POSIX：仅当调用方显式通过 opts.childUid / opts.childGid（或 PT_DSH_UID /
 *     PT_DSH_GID）提供、且父进程具备降权能力时，才设置 uid/gid；默认不自动猜测，
 *     避免在无特权环境下把 spawn 搞挂。未配置时返回空身份。
 */
function buildSpawnIdentity(opts = {}) {
  if (process.platform === "win32") return {};
  const uid = opts.childUid != null ? opts.childUid : (process.env.PT_DSH_UID ? Number(process.env.PT_DSH_UID) : undefined);
  const gid = opts.childGid != null ? opts.childGid : (process.env.PT_DSH_GID ? Number(process.env.PT_DSH_GID) : undefined);
  const identity = {};
  if (Number.isInteger(uid) && uid >= 0) identity.uid = uid;
  if (Number.isInteger(gid) && gid >= 0) identity.gid = gid;
  return identity;
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
  const abortGraceMs = Number.isSafeInteger(opts.abortGraceMs) && opts.abortGraceMs >= 0 ? opts.abortGraceMs : 3000;

  const persistentProcesses = new Map(); // tenantId -> proc
  const warmSessions = new Map();        // sessionKey -> { tenantId, sessionId }

  function writeJson(proc, obj) {
    if(obj.type==='task'&&obj.pinnedSkills?.skills?.length&&!proc.capabilities?.includes('skill-pins-v1')){failRunnerProcess(proc,'DSH_SKILL_PINS_UNSUPPORTED','DSH runner does not support pinned published skills');return;}

    if(obj.type==='task'&&(obj.resume===true||obj.compact===true)&&!proc.capabilities?.includes('native-context-v1')){failRunnerProcess(proc,'DSH_CONTEXT_UNSUPPORTED','DSH runner does not support native context restoration or maintenance');return;}

    if (obj.type === "task" && obj.reasoningEffort !== undefined && !proc.capabilities?.includes("reasoning-selection-v1")) {
      failRunnerProcess(proc,"DSH_REASONING_UNSUPPORTED","DSH runner does not support explicit reasoning selection"); return;
    }
    if (obj.type === "task" && obj.recordModelIntents === true && !proc.capabilities?.includes("model-intent-v1")) {
      failRunnerProcess(proc, "DSH_MODEL_INTENT_UNSUPPORTED", "DSH runner does not support durable model intents");
      return;
    }
    try { proc.child.stdin.write(JSON.stringify(obj) + "\n"); } catch (e) { /* 进程已退 */ }
  }

  function clearToolRequests(proc, sessionId) {
    if (!proc.toolRequests) return;
    for (const [requestId, pending] of [...proc.toolRequests.entries()]) {
      if (sessionId != null && pending.sessionId !== sessionId) continue;
      proc.toolRequests.delete(requestId);
      try { pending.controller.abort(); } catch (e) {}
    }
  }

  function retireDrainingProcess(proc) {
    if (!proc.draining || proc.waiters.size || proc.retireScheduled) return;
    proc.retireScheduled = true;
    writeJson(proc, { type: "exit", protocolVersion: RPC_PROTOCOL_VERSION });
    setTimeout(() => { try { proc.child.kill(); } catch (e) {} }, abortGraceMs);
  }

  function maybeEscalateAbort(proc) {
    if (!proc.draining) return;
    const waiters = [...proc.waiters.values()];
    const canEscalate = (waiter) => waiter.abortGraceExpired === true
      && (waiter.timedOut || waiter.abortRequested);
    if (waiters.some((waiter) => !canEscalate(waiter))) {
      proc.timeoutKillDeferred = true;
      return;
    }
    if (waiters.length) {
      if (proc.timeoutKillStarted) return;
      proc.timeoutKillStarted = true;
      // A stopped turn still owns its lease until it drains or the shared
      // process actually exits. Never settle it merely because kill was sent.
      try { proc.child.kill(); } catch (e) {}
      return;
    }
    retireDrainingProcess(proc);
  }

  function requestWaiterAbort(proc, sessionId, reason = "user") {
    const waiter = proc.waiters.get(sessionId);
    const wasPending = proc.pendingTasks.delete(sessionId);
    clearToolRequests(proc, sessionId);
    if (!waiter) return wasPending;
    if (reason === "timeout") {
      waiter.timedOut = true;
      proc.draining = true;
    }
    const currentText = waiter.textBuf || "";
    if (waiter.abortRequested) {
      if (reason === "timeout" && !waiter.taskDispatched) {
        proc.waiters.delete(sessionId);
        waiter.resolve({ ok: false, code: "TIMEOUT", text: currentText, stopped: true, canceled: true, stopReason: "timeout", error: "生成超时，已中断", steps: waiter.steps || [] });
        maybeEscalateAbort(proc);
        retireDrainingProcess(proc);
      }
      return true;
    }
    waiter.abortRequested = true;
    if (!waiter.taskDispatched) {
      proc.waiters.delete(sessionId);
      if (waiter.timedOut) {
        waiter.resolve({ ok: false, code: "TIMEOUT", text: currentText, stopped: true, canceled: true, stopReason: "timeout", error: "生成超时，已中断", steps: waiter.steps || [] });
      } else {
        waiter.resolve({ ok: false, text: currentText, stopped: true, stopReason: "user", error: "已停止", steps: waiter.steps || [] });
      }
      if (proc.draining) maybeEscalateAbort(proc);
      retireDrainingProcess(proc);
      return true;
    }
    if (!waiter.abortGraceTimer) {
      writeJson(proc, { type: "abort", protocolVersion: RPC_PROTOCOL_VERSION, sessionId });
      waiter.abortGraceTimer = setTimeout(() => {
        waiter.abortGraceTimer = null;
        waiter.abortGraceExpired = true;
        proc.draining = true;
        maybeEscalateAbort(proc);
      }, abortGraceMs);
    }
    return true;
  }

  function safeToolError(error) {
    const rawCode = error && typeof error.code === "string" ? error.code : "TOOL_REQUEST_FAILED";
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "TOOL_REQUEST_FAILED";
    return { code, message: "Parent tool request failed" };
  }

  function answerToolRequest(proc, frame) {
    const requestId = typeof frame.requestId === "string" && frame.requestId.length <= 128 ? frame.requestId : "";
    const sessionId = typeof frame.sessionId === "string" && frame.sessionId.length <= 256 ? frame.sessionId : "";
    const name = typeof frame.name === "string" && frame.name.trim().length <= 128 ? frame.name.trim() : "";
    const waiter = sessionId ? proc.waiters.get(sessionId) : null;
    const respond = (ok, value) => {
      const response = ok
        ? { type: "tool_response", protocolVersion: RPC_PROTOCOL_VERSION, requestId, sessionId, ok: true, result: value === undefined ? null : value }
        : { type: "tool_response", protocolVersion: RPC_PROTOCOL_VERSION, requestId, sessionId, ok: false, error: value };
      try {
        const line = JSON.stringify(response);
        if (line.length > 1_048_576) throw new Error("response too large");
        proc.child.stdin.write(line + "\n");
      } catch (error) {
        writeJson(proc, { type: "tool_response", protocolVersion: RPC_PROTOCOL_VERSION, requestId, sessionId, ok: false, error: { code: "TOOL_RESPONSE_INVALID", message: "Parent tool response could not be serialized" } });
      }
    };

    if (!requestId || !sessionId || !name) {
      if (requestId && sessionId) respond(false, { code: "TOOL_REQUEST_INVALID", message: "Parent tool request is invalid" });
      return;
    }
    if (waiter?.abortRequested || waiter?.abortAcknowledged) {
      respond(false, { code: "SESSION_ABORTED", message: "Parent tool request was cancelled" });
      return;
    }
    if (proc.toolRequests.has(requestId)) return; // Duplicate frame: do not execute twice.
    if (!waiter || typeof waiter.onToolRequest !== "function") {
      respond(false, { code: "TOOL_REQUEST_UNAVAILABLE", message: "Parent tool request is unavailable" });
      return;
    }
    try {
      const encodedArgs = JSON.stringify(frame.args == null ? {} : frame.args);
      if (encodedArgs === undefined || encodedArgs.length > 1_048_576) throw new Error("invalid request args");
    } catch (error) {
      respond(false, { code: "TOOL_REQUEST_INVALID", message: "Parent tool request is invalid" });
      return;
    }

    const pending = { sessionId, controller: new AbortController() };
    proc.toolRequests.set(requestId, pending);
    Promise.resolve().then(() => waiter.onToolRequest({ sessionId, requestId, name, args: frame.args == null ? {} : frame.args, signal: pending.controller.signal }))
      .then((result) => {
        if (proc.toolRequests.get(requestId) !== pending || proc.waiters.get(sessionId) !== waiter) return;
        proc.toolRequests.delete(requestId);
        respond(true, result);
      }, (error) => {
        if (proc.toolRequests.get(requestId) !== pending || proc.waiters.get(sessionId) !== waiter) return;
        proc.toolRequests.delete(requestId);
        respond(false, safeToolError(error));
      });
  }

  function failRunnerProcess(proc, code, error) {
    if (proc.protocolFailed) return;
    proc.protocolFailed = true;
    proc.ready = false;
    if (proc.readyTimer) clearTimeout(proc.readyTimer);
    proc.readyTimer = null;
    proc.pendingTasks?.clear();
    for (const request of [...(proc.metadataRequests?.values() || [])]) request.finish({ ok: false, code: "MODEL_INFO_UNAVAILABLE" });
    clearToolRequests(proc);
    for (const [sid, waiter] of [...proc.waiters.entries()]) {
      proc.waiters.delete(sid);
      if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
      if (waiter.abortGraceTimer) clearTimeout(waiter.abortGraceTimer);
      waiter.resolve({ ok: false, code, error, text: waiter.textBuf || "", steps: waiter.steps || [] });
    }
    try { proc.child.kill(); } catch { /* process close cleanup follows */ }
  }

  function failProtocol(proc, code = "DSH_PROTOCOL_MISMATCH") {
    failRunnerProcess(proc, code, "DSH runner protocol negotiation failed");
  }

  function observeUncorrelatedRunnerError(proc, normalized) {
    proc.lastControlError = { ...normalized, observedAt: Date.now() };
    try { console.warn(`[dsh-adapter] uncorrelated runner control error ${normalized.code}: ${normalized.error}`); } catch { /* diagnostics must not interrupt protocol cleanup */ }
  }

  function dispatchFrame(proc, frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    if (frame.type === "error" && !proc.ready) {
      if (frame.protocolVersion !== RPC_PROTOCOL_VERSION) {
        failProtocol(proc, "DSH_PROTOCOL_MISMATCH");
      } else {
        const normalized = normalizeRunnerControlError(frame);
        failRunnerProcess(proc, normalized.code, normalized.error);
      }
      return;
    }
    if (frame.type === "ready") {
      const caps = frame.capabilities;
      const requiredCaps = ["task-v1", "tool-rpc-v1", "abort-v1"];
      if (frame.protocolVersion !== RPC_PROTOCOL_VERSION || frame.runner !== "persistent-runner"
          || !Array.isArray(caps) || requiredCaps.some((cap) => !caps.includes(cap))) {
        failProtocol(proc, "DSH_PROTOCOL_MISMATCH");
        return;
      }
      if (proc.ready) { failProtocol(proc, "DSH_PROTOCOL_DUPLICATE_READY"); return; }
      proc.ready = true;
      proc.capabilities = [...caps];
      for (const request of proc.metadataRequests.values()) request.dispatch();
      if (proc.readyTimer) clearTimeout(proc.readyTimer);
      proc.readyTimer = null;
      for (const [sid, task] of proc.pendingTasks || []) {
        proc.pendingTasks.delete(sid);
        const waiter = proc.waiters.get(sid);
        if (waiter) {
          waiter.taskDispatched = true;
          writeJson(proc, task);
        }
      }
      return;
    }
    // Never accept task or tool frames until this child has passed negotiation.
    if (!proc.ready || frame.protocolVersion !== RPC_PROTOCOL_VERSION) {
      failProtocol(proc, "DSH_PROTOCOL_MISMATCH");
      return;
    }
    if (frame.type === "model_info") {
      const request = proc.metadataRequests.get(frame.requestId);
      if (request) {
        const valid = frame.ok === true && frame.provider === request.provider && frame.model === request.model
          && Array.isArray(frame.efforts) && frame.efforts.length <= 16
          && frame.efforts.every((item) => item && typeof item.id === "string"
            && /^[A-Za-z0-9_-]{1,64}$/.test(item.id) && typeof item.name === "string" && item.name.length <= 128)
          && new Set(frame.efforts.map((item) => item.id)).size === frame.efforts.length
          && (frame.defaultEffort === undefined || frame.efforts.some((item) => item.id === frame.defaultEffort));
        request.finish(valid ? { ok: true, provider: request.provider, model: request.model,
          efforts: frame.efforts.map(({ id, name }) => ({ id, name })),
          ...(frame.defaultEffort === undefined ? {} : { defaultEffort: frame.defaultEffort }) }
          : { ok: false, code: "MODEL_INFO_UNAVAILABLE" });
      }
      return;
    }
    switch (frame.type) {
      case "pong": case "bye": case "closed": break;
      case "tool_request": answerToolRequest(proc, frame); break;
      case "delta": {
        const w = proc.waiters.get(frame.sessionId);
        if (w) {
          if (typeof frame.text === "string") {
            w.textBuf = (w.textBuf || "") + frame.text;
          }
          if (typeof w.onDelta === "function") { try { w.onDelta(frame.text); } catch (e) {} }
        }
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
        if (w) {
          proc.pendingTasks.delete(frame.sessionId);
          clearToolRequests(proc, frame.sessionId);
          proc.waiters.delete(frame.sessionId);
          if (w.abortGraceTimer) clearTimeout(w.abortGraceTimer);
          if (w.timeoutTimer) clearTimeout(w.timeoutTimer);
          const currentText = (frame.text !== undefined && frame.text !== "") ? frame.text : (w.textBuf || "");
          if (w.timedOut) w.resolve({ ...frame, text: currentText, ok: false, code: "TIMEOUT", stopped: true, canceled: true, stopReason: "timeout", error: "生成超时，已中断" });
          else if (w.abortRequested) w.resolve({ ...frame, text: currentText, ok: false, stopped: true, canceled: true, stopReason: "user", error: "已停止" });
          else w.resolve({ ...frame, text: currentText });
          maybeEscalateAbort(proc);
          retireDrainingProcess(proc);
        }
        break;
      }
      case "error": {
        const sid = frame.sessionId;
        const normalized = normalizeRunnerControlError(frame);
        if (sid) {
          const w = proc.waiters.get(sid);
          if (w) {
            if (w.timedOut) { w.timeoutErrorObserved = true; break; }
            proc.pendingTasks.delete(sid); clearToolRequests(proc, sid); proc.waiters.delete(sid);
            if (w.timeoutTimer) clearTimeout(w.timeoutTimer);
            if (w.abortGraceTimer) clearTimeout(w.abortGraceTimer);
            const currentText = (frame.text !== undefined && frame.text !== "") ? frame.text : (w.textBuf || "");
            w.resolve(w.abortRequested
              ? { ok: false, stopped: true, canceled: true, stopReason: "user", error: "已停止", text: currentText, steps: w.steps || [] }
              : { ok: false, code: normalized.code, error: normalized.error, text: currentText, steps: w.steps || [] });
            maybeEscalateAbort(proc);
            retireDrainingProcess(proc);
          } else observeUncorrelatedRunnerError(proc, normalized);
        } else observeUncorrelatedRunnerError(proc, normalized);
        break;
      }
      case "aborted": {
        const sid = frame.sessionId;
        if (sid) {
          const w = proc.waiters.get(sid);
          if (w) {
            clearToolRequests(proc, sid);
            // `aborted` acknowledges cancellation, but the SDK turn may still be
            // unwinding. Keep the waiter until runner `done`, emitted after whenIdle/flush.
            w.abortRequested = true;
            w.abortAcknowledged = true;
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
      clearToolRequests(existing);
      persistentProcesses.delete(key);
      for (const [sid, rec] of [...warmSessions.entries()]) if (rec && rec.tenantId === key) warmSessions.delete(sid);
    }

    // Recheck every cold spawn. A previous successful discovery must not bless
    // modified files or an override changed after runtime construction.
    const discovered = findDshEntry(opts.dshEntry);
    const entry = discovered.js;
    if (!entry) return { proc: null, fresh: false, spawnError: dshMissingHint(), spawnCode: discovered.code };

    let profile;
    try {
      profile = makeProfile(dshHome, settingsTemplate, persistentRunner);
      require("./bootstrap-policy.cjs").assertBootstrapPolicy({ home: dshHome, workspace: spec.workspace, profileDir: profile.dir });
    }
    catch (error) { return { proc: null, fresh: false, spawnError: error.message, spawnCode: error.code || "PROFILE_INVALID" }; }
    const env = buildDshChildEnv(process.env, {
      dshHome,
      nodePath: null,
      powerTokensApiKey: String(spec.apiKey || ""),
      powerTokensBaseUrl: process.env.POWERTOKENS_BASE_URL,
    });
    const identity = buildSpawnIdentity(opts);


    const tdir = tmpDir;
    fs.mkdirSync(tdir, { recursive: true });
    const safe = String(key).replace(/[^A-Za-z0-9_-]/g, "");
    const outFile = path.join(tdir, "persist-" + safe + "-" + Date.now().toString(36) + ".txt");
    const errFile = outFile + ".err";
    const fdOut = fs.openSync(outFile, "w");
    const fdErr = fs.openSync(errFile, "w");


    let child;
    try {
      child = spawn(process.execPath, [entry, "--profile", profile.name], {
        cwd: spec.workspace, env, stdio: ["pipe", fdOut, fdErr], windowsHide: true,
        ...identity,
      });
    } catch (e) {
      try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch (e2) {}
      return { proc: null, fresh: false, spawnError: String((e && e.message) || e) };
    }

    const proc = {
      child, outFile, errFile, fdOut, fdErr, installation: discovered.installation,
      userId: spec.userId,               // 该常驻进程属于哪个 userId（1 用户 = 1 租户）
      lastSize: 0, lastUsed: Date.now(),
      metadataRequests: new Map(), chatActive: false, waiters: new Map(), toolRequests: new Map(), pendingTasks: new Map(), lineBuf: "", ready: false, protocolFailed: false,
      pollTimer: null, idleTimer: null, draining: false, timeoutKillStarted: false, timeoutKillDeferred: false, retireScheduled: false,
    };
    const readyTimeoutMs = Number.isSafeInteger(opts.readyTimeoutMs) && opts.readyTimeoutMs >= 250 ? opts.readyTimeoutMs : 10_000;
    proc.readyTimer = setTimeout(() => failProtocol(proc, "DSH_PROTOCOL_HANDSHAKE_TIMEOUT"), readyTimeoutMs);
    proc.readyTimer.unref?.();
    proc.pollTimer = setInterval(() => pollProc(proc), 50);
    persistentProcesses.set(key, proc);

    child.on("close", () => {
      if (persistentProcesses.get(key) === proc && proc.draining) persistentProcesses.delete(key);
      try { clearInterval(proc.pollTimer); } catch (e) {}
      try { clearInterval(proc.idleTimer); } catch (e) {}
      proc.idleTimer = null;
      if (proc.readyTimer) clearTimeout(proc.readyTimer);
      proc.readyTimer = null;
      clearToolRequests(proc);
      for (const request of [...proc.metadataRequests.values()]) request.finish({ ok: false, code: "MODEL_INFO_UNAVAILABLE" });
      for (const [sid, w] of [...proc.waiters.entries()]) {
        proc.waiters.delete(sid);
        if (w.abortGraceTimer) clearTimeout(w.abortGraceTimer);
        if (w.timeoutTimer) clearTimeout(w.timeoutTimer);
        const byTimeout = w.timedOut === true;
        const byUser = w.abortRequested === true;
        w.resolve({
          ok: false, text: w.textBuf || "",
          code: byTimeout ? "TIMEOUT" : "DSH_PROCESS_EXIT",
          error: byTimeout ? "生成超时，已中断" : (byUser ? "已停止" : "常驻 DSH进程退出"),
          stopped: byTimeout || byUser,
          stopReason: byTimeout ? "timeout" : (byUser ? "user" : undefined),
          steps: w.steps || [],
        });
      }
    });

    // Cold read-only metadata also needs reclamation, without becoming a heartbeat target.
    proc.idleTimer = setInterval(() => {
      if (Date.now() - proc.lastUsed > idleMs && proc.waiters.size === 0 && proc.metadataRequests.size === 0) {
        clearInterval(proc.idleTimer); proc.idleTimer = null;
        proc.draining = true;
        writeJson(proc, { type: "exit", protocolVersion: RPC_PROTOCOL_VERSION });
        const timer = setTimeout(() => { try { proc.child.kill(); } catch {} }, 3000);
        timer.unref?.();
      }
    }, Math.min(60_000, Math.max(25, idleMs)));
    proc.idleTimer.unref?.();
    return { proc, fresh: true };
  }

  function describeModel(spec) {
    const unavailable = (code) => Promise.resolve({ ok: false, code });
    if (!spec || typeof spec.tenantId !== "string" || !spec.tenantId.trim()
        || typeof spec.provider !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(spec.provider)
        || typeof spec.model !== "string" || !/^[A-Za-z0-9_./:@+-]{1,256}$/.test(spec.model)) return unavailable("MODEL_INFO_INVALID");
    if (spec.signal?.aborted) return unavailable("MODEL_INFO_CANCELED");
    if ([...persistentProcesses.values()].reduce((sum, proc) => sum + proc.metadataRequests.size, 0) >= 8) return unavailable("MODEL_INFO_BUSY");
    const { proc } = getOrSpawnProcess(spec);
    if (!proc || proc.draining || proc.protocolFailed) return unavailable("MODEL_INFO_UNAVAILABLE");
    if (proc.metadataRequests.size) return unavailable("MODEL_INFO_BUSY");
    return new Promise((resolve) => {
      const requestId = "mi-" + crypto.randomBytes(16).toString("hex");
      let timer;
      const onAbort = () => request.finish({ ok: false, code: "MODEL_INFO_CANCELED" });
      const request = {
        provider: spec.provider, model: spec.model,
        finish(result) {
          if (!proc.metadataRequests.delete(requestId)) return;
          clearTimeout(timer); spec.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        dispatch() {
          if (!proc.capabilities?.includes("model-info-v1")) {
            request.finish({ ok: false, code: "MODEL_INFO_UNSUPPORTED" }); return;
          }
          writeJson(proc, { type: "describe_model", protocolVersion: RPC_PROTOCOL_VERSION,
            requestId, provider: spec.provider, model: spec.model });
        },
      };
      proc.metadataRequests.set(requestId, request);
      const timeout = Number.isSafeInteger(opts.metadataTimeoutMs) && opts.metadataTimeoutMs >= 25
        ? Math.min(opts.metadataTimeoutMs, 10_000) : 5000;
      timer = setTimeout(() => request.finish({ ok: false, code: "MODEL_INFO_TIMEOUT" }), timeout);
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      if (spec.signal?.aborted) onAbort();
      else if (proc.ready) request.dispatch();
    });
  }

  function run(spec) {
    const sessionKey = String(spec.sessionKey || "").trim();
    const tenantId = String(spec.tenantId || "").trim();
    const workspace = spec.workspace;

    return new Promise((resolve) => {
      const { proc, fresh, spawnError, spawnCode } = getOrSpawnProcess(spec);
      if (spawnError || !proc) {
        return resolve({
          ok: false, code: spawnCode || "SPAWN", text: "", ms: 0, error: spawnError || "常驻进程启动失败",
          workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")), fresh: false,
        });
      }
      if (proc.draining) {
        return resolve({ ok: false, code: "DSH_PROCESS_DRAINING", text: "", ms: 0,
          error: "常驻 DSH 进程正在收敛，暂不可接收新任务", stopped: false,
          workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")), fresh: false });
      }
      if (spec.recordModelIntents === true && proc.ready && !proc.capabilities?.includes("model-intent-v1")) {
        return resolve({ ok: false, code: "DSH_MODEL_INTENT_UNSUPPORTED", text: "", ms: 0,
          error: "DSH runner does not support durable model intents", stopped: false, fresh: false });
      }

      proc.chatActive = true;

      // 冷/热判断：新鲜进程 = 无存活 session，视为冷启动（补历史 + 用全新 sessionId）
      const warmRec = sessionKey ? warmSessions.get(sessionKey) : null;
      const warm = !fresh && warmRec && warmRec.tenantId === tenantId;
      const resume=!warm&&spec.nativeSession?.keySha256===sha256(String(spec.apiKey||''))&&typeof spec.nativeSession?.sessionId==='string'&&spec.nativeSession.sessionId.startsWith(sessionKey+'-')&&/^[A-Za-z0-9_-]{1,160}$/.test(spec.nativeSession.sessionId);
      const sessionId = warm ? warmRec.sessionId : resume?spec.nativeSession.sessionId: ((sessionKey || "adhoc") + "-" + crypto.randomBytes(6).toString("hex"));

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
        history: !warm&&!resume ? spec.history : undefined,
        question: spec.question,
      });

      const t0 = Date.now();
      let waiter; // 声明提前，供 job.abort() 引用 steps（避免 TDZ）
      let timeoutTimer = null;
      const job = {
        stopped: false,
        abort() {
          if (this.stopped) return;
          this.stopped = true;
          if (!requestWaiterAbort(proc, sessionId) && !proc.pendingTasks.has(sessionId)) {
            // onSpawn can observe an already-aborted signal before waiter creation.
            return;
          }
        },
        kill() {
          this.abort();
        },
      };
      if (typeof spec.onSpawn === "function") { try { spec.onSpawn(job); } catch (e) {} }
      if (job.stopped) {
        resolve({ ok: false, text: "", ms: Date.now() - t0, error: "已停止", stopped: true, stopReason: "user", steps: [], fresh: !warm,
          artifacts: collectRoundArtifacts(workspace, t0), workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")) });
        return;
      }

      waiter = {
        textBuf: "",
        onToolRequest: typeof spec.onToolRequest === "function"
          ? (request) => spec.onToolRequest(request)
          : null,
        onArtifact: spec.onArtifact,
        wsDir: workspace,
        onDelta: spec.onDelta,
        onStep: spec.onStep,
        timedOut: false,
        extendDeadline,
        steps: [],
        resolve: (frame) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (waiter.abortGraceTimer) clearTimeout(waiter.abortGraceTimer);
          const stopped = frame.stopped === true || frame.canceled === true || waiter.timedOut === true;
          const stopReason = stopped ? (frame.stopReason || (waiter.timedOut ? "timeout" : "user")) : undefined;
          const text = (frame.text !== undefined && frame.text !== "") ? frame.text : (waiter.textBuf || "");
          resolve({
            ok: frame.ok !== false,
            code: frame.code || null,
            text,
            media: Array.isArray(frame.media) ? frame.media : null,
            artifacts: collectRoundArtifacts(workspace, t0),
            report: frame.report || null,
            installation: proc.installation,
            usage: frame.usage || null,
            budget: frame.budget && typeof frame.budget === "object" ? frame.budget : null,
            usageEvidence: frame.usageEvidence && typeof frame.usageEvidence === "object" ? frame.usageEvidence : null,
            modelIdentity: normalizeModelIdentity(frame.modelIdentity),
            imageInput: frame.imageInput?.kind==='dsh-native-images-v1'&&Number.isSafeInteger(frame.imageInput.newImageCount)&&frame.imageInput.newImageCount>=0&&frame.imageInput.newImageCount<=4
              ? {kind:'dsh-native-images-v1',newImageCount:frame.imageInput.newImageCount,capabilityChecked:frame.imageInput.capabilityChecked===true}:null,
            ms: frame.ms || (Date.now() - t0),
            error: frame.error || (frame.reasonDetail ? (frame.reasonDetail.code + ": " + frame.reasonDetail.message) : null),
            stopped,
            stopReason,
            steps: waiter.steps || [],
            fresh: !warm,
            nativeSessionId:frame.context?.kind==='dsh-native-context-v1'?sessionId:null,
            context:frame.context?.kind==='dsh-native-context-v1'&&Number.isSafeInteger(frame.context.compactions)&&frame.context.compactions>=0&&frame.context.compactions<=3?{kind:'dsh-native-context-v1',compactions:frame.context.compactions,manual:frame.context.manual===true,resumed:frame.context.resumed===true}:null,
            workspace, tenantId, userId: spec.userId, keySha256: sha256(String(spec.apiKey || "")),
          });
        },
      };
      proc.waiters.set(sessionId, waiter);
      const taskFrame = { type: "task", protocolVersion: RPC_PROTOCOL_VERSION, sessionId, ...(spec.pinnedSkills?{pinnedSkills:spec.pinnedSkills}:{}), ...(spec.runId?{runId:spec.runId}:{}), ...(resume?{resume:true}:{}), ...(spec.compact?{compact:true}:{}), task: fullTask, model: spec.model, ...(spec.reasoningEffort === undefined ? {} : {reasoningEffort:spec.reasoningEffort}), tenantId,
        ...((spec.inputImages !== undefined || (!warm && !resume && spec.historyInputImages?.length))
          ? {inputImages:[...(!warm&&!resume?(spec.historyInputImages||[]):[]),...(spec.inputImages||[])]} : {}),
        ...(spec.recordModelIntents === true ? { recordModelIntents: true } : {}),
        ...(["csv","skill","skill-csv","questions","web","billing"].includes(spec.budgetProfile) || /^(?:skill-)?media:(text2image|image2image|text2video|image2video)$/.test(spec.budgetProfile || "") ? { budgetProfile: spec.budgetProfile } : {}) };
      if (proc.ready) { waiter.taskDispatched = true; writeJson(proc, taskFrame); }
      else proc.pendingTasks.set(sessionId, taskFrame);

      // 成功发送后标记 warm（会话在 DSH 侧存活；记录实际 sessionId）
      if (sessionKey) warmSessions.set(sessionKey, { tenantId, sessionId });

      // 超时先按 sessionId 优雅取消并保留 waiter；grace 到期后仅在没有
      // 仍需保护的 sibling waiter 时才允许终止共享 child。
      // deadline 可被 extendDeadline() 动态放宽 —— 视频生成等长任务靠它把 3 分钟提到 65 分钟。
      const budget0 = spec.timeoutMs || taskTimeoutMs;
      let deadline = Date.now() + budget0;
      timeoutTimer = setTimeout(fireTimeout, budget0);
      waiter.timeoutTimer = timeoutTimer;
      function fireTimeout() {
        if (!proc.waiters.has(sessionId)) return;
        const w0 = proc.waiters.get(sessionId);
        if (w0) requestWaiterAbort(proc, sessionId, "timeout");
      }
      /** 放宽这一轮的超时预算到 now + ms（只放宽、不收紧），供视频生成等长任务动态提额。 */
      function extendDeadline(ms) {
        const now = Date.now();
        const next = now + ms;
        if (next <= deadline) return false;
        deadline = next;
        try { clearTimeout(timeoutTimer); } catch (e) {}
        timeoutTimer = setTimeout(fireTimeout, Math.max(0, deadline - now));
        waiter.timeoutTimer = timeoutTimer;
        return true;
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
      if (!proc || !proc.chatActive || proc.draining || !proc.child || proc.child.exitCode !== null || proc.child.killed) {
        return resolve({ ok: false, skipped: true, error: "非活跃租户，跳过心跳（常驻进程已被回收）" });
      }
      const sessionId = "hb-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
      const task = String(spec.prompt || "ping").trim();
      const t0 = Date.now();
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        writeJson(proc, { type: "close", protocolVersion: RPC_PROTOCOL_VERSION, sessionId }); // 用完即弃，防内存堆积 / 上下文增长
        resolve(r);
      };
      const waiter = {
        onDelta: () => {},
        onStep: () => {},
        steps: [],
        resolve: (frame) => finish({ ok: frame.ok !== false, ms: frame.ms || (Date.now() - t0), error: frame.error || null, usage: frame.usage || null }),
      };
      proc.waiters.set(sessionId, waiter);
      const taskFrame = { type: "task", protocolVersion: RPC_PROTOCOL_VERSION, sessionId, task, model: spec.model, tenantId,
        ...(["csv","skill","skill-csv","questions","web","billing"].includes(spec.budgetProfile) || /^(?:skill-)?media:(text2image|image2image|text2video|image2video)$/.test(spec.budgetProfile || "") ? { budgetProfile: spec.budgetProfile } : {}) };
      if (proc.ready) writeJson(proc, taskFrame);
      else proc.pendingTasks.set(sessionId, taskFrame);
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
      if (proc && proc.chatActive && !proc.draining && proc.child && proc.child.exitCode === null && !proc.child.killed) {
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
        requestWaiterAbort(proc, dshSid);
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
        clearToolRequests(proc, dshSid);
        proc.pendingTasks.delete(dshSid);
        writeJson(proc, { type: "close", protocolVersion: RPC_PROTOCOL_VERSION, sessionId: dshSid });
      }
    }
  }

  function close() {
    warmSessions.clear();
    for (const [key, proc] of [...persistentProcesses.entries()]) {
      try { clearInterval(proc.pollTimer); } catch (e) {}
      try { clearInterval(proc.idleTimer); } catch (e) {}
      persistentProcesses.delete(key);
      clearToolRequests(proc);
      for (const request of [...proc.metadataRequests.values()]) request.finish({ ok: false, code: "MODEL_INFO_UNAVAILABLE" });
      writeJson(proc, { type: "exit", protocolVersion: RPC_PROTOCOL_VERSION });
      setTimeout(() => { try { proc.child.kill(); } catch (e) {} }, 3000);
    }
  }

  return { run, describeModel, pulse, activeTenants, abort, closeSession, close };
}

module.exports = {
  profileFiles,
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
  rebuildProfile,
  recoverProfile,
  buildDshChildEnv,
  buildSpawnIdentity,
};
