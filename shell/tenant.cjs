"use strict";
/**
 * tenant.cjs —— 多租户业务层（Slice 2 · DSH Adapter 重构后）
 * ============================================================================
 * 变化（Slice 2）：把「spawn DSH + JSON-lines 协议 + 进程生命周期」抽到了
 *   runtime/dsh-adapter.cjs（真实 DSH）+ runtime/mock-adapter.cjs（测试 mock），
 *   二者实现同一 Runtime Contract（runtime/contract.cjs）。本文件只保留业务：
 *   key 解密来源、workspace 初始化、人设/记忆/历史读取、模型列表、任务部件组装，
 *   并负责选择 runtime（PT_MOCK_DSH=1 时用 mock）后委托执行。
 *
 * 保留（与 v7 一致）：
 *   · workspace 隔离（1 用户 = 1 租户）；PT key 只在 spawn 时注入 env，不落盘；
 *   · key 来源三级回退（decryptApiKey / db / PT_U3_STUB_KEYS）；
 *   · 人设 persona 注入（agent-persona.md）；模型读取/选择。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
const SETTINGS_TEMPLATE = path.join(SHELL, "dsh-settings.yaml");

const NO_API_KEY_CODE = "NO_API_KEY";
const NO_KEY_SOURCE_CODE = "NO_KEY_SOURCE";

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/* ---- Runtime 依赖（Slice 2 接缝）---- */
const { assertRuntime } = require("./runtime/contract.cjs");
const { createDshRuntime, findDshEntry, dshMissingHint, makeProfile } = require("./runtime/dsh-adapter.cjs");
const { createMockRuntime } = require("./runtime/mock-adapter.cjs");

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
  // 常驻模式下模型走每请求 opts.model，不再写 settings.yaml；保留此函数仅为兼容旧调用。
  return;
}

/* ============================================================================
 * Runtime 选择（Slice 2）：PT_MOCK_DSH=1 用内存 mock，否则用真实 DSH。
 * ========================================================================== */
let _runtime = null;

function createRuntime() {
  if (_runtime) return _runtime;
  if (process.env.PT_MOCK_DSH === "1" || process.env.PT_MOCK_DSH === "true") {
    _runtime = createMockRuntime({ mode: process.env.PT_MOCK_DSH_MODE || "ok" });
  } else {
    _runtime = createDshRuntime({
      dshHome: DSH_HOME,
      settingsTemplate: SETTINGS_TEMPLATE,
      persistentRunner: PERSISTENT_RUNNER,
      tmpDir: TMP,
    });
  }
  assertRuntime(_runtime, "tenant runtime");
  return _runtime;
}

/** 关闭并释放 runtime（测试/重启用）。 */
function closeRuntime() {
  if (_runtime) {
    try { _runtime.close(); } catch (e) { /* 忽略 */ }
    _runtime = null;
  }
}

/* ============================================================================
 * runDshForUser(userId, question, opts) —— 业务组装 + 委托 runtime
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

  // dryRun：不真正 spawn，只回传鉴权/workspace 信息（诊断用）
  if (opts.dryRun) {
    return { ok: true, dryRun: true, tenantId, cwd: workspace, userId: uid, keySha256: sha256(apiKey) };
  }

  const runtime = createRuntime();
  return runtime.run({
    sessionKey: opts.conversationId,
    tenantId,
    model: opts.model,
    apiKey,
    workspace,
    userId: uid,
    persona: readPersona(),
    memory: opts.memory,
    imageNote: opts.imageNote,
    history: opts.history,
    question,
    onDelta: opts.onDelta,
    onStep: opts.onStep,
    onSpawn: opts.onSpawn,
    timeoutMs: opts.timeoutMs,
  });
}

/** 关掉某个对话对应的 DSH session（删对话/分岔/重新生成时调用）。 */
function closeDshSession(conversationId) {
  const rt = _runtime;
  if (rt) rt.closeSession(conversationId);
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
  createRuntime,
  closeRuntime,
};
