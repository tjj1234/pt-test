"use strict";
/**
 * tenant.cjs —— 多租户租户隔离（U3.1）
 * ============================================================================
 * 职责：
 *   · workspace 隔离：1 用户 = 1 租户，每人一个独立工作区目录（防穿越）；
 *   · env 注入：明文 PT key 只在 spawn 时注入一次 env，绝不落盘；
 *   · DSH 入口发现（跨平台）：优先 DSH_JS 环境变量，其次自动发现，找不到给中文报错。
 *
 * key 来源三级回退（只在 runDshForUser 内部解析一次）：
 *   ① opts.decryptApiKey —— 接线方 initKeys({db}) 后传入的「绑定函数」（推荐）；
 *   ② opts.db            —— runDshForUser 内部自 initKeys({db}) 拿绑定 decryptApiKey；
 *   ③ PT_U3_STUB_KEYS    —— 仅自测占位 stub，显式设了才走；否则视为「无 key 来源」。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SHELL = __dirname;
const REPO_ROOT = path.resolve(SHELL, "..");
const RUNTIME = path.join(REPO_ROOT, "runtime");

const WORKSPACES_ROOT = path.join(RUNTIME, "workspaces");
const DSH_HOME = path.join(RUNTIME, "dsh-home");
const SHARED_WORKSPACE = path.join(RUNTIME, "workspace");
const SKILLS_SOURCE = path.join(SHARED_WORKSPACE, ".dsh", "skills");
const TMP = path.join(RUNTIME, "_tmp");

const NO_API_KEY_CODE = "NO_API_KEY";       // 用户没存 key（decrypt 返回 null/空）
const NO_KEY_SOURCE_CODE = "NO_KEY_SOURCE"; // 服务端没接到 key 来源（接线缺失/无 stub）

/* ============================================================================
 * DSH 入口发现（跨平台）
 * ----------------------------------------------------------------------------
 * 优先级：① --dsh 显式参数 > ② 环境变量 DSH_JS > ③ 自动发现（execPath/cwd 上溯的
 * node_modules、全局 npm root 里的 @deepseek-ai/dsh/lib/bin.js）。
 * 找不到返回 { js:null }，由 spawn 侧给出清晰中文报错。
 * ========================================================================== */
function findDshEntry(explicit) {
  if (explicit && fs.existsSync(explicit)) return { js: explicit, nodePath: null };

  // ② 环境变量 DSH_JS（相对路径按 cwd 解析）
  if (process.env.DSH_JS) {
    const envJs = path.resolve(process.cwd(), process.env.DSH_JS);
    if (fs.existsSync(envJs)) return { js: envJs, nodePath: null };
    process.stderr.write("[DSH] DSH_JS 指向的文件不存在：" + envJs + "（继续尝试自动发现…）\n");
  }

  // ③ 自动发现：收集候选 node_modules 根
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
  pushUp(path.dirname(process.execPath), 6); // 从 node 可执行文件上溯（Windows 免 spawn .cmd）
  pushUp(process.cwd(), 6);                  // 从当前工作目录上溯
  try {                                      // 全局 npm root（-g）
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0 && r.stdout) roots.push(String(r.stdout).trim());
  } catch (e) { /* 拿不到全局 root 就跳过 */ }

  for (const r of roots) {
    if (!r) continue;
    const js = path.join(r, "@deepseek-ai", "dsh", "lib", "bin.js");
    if (fs.existsSync(js)) {
      let nodePath = null;
      try {
        const cmd = fs.readFileSync(path.join(r, ".bin", "dsh.cmd"), "utf8");
        const m = cmd.match(/SET "NODE_PATH=([^"]+)"/i);
        if (m) nodePath = m[1];
      } catch (e) { /* 没读到 NODE_PATH 也能跑 */ }
      return { js, nodePath };
    }
  }
  return { js: null, nodePath: null };
}
const DSH = findDshEntry();

/** 找不到 DSH 时给出清晰中文报错（供启动横幅 / 出错信息复用）。 */
function dshMissingHint() {
  return (
    "找不到 DSH 的 JS 入口（@deepseek-ai/dsh/lib/bin.js）。请二选一：\n" +
    "  ① 设环境变量 DSH_JS 指向该 bin.js 的绝对路径；\n" +
    "  ② 安装 dsh：npm install -g @deepseek-ai/dsh（或装到本仓库 node_modules），装好后重试。"
  );
}

/* ============================================================================
 * profile（每跑一个轻量 profile；node_modules 是 junction 共享，不按租户复制）
 * ========================================================================== */
let profileSeq = 0;
function makeProfile(dshHome) {
  const home = dshHome || DSH_HOME;
  const name = "run-" + Date.now().toString(36) + "-" + (profileSeq++).toString(36);
  const dir = path.join(home, "profiles", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "dsh-profile-" + name, private: true, dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  }), "utf8");
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
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
 * 组装一次 spawn 参数（明文 key 只在 env 出现一次）
 * ========================================================================== */
function buildSpec(tenantId, workspace, userId, task, opts, apiKey) {
  const dshHome = opts.dshHome || DSH_HOME;
  const entry = opts.dshEntry || DSH.js;
  const nodePath = (opts.nodePath !== undefined) ? opts.nodePath : DSH.nodePath;
  const profile = makeProfile(dshHome);

  const env = Object.assign({}, process.env, { DSH_HOME: dshHome });
  if (nodePath) env.NODE_PATH = nodePath;
  env.POWERTOKENS_API_KEY = String(apiKey);

  const argv = [entry, "--profile", profile.name, String(task)];
  return { argv, env, cwd: workspace, profile, dshHome, entry, userId, tenantId };
}

function spawnDsh(spec, opts = {}) {
  if (!spec.entry) {
    return { ok: false, code: "NO_DSH", text: "", ms: 0, exitCode: null,
             error: dshMissingHint(),
             workspace: spec.cwd, tenantId: spec.tenantId };
  }
  const tmpDir = opts.tmpDir || TMP;
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, "out-" + spec.profile.name + ".txt");
  const fd = fs.openSync(outFile, "w");
  const t0 = Date.now();
  const res = spawnSync(process.execPath, spec.argv, {
    cwd: spec.cwd, env: spec.env, stdio: ["ignore", fd, fd],
    timeout: opts.timeoutMs || 300000, windowsHide: true,
  });
  fs.closeSync(fd);
  let text = "";
  try { text = fs.readFileSync(outFile, "utf8"); } catch (e) {}
  text = text.replace(/^\uFEFF/, "").trim();
  const error = res.error ? (res.error.code || res.error.message || String(res.error)) : null;
  return { ok: res.status === 0, text, ms: Date.now() - t0,
           code: res.status, exitCode: res.status, error,
           workspace: spec.cwd, tenantId: spec.tenantId };
}

/* ============================================================================
 * runDshForUser(userId, task, opts?)
 * ========================================================================== */
async function runDshForUser(userId, task, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, code: "NO_USER", error: "缺少 userId" };
  if (!String(task || "").trim()) return { ok: false, code: "NO_TASK", error: "任务不能为空" };

  const tenantId = String(opts.tenantId || userId || "").trim();
  const { workspace } = initTenantWorkspace(tenantId, opts);

  let decrypt = null;
  try {
    decrypt = await resolveDecryptApiKey(opts);
  } catch (e) {
    return { ok: false, code: "DECRYPT_FAILED", error: "初始化 key 解密失败：" + (e && e.message ? e.message : e),
             workspace, tenantId };
  }
  if (!decrypt) {
    return { ok: false, code: NO_KEY_SOURCE_CODE,
             error: "服务端没接到 PT key 解密来源（未传 decryptApiKey / db，也未设 PT_U3_STUB_KEYS）",
             workspace, tenantId };
  }

  let apiKey = null;
  try {
    apiKey = await decrypt(userId);
  } catch (e) {
    return { ok: false, code: "DECRYPT_FAILED", error: "读不到你的 PT key：" + (e && e.message ? e.message : e),
             workspace, tenantId };
  }
  if (!apiKey || !String(apiKey).trim()) {
    return { ok: false, code: NO_API_KEY_CODE,
             error: "还没保存你的 PT key（BYOK）。请先到「设置」页保存 key，再开始对话。",
             workspace, tenantId };
  }

  const spec = buildSpec(tenantId, workspace, userId, task, opts, apiKey);
  if (opts.dryRun) return { ok: true, dryRun: true, ...spec };
  return spawnDsh(spec, opts);
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
  resolveDecryptApiKey,
  findDshEntry,
  dshMissingHint,
  makeProfile,
  stubDecryptApiKey,
};
