#!/usr/bin/env node
/**
 * 北极星 · 业务壳后端（形态 B · 多租户 · 打包发布版 · 对话窗口化）
 * ============================================================================
 * 本文件 = server.fixed.cjs（看板代理 / 技能 / 状态 / 多租户 BYOK / 日志 / 探活 / 部署）
 *        + 对话窗口化改造：
 *          A · 多对话：GET/POST /api/conversations、GET/PATCH/DELETE /api/conversations/:id
 *          B · 消息能力：每条消息带 ts；POST /api/chat 带 conversationId + 可选 regenerate
 *          C · 停止与并发：POST /api/chat/stop kill 子进程；同一用户同一时刻只允许一个
 *              生成中的对话（runningJobs）；runDshForUser 已改异步 spawn（不阻塞事件循环）
 *          D · 持久化：所有对话 + 每条消息（含 ts）落库，重启不丢
 *
 * 三条不可动摇的规矩（形态 B · 多租户）：
 *   ① DSH_HOME 必须是产品自己的家，绝不用开发者的 ~/.dsh
 *   ② 工作区必须是「该租户自己的地盘」，技能只在租户工作区里
 *   ③ DSH 本身不开任何对外端口，只有这个业务壳对外
 *   ④ 每个用户 = 一个租户，每人一把 PT key（BYOK），对话按 user→tenant→key→workspace 注入
 * ============================================================================
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawnSync } = require("child_process");

// ---- 结构化日志（零第三方依赖，按天切割落 logs）----
const log = require("./logging.cjs");

// ---- 模型目录：每日从 PT /v1/models 自动同步 + AUTO 智能路由（B3）----
const modelCatalog = require("./model-catalog.cjs");

// ---- 产出文件（PDF/HTML/md）预览：路径校验 + 扫描 + Content-Type ----
const artifactsMod = require("./runtime/artifacts.cjs");

// ---- 模块接线（全部最终名；conversations / tenant 为对话窗口化后的新版）----
const { initAuth } = require("./auth.cjs");
const { handleAuthRoutes, sessionFromCookie } = require("./auth-routes.cjs");
const keysMod = require("./keys.cjs");
const { handleKeyRoutes } = require("./key-routes.cjs");
const { handleMemberRoutes } = require("./member-routes.cjs");
const { handleAuthAccountsRoutes } = require("./auth-accounts-routes.cjs");
const tenantMod = require("./tenant.cjs");
const convMod = require("./conversations.cjs");
const memoryMod = require("./memory.cjs");
const panelSharesMod = require("./panel-share.cjs");
const toolCallsMod = require("./tool-calls.cjs");
const toolsRegistry = require("./tools/registry.cjs");

/* ---- 模型目录：进程内缓存 + 每日同步（B3）----
 * 同步失败不影响对话：拉不到就用上次缓存，缓存也没有就退回 yaml 静态列表。 */
let _catalogCache = null;
let _catalogBusy = null;
function catalogFallback(err) {
  return {
    models: tenantMod.readModels().map((m) => ({ id: m.id, name: m.name || m.id, chat: true, kind: "chat" })),
    syncedAt: 0, auto: modelCatalog.AUTO_ID,
    ...(err ? { syncError: String(err && err.message ? err.message : err) } : {}),
  };
}
function getModelCatalog(force) {
  if (!force && _catalogCache) return Promise.resolve(_catalogCache);
  if (_catalogBusy) return _catalogBusy;
  _catalogBusy = modelCatalog.getCatalog({
    apiKey: process.env.PT_MODELS_API_KEY || process.env.POWERTOKENS_API_KEY || "",
    fallback: tenantMod.readModels(),
    force: force === true,
  }).then((c) => { _catalogCache = c; _catalogBusy = null; return c; })
    .catch((e) => { _catalogBusy = null; return catalogFallback(e); });
  return _catalogBusy;
}
async function ensureModelCatalog() {
  if (!_catalogCache && !_catalogBusy) { try { await getModelCatalog(false); } catch (e) { /* 兜底已在内部 */ } }
  return _catalogCache || catalogFallback();
}

const { loadBusinessTools, loadBusinessConstraints } = require("./tools/autoload.cjs");
const { queryBusinessWorkspace, normalizeEnabledStatus, queryGaConnectorStatus } = require("./workspace-enabled-status.cjs");
const { createRateLimiter, clientIp } = require("./ratelimit.cjs");
const { isMultipart, parseMultipart } = require("./multipart.cjs");

// ---- 路径：全部相对 repo 根，可用环境变量覆盖 ----
const SHELL = __dirname;
const REPO_ROOT = path.resolve(SHELL, "..");
const RUNTIME = path.join(REPO_ROOT, "runtime");
const DSH_HOME = path.join(RUNTIME, "dsh-home");
const WORKSPACE = path.join(RUNTIME, "workspace");         // 共享工作区（技能播种源）
const SKILLS = path.join(WORKSPACE, ".dsh", "skills");
const PUBLIC = path.join(SHELL, "public");
const TMP = path.join(RUNTIME, "_tmp");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = Number(arg("--port", process.env.PT_SHELL_PORT || 8098));
const DASH_PORT = Number(arg("--dashboard-port", process.env.PT_DASH_PORT || 8095));
// 注入到进程 env，使 DSH 子进程（persistent-runner 的 ga.query/attribution.query executor）
// 能经 process.env.DASH_PORT 回连看板内部只读接口；PT_DASH_INTERNAL_KEY 已随 process.env 继承。
process.env.DASH_PORT = String(DASH_PORT);
const DASH_TOKEN = arg("--dashboard-token", process.env.PT_DASH_TOKEN || null); // P0-2：不再内置默认 token
// P0-1 安全：取消固定默认密码。显式提供 PT_SHELL_PASSWORD / --password 才用；
// 否则生成随机密码；非回环监听 + 无显式密码 → 直接拒绝启动（见下方检查）。
const PASSWORD_EXPLICIT = process.env.PT_SHELL_PASSWORD
  || (process.argv.indexOf("--password") >= 0 ? process.argv[process.argv.indexOf("--password") + 1] : null)
  || null;
const PASSWORD = PASSWORD_EXPLICIT || crypto.randomBytes(12).toString("base64url");
const USERNAME = arg("--user", process.env.PT_SHELL_USER || "admin");
const DSH_TIMEOUT_MS = Number(arg("--timeout", 300000));

// ---- 监听地址（默认 127.0.0.1，容器/反代部署用 0.0.0.0）----
const LISTEN_HOST = process.env.PT_LISTEN_HOST || "127.0.0.1";

// P0-4 安全：生产 HTTPS 部署设 PT_COOKIE_SECURE=1 → Cookie 加 Secure + 响应加 HSTS
const COOKIE_SECURE = process.env.PT_COOKIE_SECURE === "1";

// P0-1 安全：非回环监听（0.0.0.0 / 公网）时，必须显式设置管理员密码，否则拒绝启动。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (!PASSWORD_EXPLICIT && !LOOPBACK_HOSTS.has(String(LISTEN_HOST).toLowerCase())) {
  console.error("【拒绝启动】监听地址 = " + LISTEN_HOST + "（非回环），但未设置 PT_SHELL_PASSWORD。");
  console.error("  生产环境必须显式设置 PT_SHELL_PASSWORD，禁止用随机/默认密码暴露到非本机网络。");
  process.exit(1);
}
if (!PASSWORD_EXPLICIT) {
  console.log("★ 未设置 PT_SHELL_PASSWORD，已生成随机管理员密码（仅本次启动打印一次，请记下）: " + PASSWORD);
}

// 身份库 / master key 落点（可用环境变量覆盖，便于自测用临时目录）
const DB_DIR = process.env.PT_DB_DIR || path.join(REPO_ROOT, "db");
const MASTER_KEY_FILE = process.env.PT_MASTER_KEY_FILE || path.join(REPO_ROOT, "secrets", "master.key");

// ---- 登记「绝不允许写进日志」的明文串（密码 / 看板只读 token）----
log.addSecret(PASSWORD);
if (DASH_TOKEN) log.addSecret(DASH_TOKEN);

// 自测开关：PT_CHAT_DRYRUN=1 时 /api/chat 不 spawn DSH
const DRY_RUN_CHAT = process.env.PT_CHAT_DRYRUN === "1";

// ---- /api/chat 限流（按 IP，默认 20/分；可用 PT_RATE_CHAT_PER_MIN 覆盖）----
const RATE_CHAT_PER_MIN = Number(process.env.PT_RATE_CHAT_PER_MIN || 20);
const chatLimiter = createRateLimiter({ windowMs: 60000, max: RATE_CHAT_PER_MIN });

// ---- 保活心跳（防空闲回收导致首字延迟）：默认关闭，PT_HEARTBEAT_ENABLED=1 开启 ----
// 每 5 分钟一次（PT_HEARTBEAT_INTERVAL_MS 覆盖），走真实对话同路径向默认模型发极短 prompt。
const HEARTBEAT_ENABLED = process.env.PT_HEARTBEAT_ENABLED === "1";
const HEARTBEAT_INTERVAL_MS = Number(process.env.PT_HEARTBEAT_INTERVAL_MS || (5 * 60 * 1000));
const HEARTBEAT_PROMPT = process.env.PT_HEARTBEAT_PROMPT || "ping";

// ---- 文档上传（纯文本 v1：.txt/.md/.csv）与上下文注入限制 ----
const DOC_UPLOAD_MAX_BYTES = Number(process.env.PT_DOC_UPLOAD_MB || 5) * 1024 * 1024;
const DOC_CONTEXT_MAX_CHARS = Number(process.env.PT_DOC_CONTEXT_CHARS || 100000);
const DOC_EXT_WHITELIST = new Set(["txt", "md", "csv"]);

// ---- 视频/音频上传（mp4/webm/mov/mp3/wav/m4a；单文件上限默认 50MB，PT_MEDIA_UPLOAD_MB 覆盖）----
const MEDIA_UPLOAD_MAX_BYTES = Number(process.env.PT_MEDIA_UPLOAD_MB || 50) * 1024 * 1024;

// ---- /uploads 静态服务 Content-Type 映射：图片 + 音视频（非 Chrome 浏览器播放视频/音频依赖正确 MIME）----
const UPLOAD_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

let auth = null;                 // 身份库句柄
let keys = null;                 // key 加密句柄
let conversations = null;        // 对话窗口化落库句柄
let memory = null;               // 用户长期记忆 / 所选模型
let panelShares = null;          // 面板分享落库句柄
let toolCalls = null;            // 工具调用日志落库句柄（M1）

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
};
function readBody(req, limit) {
  limit = limit || (1 << 20);
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// 读取原始二进制 body（multipart 上传用），超限返回 null 并断开连接
function readBodyBuffer(req, limit) {
  limit = limit || (1 << 20);
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); chunks.length = 0; resolve(null); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

// 读取并解析 multipart/form-data 上传
async function readMultipartUpload(req, limit) {
  const buf = await readBodyBuffer(req, limit);
  if (!buf) return null;
  return parseMultipart(buf, req.headers["content-type"]);
}
function cookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
const authed = (req) => (auth ? sessionFromCookie(req, auth) : Promise.resolve(null));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

/* ============================================================================
 * 看板多租户（A 方案 · 租户透传，默认关闭）
 * ========================================================================== */
const DASH_TENANT_INJECT = process.env.PT_DASH_TENANT_INJECT === "1";
const DASH_TENANT_HEADER = "x-tenant-id";

/** 组装发给看板后端的请求头：剥离浏览器可能伪造的租户头，再按开关注入登录会话的租户。 */
function dashProxyHeaders(req, tenantId) {
  const h = Object.assign({}, req.headers, { host: "127.0.0.1:" + DASH_PORT });
  delete h[DASH_TENANT_HEADER];
  if (DASH_TENANT_INJECT && tenantId) h[DASH_TENANT_HEADER] = String(tenantId);
  return h;
}

/* ============================================================================
 * DSH 入口发现（跨平台）
 * ========================================================================== */
function findDshEntry() {
  const explicit = arg("--dsh", null);
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
      } catch (e) {}
      return { js, nodePath };
    }
  }
  return { js: null, nodePath: null };
}
const DSH = findDshEntry();

/** 找不到 DSH 时的清晰中文报错（启动横幅 / /api/status 复用）。 */
function dshMissingHint() {
  return (
    "找不到 DSH 的 JS 入口（@deepseek-ai/dsh/lib/bin.js）。请二选一：\n" +
    "  ① 设环境变量 DSH_JS 指向该 bin.js 的绝对路径；\n" +
    "  ② 安装 dsh：npm install -g @deepseek-ai/dsh（或装到本仓库 node_modules），装好后重试。"
  );
}

/* ============================================================================
 * 并发控制：同一用户同一时刻只允许一个「生成中」的对话。
 *   runningJobs: userId -> job（null = 已 claim 还没 spawn；job = 运行中的子进程句柄）
 * ========================================================================== */
const runningJobs = new Map();

// dry-run 占位回复的序号（保证「重新生成」能得到不同回答，便于自测断言）
let dryRunSeq = 0;

/** 从 /uploads/<tenantId>/<file> URL 反推本地绝对路径（供 DSH 任务文本引用）。 */
function uploadsAbsPath(url) {
  const m = String(url || "").match(/\/uploads\/([^\/?#]+\/[^\/?#]+)/);
  return m ? path.join(RUNTIME, "_uploads", m[1]) : String(url || "");
}

/** 把 /uploads/<tenantId>/<file> 上传图片读成 base64 data URL（供 PowerTokens 外链）。 */
function uploadsToDataUrl(url) {
  const abs = uploadsAbsPath(url);
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return ""; }
  // 过大图片不进 prompt（base64 再膨胀约 1/3），避免撑爆上下文
  const maxBytes = 10 * 1024 * 1024;
  if (buf.length > maxBytes) return "";
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[ext] || "image/png";
  return "data:" + mime + ";base64," + buf.toString("base64");
}

/** 把上传字节按 UTF-8 严格解码为纯文本；非文本（NUL / 非法 UTF-8 / UTF-16）返回 null。 */
function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return null;
  let start = 0;
  // 跳过 UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  // 文本内容里不该出现 NUL 字节（二进制 / UTF-16 的特征），据此拒绝伪装成文本的文件
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0) return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(start));
  } catch (e) {
    return null;
  }
}

/** 按文件内容魔数识别视频/音频真实类型（不信任扩展名），返回 { kind, ext } 或 null。 */
function detectMediaType(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (o, n) => buf.toString("ascii", o, o + n);
  // WebM：EBML 头 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: "video", ext: "webm" };
  // WAV：RIFF .... WAVE
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { kind: "audio", ext: "wav" };
  // MP3：ID3 头或帧同步头（0xFF 后接 3 位同步 111）
  if (ascii(0, 3) === "ID3") return { kind: "audio", ext: "mp3" };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { kind: "audio", ext: "mp3" };
  // MP4 家族（ISO BMFF）：第 4 字节起为 ftyp，brand 区分 mp4 / mov / m4a
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "qt  ") return { kind: "video", ext: "mov" };
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", ext: "m4a" };
    return { kind: "video", ext: "mp4" };
  }
  return null;
}

/** 把本租户的文档 URL 读成正文并拼成上下文说明（累计字符上限 DOC_CONTEXT_MAX_CHARS）。 */
function docsToNote(urls, tenantId) {
  const items = (Array.isArray(urls) ? urls : []).map((u) => String(u == null ? "" : u).trim()).filter(Boolean);
  if (!items.length) return "";
  const dir = path.join(RUNTIME, "_uploads", tenantId);
  let note = "用户这次附带上传了以下文档，请把文档内容作为回答问题的参考上下文（除非用户明确要求，否则不要复述全文）：";
  let total = note.length;
  let used = 0;
  let truncated = false;
  for (const url of items) {
    const m = String(url).match(/\/uploads\/([^\/?#]+)\/([^\/?#]+)/);
    if (!m || m[1] !== tenantId) continue; // 只认本租户文件，拒绝跨租户路径
    const abs = path.join(dir, m[2]);
    let text;
    try { text = decodeTextBuffer(fs.readFileSync(abs)); } catch (e) { text = null; }
    if (text == null) continue;
    used++;
    const remaining = DOC_CONTEXT_MAX_CHARS - total;
    if (remaining <= 0) { truncated = true; break; }
    const header = "\n\n=== 文档 " + used + "（" + m[2] + "）===\n";
    let body = text;
    if (header.length + body.length > remaining) {
      body = body.slice(0, Math.max(0, remaining - header.length)) + "\n…（已截断）";
      truncated = true;
    }
    note += header + body;
    total = note.length;
    if (truncated) break;
  }
  if (!used) return "";
  if (truncated) note += "\n\n（文档总长度超过上下文上限，部分内容已截断）";
  return note;
}

/** P1-2：启动时清理超过 7 天的上传文件（按租户目录遍历）。 */
function pruneUploads() {
  const root = path.join(RUNTIME, "_uploads");
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const fn of fs.readdirSync(path.join(root, d.name))) {
        const abs = path.join(root, d.name, fn);
        try {
          if (Date.now() - fs.statSync(abs).mtimeMs > 7 * 24 * 3600 * 1000) fs.unlinkSync(abs);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

/** 导出：带 Content-Disposition 触发浏览器下载。 */
function exportResponse(res, filename, content, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store",
  });
  res.end(content);
}

/** Markdown 导出：按时间顺序拼 ## 用户 / ## 助手。 */
function toMarkdown(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const who = m.role === "user" ? "用户" : "助手";
    let body = m.text == null ? "" : String(m.text);
    if (m.image) body += "\n\n![图片](" + m.image + ")";
    return "## " + who + "\n\n" + body;
  }).join("\n\n");
}

/* ============================================================================
 * /api/chat 核心流程（异步，事件循环不阻塞）
 * ========================================================================== */
async function handleChat(req, res, me, body) {
  const uid = me.user.id;
  const conversationId = String(body.conversationId || "").trim();
  const regenerate = body.regenerate === true;
  const msgRaw = String(body.message || "").trim();
  const hasBranch = body.branchFrom !== undefined && body.branchFrom !== null;

  if (!conversationId) return json(res, 400, { ok: false, error: "缺少 conversationId" });
  if (!regenerate && !hasBranch && !msgRaw) return json(res, 400, { ok: false, error: "问题不能为空" });

  // 加载对话（归属校验：只取属于当前用户的）
  const conv = await conversations.get(uid, conversationId);
  if (!conv) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });

  // 归档对话只读：后端硬拦截（不依赖前端禁用），防止绕开前端直接调接口继续生成
  if (conv.archived) {
    return json(res, 409, { ok: false, archived: true, error: "该对话已归档，请先解除归档" });
  }

  let messages = Array.isArray(conv.messages) ? conv.messages : [];
  let question = msgRaw;

  // ⑩ 当前所选模型（默认 deepseek-v4-pro）
  let selectedModel = null;
  try { selectedModel = (memory && (await memory.getModel(uid))) || tenantMod.defaultModel(); }
  catch (e) { selectedModel = tenantMod.defaultModel(); }
  // AUTO（或从未选过模型）：按这条输入的特征路由到合适的对话模型（规则见 model-catalog.cjs）
  if (!selectedModel || selectedModel === modelCatalog.AUTO_ID) {
    try {
      const cat = await ensureModelCatalog();
      selectedModel = modelCatalog.routeModelFor(msgRaw, cat.models, modelCatalog.pickDefaultModel(cat.models, tenantMod.defaultModel()));
    } catch (e) { selectedModel = tenantMod.defaultModel(); }
  }

  // ⑨ 发消息附带的图片（URL 或本地路径）落到消息里
  const image = String(body.image || "").trim() || null;

  // 文档上传（纯文本 v1）：附带的文档 URL 列表，后端读取正文注入上下文（不传 URL 给模型）
  const documents = Array.isArray(body.documents)
    ? body.documents.map((d) => String(d == null ? "" : d).trim()).filter(Boolean)
    : [];
  // 只接受本租户上传目录里的文档。docsToNote 对跨租户/失效路径是「静默跳过」的，
  // 那样用户会以为文档生效了却拿不到任何提示，所以这里先拦一道并说清楚原因。
  for (const d of documents) {
    const m = /^\/uploads\/([^/?#]+)\/([^/?#]+)$/.exec(d);
    if (!m || m[1] !== me.tenant.id || !/^[A-Za-z0-9._-]+$/.test(m[2])) {
      return json(res, 400, { ok: false, error: "无法读取该文档（不属于当前租户或文件已失效），请重新上传" });
    }
  }

  // 视频/音频附件：前端发来的是 [{ type, url }] 对象数组（气泡里要区分视频/音频），
  // 与 documents 的纯 URL 字符串数组不同。模型无法解析音视频内容，后端只做归属校验并注入提示，
  // 不读取正文（URL 本身也不下发给模型）。
  const mediaAttachments = Array.isArray(body.media)
    ? body.media
        .map((m) => {
          if (!m || typeof m !== "object") return null;
          const url = String(m.url == null ? "" : m.url).trim();
          const typeRaw = String(m.type != null ? m.type : m.kind).trim().toLowerCase();
          const type = typeRaw === "video" || typeRaw === "audio" ? typeRaw : null;
          return url && type ? { type, url } : null;
        })
        .filter(Boolean)
    : [];
  for (const att of mediaAttachments) {
    const m = /^\/uploads\/([^/?#]+)\/([^/?#]+)$/.exec(att.url);
    if (!m || m[1] !== me.tenant.id || !/^[A-Za-z0-9._-]+$/.test(m[2])) {
      return json(res, 400, { ok: false, error: "无法读取该媒体附件（不属于当前租户或文件已失效），请重新上传" });
    }
  }

  // 素材生成类型（前端聊天框选择，对应 media.route 的 taskType）。
  // 不传 / 非法值 = 自动：不在提示里强加生成指令，交给 Agent 自己判断，
  // 免得普通问答被带偏成素材生成。
  const MEDIA_TASK_TYPES = { text2image: 1, image2image: 1, text2video: 1, image2video: 1 };
  const taskType = (body.taskType && MEDIA_TASK_TYPES[String(body.taskType)]) ? String(body.taskType) : null;

  // M2：当前上下文（如 { panel, panelLabel }），透传给 DSH 拼进系统提示
  const context = (body.context && typeof body.context === "object" && !Array.isArray(body.context)) ? body.context : null;

  // ⑤ 分岔：以某条 assistant 消息之前的上下文重新生成
  const branchFrom = (body.branchFrom !== undefined && body.branchFrom !== null) ? body.branchFrom : null;

  if (branchFrom !== null) {
    let bi = -1;
    if (typeof branchFrom === "number") bi = branchFrom;
    else bi = messages.findIndex((m) => m && m.ts === String(branchFrom));
    if (bi < 0 || bi >= messages.length) return json(res, 400, { ok: false, error: "分岔位置无效" });
    if (!messages[bi] || messages[bi].role !== "assistant") return json(res, 400, { ok: false, error: "只能对助手回复分岔" });
    // 保留该 assistant 之前的全部历史（含它对应的用户问题），丢弃该 assistant 及其后
    const hist = messages.slice(0, bi);
    let qi = -1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].role === "user") { qi = i; break; }
    if (qi < 0) return json(res, 400, { ok: false, error: "没有找到对应的问题" });
    question = String(hist[qi].text || "").trim();
    if (!question) return json(res, 400, { ok: false, error: "问题为空" });
    messages = hist;
  } else if (regenerate) {
    if (!messages.length) return json(res, 400, { ok: false, error: "没有可重新生成的内容" });
    const last = messages[messages.length - 1];
    if (last.role === "assistant") {
      let qi = -1;
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === "user") { qi = i; break; }
      }
      if (qi < 0) return json(res, 400, { ok: false, error: "没有找到对应的问题" });
      question = String(messages[qi].text || "").trim();
      if (!question) return json(res, 400, { ok: false, error: "问题为空" });
      messages = messages.slice(0, messages.length - 1);
    } else if (last.role === "user") {
      question = String(last.text || "").trim();
      if (!question) return json(res, 400, { ok: false, error: "问题为空" });
    } else {
      return json(res, 400, { ok: false, error: "无法重新生成" });
    }
  } else {
    const um = { role: "user", text: question, ts: new Date().toISOString() };
    if (image) um.image = image;
    if (documents.length) um.documents = documents;
    if (mediaAttachments.length) um.media = mediaAttachments;
    messages = messages.concat([um]);
  }

  // 未绑 key 预检：先友好提示，不落库「悬空问题」
  let preKey = null;
  try { preKey = await keys.decryptApiKey(uid); } catch (e) { /* 交给 runDshForUser 再报 */ }
  if (!preKey || !String(preKey).trim()) {
    return json(res, 409, { ok: false, needKey: true, error: "还没保存你的 PT key（BYOK）。请先到「设置」页保存 key，再开始对话。" });
  }

  // 先把用户问题落库（停止/失败也不丢问题）
  await conversations.saveMessages(uid, conversationId, messages);

  // 组装上下文（交给 tenant 常驻层决定冷/热：冷启动才补历史，热会话由 DSH session 持有轨迹）
  let memText = "";
  try { memText = ((memory && (await memory.memoryLines(uid))) || []).map((l) => "  · " + l).join("\n"); } catch (e) { memText = ""; }
  let histText = "";
  if (messages.length > 1) {
    histText = messages.slice(0, -1).slice(-6).map((c) => (c.role === "user" ? "用户" : "助手") + "：" + c.text).join("\n");
  }
  // ⑨ 图片说明（多模态）：把上传图片转成 base64 data URL 传给 DSH，
  // 使 media.route（图生图 / 图生视频）能把 inputImageUrl 直接外链给 PowerTokens，
  // 规避 /uploads 相对路径需登录+租户校验、无法被外部访问的问题。
  const lastUser = messages[messages.length - 1];
  const dataUrl = (lastUser && lastUser.image) ? uploadsToDataUrl(lastUser.image) : null;
  const TASK_LABEL = {
    text2image: "text2image（文生图）",
    image2image: "image2image（图生图）",
    text2video: "text2video（文生视频）",
    image2video: "image2video（图生视频）",
  };
  let imageNote = "";
  if (taskType) {
    // 前端明确选了生成类型：直接按 media.route 的 taskType 下指令
    const needsImage = (taskType === "image2image" || taskType === "image2video");
    if (needsImage && !dataUrl) {
      imageNote = "用户选择了「" + TASK_LABEL[taskType] + "」，但没有提供参考图。请据实说明需要先上传一张参考图再生成。";
    } else if (needsImage) {
      imageNote =
        "用户选择了「" + TASK_LABEL[taskType] + "」。请调用 media.route 工具：taskType 用 " + taskType +
        "，并把 inputImageUrl 设为下面的 data URL 原文：\n" + dataUrl;
    } else {
      // text2image / text2video：只靠文字描述，不要求参考图
      imageNote =
        "用户选择了「" + TASK_LABEL[taskType] + "」，只给了文字描述、没有参考图。请调用 media.route 工具：" +
        "taskType 用 " + taskType + "，不要传 inputImageUrl。" +
        "注意：不要因为「没有参考图」就擅自改成图生图 / 图生视频，就按用户选的类型走。";
    }
  } else if (lastUser && lastUser.image) {
    // 自动模式：沿用原来的图片说明（图生图 / 图生视频）
    if (dataUrl) {
      imageNote =
        "用户这次附带了一张图片（内容已编码为下面的 data URL）。" +
        "当用户要求「把这张图改成… / 用这张图生成新图 / 把这张图做成视频 / 用这张图生成视频」时，" +
        "请调用 media.route 工具：taskType 用 image2image（图生图）或 image2video（图生视频），" +
        "并把 inputImageUrl 设为下面的 data URL 原文：\n" + dataUrl;
    } else {
      imageNote =
        "用户这次附带了一张图片，但服务端未能把它编码成 data URL（可能文件缺失或过大）。" +
        "请据实说明你暂无法拿到可用的图片数据。";
    }
  }

  // 文档上下文说明（纯文本 v1）：把上传文档正文读出来拼进 prompt（有累计长度上限）
  let docNote = "";
  if (lastUser && Array.isArray(lastUser.documents) && lastUser.documents.length) {
    docNote = docsToNote(lastUser.documents, me.tenant.id);
  }

  // 视频/音频附件说明：模型无法解析音视频内容，只加一句提示，避免模型假装「看过/听过」
  let mediaNote = "";
  if (lastUser && Array.isArray(lastUser.media) && lastUser.media.length) {
    mediaNote = "用户这次附带上传了 " + lastUser.media.length +
      " 个视频/音频附件。这些文件的内容无法被模型解析（既看不到画面也听不到声音），" +
      "请不要假装已经查看或听懂它们，也不要虚构其中内容；如果用户的问题依赖这些附件，请如实说明你无法解析其内容。";
  }

  // GA 查询错误码的固定说明：防止 AI 拿到原始错误码后现场编造不存在的入口、或把两种含义
  // 完全不同的错误（租户未授权 vs 平台级配置缺失）混为一谈。GA4 绑定真实入口在「技能」页。
  const gaNote =
    "当 ga_query（业务工具 ga.query）返回错误码时，请严格按下述固定说明回复，不要自行推测或编造入口：\n" +
    "- 错误码 GA_AUTHORIZATION_REQUIRED：表示当前租户尚未授权连接 GA4 property。请引导用户前往「技能」页完成 GA4 property 的绑定/授权（入口在「技能」页，不在「数据集成」）。\n" +
    "- 错误码 GA_NOT_CONFIGURED：表示平台侧 GA4 连接配置缺失（如 GA_CLIENT_ID / GA_CLIENT_SECRET / GA_REDIRECT_URI / GA_TOKEN_ENCRYPTION_KEY 等环境变量未配置），属于系统级配置问题，不是用户自己能解决的。请如实说明这是系统侧配置缺失，建议用户联系管理员处理；不要引导用户去点击「GA4 授权」（点了也会失败）。";

  // ===== 流式（SSE）：先切响应头，后续增量用 sse() 逐段下发 =====
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const sse = (obj) => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} };

  // 任务B：请求已受理，先推一帧「正在建立模型连接」，让前端区分「连接中」与「思考中」。
  // 每次请求都发一次（热连接下会立刻被后续 delta 覆盖，用户几乎无感）。
  sse({ connecting: true });

  // ⑤ 分岔 / 重新生成：重置该对话的 DSH session（丢弃旧轨迹），下一问冷启动、只重放截断后的历史
  if (hasBranch || regenerate) {
    try { tenantMod.closeDshSession(conversationId); } catch (e) { /* 忽略 */ }
  }

  // M4：已授权能力清单（按当前用户/租户过滤）+ 业务线约束（从资产包只读读取，不写死）
  const permCtx = { userId: uid, tenantId: me.tenant.id, workspaceId: "ws_" + me.tenant.id };
  let capabilities = [];
  try { capabilities = await toolsRegistry.listToolsForWorkspace(permCtx.workspaceId, permCtx); } catch (e) { capabilities = []; }
  const constraints = loadBusinessConstraints({ log });

  // 视频生成（文生视频/图生视频）业务线内部轮询预算为 1 小时（business/media/powertokens.cjs），
  // 外层 DSH 任务超时需给足余量，否则会被默认 3 分钟提前掐断；图片/文字维持原来的短超时。
  const VIDEO_TASK_TIMEOUT_MS = 65 * 60 * 1000; // 65 分钟
  const taskTimeoutMs = (taskType === "text2video" || taskType === "image2video") ? VIDEO_TASK_TIMEOUT_MS : undefined;

  const r = await tenantMod.runDshForUser(uid, question, {
    tenantId: me.tenant.id,
    conversationId,
    history: histText,
    memory: memText,
    imageNote,
    docNote,
    mediaNote,
    gaNote,
    context,
    capabilities,
    constraints,
    decryptApiKey: keys.decryptApiKey,
    dryRun: DRY_RUN_CHAT,
    model: selectedModel,
    timeoutMs: taskTimeoutMs,
    onSpawn: (job) => { runningJobs.set(uid, job); },
    onDelta: (delta) => { sse({ delta }); },
    onStep: (step) => { sse({ step }); },
    onArtifact: (a) => { sse({ artifact: a }); },   // Agent 写了可预览文件：立刻让前端弹面板（提前量）
  });

  // A1/A3/A4：把本轮真实用到的工具补写进 tool_calls（含分类 / 模型 / 终态）。
  // 成功 / 中断 / 失败三态都落库，避免失败或中断的任务在日志里完全消失。
  const persistSteps = async (steps, defaultStatus) => {
    if (!toolCalls || DRY_RUN_CHAT) return;
    try {
      for (const step of (Array.isArray(steps) ? steps : [])) {
        if (!step || !step.name) continue;
        const status = (defaultStatus && defaultStatus !== "completed")
          ? defaultStatus
          : (step.isError === true ? "failed" : "completed");
        const { id } = await toolCalls.start({
          tenantId: me.tenant.id,
          workspaceId: "ws_" + me.tenant.id,
          userId: uid,
          toolName: String(step.name),
          inputSummary: step.args != null ? String(step.args) : "",
          category: toolsRegistry.toolCategory(String(step.name)),
          modelName: step.modelName != null ? String(step.modelName) : null,
        });
        await toolCalls.finish(id, {
          outputSummary: step.result != null ? String(step.result) : "",
          durationMs: step.durationMs != null ? Number(step.durationMs) : null,
          tokenCount: null,
          status,
          modelName: step.modelName != null ? String(step.modelName) : null,
        });
      }
    } catch (e) {
      log.error("tool_calls.log_failed", { error: e && e.message ? e.message : String(e) });
    }
  };

  // A2：落主对话轮次真实 token 用量（与 tool_calls 子工具调用分开），供今日/本月/按模型聚合。
  const persistUsage = async () => {
    if (!toolCalls || DRY_RUN_CHAT) return;
    const u = r.usage && typeof r.usage === "object" ? r.usage : null;
    if (!u) return;
    try {
      await toolCalls.logUsage({
        tenantId: me.tenant.id,
        workspaceId: "ws_" + me.tenant.id,
        userId: uid,
        model: selectedModel || null,
        promptTokens: u.prompt_tokens != null ? Number(u.prompt_tokens) : null,
        completionTokens: u.completion_tokens != null ? Number(u.completion_tokens) : null,
        totalTokens: u.total_tokens != null ? Number(u.total_tokens) : null,
      });
    } catch (e) {
      log.error("chat_usage.log_failed", { error: e && e.message ? e.message : String(e) });
    }
  };

  // 兜底：runDshForUser 内部因 key 来源缺失 / 无 key 失败
  if (!r.ok && (r.code === tenantMod.NO_API_KEY_CODE || r.code === tenantMod.NO_KEY_SOURCE_CODE)) {
    sse({ done: true, ok: false, needKey: true, error: r.error, messages });
    return res.end();
  }

  // 停止 / 超时中断：问题已保存，没跑完的回答丢弃不保存。
  // stopReason 区分「真超时被强制中断」与「用户手动点停止」—— 以前两者都只回一句「已停止」，
  // 前端分不清是卡死被掐断还是自己停的，现在分开（timeout / user）。
  if (r.stopped) {
    await persistSteps(r.steps, "interrupted");
    await persistUsage();
    const cur = await conversations.get(uid, conversationId);
    const reason = r.stopReason === "timeout" ? "timeout" : "user";
    sse({
      done: true, ok: false, stopped: true, stopReason: reason,
      error: reason === "timeout" ? "生成超时，已中断" : "已停止",
      artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
      messages: cur ? cur.messages : messages,
    });
    return res.end();
  }

  if (!r.ok) {
    await persistSteps(r.steps, "failed");
    await persistUsage();
    // DSH 执行失败：把失败信息作为助手回复落库
    const errText = "（DSH 执行失败：" + (r.error || "退出码 " + r.code) + "）" + (r.text ? "\n" + r.text : "");
    const saved = messages.concat([{ role: "assistant", text: errText, ts: new Date().toISOString() }]);
    await conversations.saveMessages(uid, conversationId, saved);
    sse({ done: true, ok: false, reply: errText, messages: saved, error: r.error, turns: saved.filter((m) => m.role === "assistant").length });
    return res.end();
  }

  // 成功（dry-run 或真实 DSH 输出）
  let reply = r.text;
  let steps = Array.isArray(r.steps) ? r.steps : [];
  // 任务1：对话内 DSH 调用不经过 /api/tools/:name/execute，这里把本轮真实用到的工具补写进 tool_calls 表
  await persistSteps(steps, "completed");
  await persistUsage();
  if (DRY_RUN_CHAT) {
    reply = "[PT_CHAT_DRYRUN 占位回复 #" + (++dryRunSeq) + " @ " + Date.now() + "，非真实 DSH 输出]";
    sse({ delta: reply });
    // DRYRUN 假轨迹：只用于验证前端「过程」渲染；真实轨迹需真实 PT key
    steps = [
      { name: "ad-strategy", args: "{\"scope\":\"北极星\"}", result: "（占位）读取广告数据…", isError: false },
      { name: "dashboard-interpret", args: "", result: "（占位）归因看板解读…", isError: false },
    ];
    for (const s of steps) sse({ step: s });
  }
  const media = Array.isArray(r.media) ? r.media : null;
  const report = r.report && typeof r.report === "object" ? r.report : null;
  const saved = messages.concat([{ role: "assistant", text: reply || (r.ok ? "（DSH 没有输出）" : ""), ts: new Date().toISOString(), steps, ...(media ? { media } : {}), ...(report ? { report } : {}) }]);
  await conversations.saveMessages(uid, conversationId, saved);

  sse({
    done: true,
    ok: true,
    reply: reply || "（DSH 没有输出）",
    messages: saved,
    steps,
    artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
    ...(media ? { media } : {}),
    ...(report ? { report } : {}),
    ms: r.ms || 0,
    turns: saved.filter((m) => m.role === "assistant").length,
    ...(DRY_RUN_CHAT ? { dryRun: true, tenantId: r.tenantId, workspace: r.cwd, userId: r.userId, keySha256: r.keySha256 } : {}),
  });
  return res.end();
}

/** 反向代理：把看板藏到业务壳后面。 */
function proxyDashboard(req, res, tenantId) {
  const sub = req.url.replace(/^\/dashboard/, "") || "/";
  // P0-3 安全：token 不再拼进 URL；前端 API 调用由服务端注入 Authorization（见 /api/analytics 反代）。
  const target = sub;
  const p = http.request({ host: "127.0.0.1", port: DASH_PORT, path: target, method: req.method,
    headers: dashProxyHeaders(req, tenantId) },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  p.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>看板服务没起来</h2><p>请先启动北极星后端（默认 127.0.0.1:" + DASH_PORT + "）。</p>");
  });
  req.pipe(p);
}
/** 写分享会话 cookie（HttpOnly，供 /api/analytics 匿名只读回退识别）。 */
function setShareCookie(res, token) {
  const sec = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", "pt_share=" + encodeURIComponent(token) + "; HttpOnly; SameSite=Lax; Path=/" + sec);
}

const SHARE_CSS =
  "body{margin:0;font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#f6f7fb;color:#0f172a}" +
  ".wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}" +
  ".card{background:#fff;border:1px solid #e6e9f0;border-radius:16px;padding:40px 44px;max-width:460px;text-align:center;box-shadow:0 20px 50px rgba(15,23,42,.12)}" +
  ".ico{font-size:44px}.card h1{margin:12px 0 8px;font-size:20px}.card p{margin:6px 0;color:#64748b}" +
  ".banner{display:flex;align-items:center;gap:10px;padding:10px 18px;background:#141a2e;color:#aab3c8;font-size:13px}" +
  ".banner b{color:#fff;font-weight:600}" +
  ".view-wrap{display:flex;flex-direction:column;height:100vh}" +
  "#shareFrame{flex:1;border:0;width:100%;background:#fff}";

function shareHtml(title, inner) {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title>" +
    "<style>" + SHARE_CSS + "</style></head><body>" + inner + "</body></html>";
}

/** 分享失效页（token 不存在 / 已撤销 / 已过期）。 */
function serveShareInvalid(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(shareHtml("分享已失效",
    '<div class="wrap"><div class="card"><div class="ico">🔒</div><h1>分享已失效</h1>' +
    '<p>这个分享链接已失效（可能已被撤销、已过期，或链接有误）。</p>' +
    '<p>请联系分享者重新获取链接。</p></div></div>'));
}

/** 分享落地页（有效）：顶部只读横幅 + 全屏只读看板 iframe。 */
function serveShareLanding(res, token) {
  const src = "/panel/share/" + encodeURIComponent(token) + "/view/";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(shareHtml("归因面板 · 只读分享",
    '<div class="view-wrap"><div class="banner">🔗 <b>只读分享视图</b> —— 你正在查看一个被分享的归因面板，仅可查看、不可操作。</div>' +
    '<iframe id="shareFrame" src="' + src + '"></iframe></div>'));
}

/** 分享只读看板反向代理：藏在 /panel/share/<token>/view/ 后面，注入只读 token。 */
function proxyShareDashboard(req, res) {
  const sub = req.url.replace(/^\/panel\/share\/[^\/]+\/view/, "") || "/";
  // P0-3 安全：token 不再拼进 URL；前端 API 调用由服务端注入 Authorization。
  const target = sub;
  const p = http.request({ host: "127.0.0.1", port: DASH_PORT, path: target, method: req.method,
    headers: dashProxyHeaders(req, null) },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  p.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>看板服务没起来</h2><p>请先启动北极星后端（默认 127.0.0.1:" + DASH_PORT + "）。</p>");
  });
  req.pipe(p);
}

function serveFile(res, f) {
  if (!fs.existsSync(f)) { res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<h2>404</h2>"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(f));
}

/** /uploads 流式响应：支持 Range（Accept-Ranges + 206 分段），用 createReadStream 避免整文件读入内存阻塞。
 *  视频/音频播放与拖进度条依赖 Range；不信任客户端 Range，越界回 416。 */
function serveUploadedFile(req, res, f, contentType) {
  let st;
  try { st = fs.statSync(f); } catch (e) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("<h2>404</h2>");
  }
  const size = st.size;
  const isHead = req.method === "HEAD";
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m && !(m[1] === "" && m[2] === "")) {
    let start, end;
    if (m[1] === "") {
      // 后缀范围 bytes=-N：取末尾 N 字节
      const n = parseInt(m[2], 10);
      start = n > 0 ? Math.max(0, size - n) : 0;
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
      res.writeHead(416, { "Content-Range": "bytes */" + size });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    if (isHead) return res.end();
    const s = fs.createReadStream(f, { start, end });
    s.on("error", (e) => res.destroy(e));
    return s.pipe(res);
  }

  res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
  if (isHead) return res.end();
  const s = fs.createReadStream(f);
  s.on("error", (e) => res.destroy(e));
  s.pipe(res);
}

/** P1-1 CSRF：写操作校验 Origin/Referer 与 Host 同源（跨站请求 Origin 必为异源，直接拒绝）。 */
function csrfOk(req) {
  const host = req.headers.host;
  if (!host) return true; // 无 Host 的非浏览器场景，放行
  const refs = [req.headers.origin, req.headers.referer].filter(Boolean);
  if (refs.length === 0) return true; // 无 Origin/Referer（curl/同源表单），放行
  return refs.every((r) => {
    try { return new URL(r).host === host; } catch (e) { return false; }
  });
}

async function handle(req, res) {
  // ---- /healthz 探活端点（无鉴权）----
  let hp = null;
  try { hp = new URL(req.url, "http://127.0.0.1:" + PORT).pathname; } catch (e) {}
  if (hp === "/healthz") {
    return json(res, 200, {
      ok: true, status: "ok", version: "1.0.0",
      pid: process.pid, uptimeSec: Math.floor(process.uptime()), ts: new Date().toISOString(),
    });
  }

  // ---- P1-1 CSRF：所有写操作（非 GET/HEAD/OPTIONS）校验同源 ----
  const method0 = (req.method || "GET").toUpperCase();
  if (method0 !== "GET" && method0 !== "HEAD" && method0 !== "OPTIONS" && !csrfOk(req)) {
    return json(res, 403, { ok: false, error: "跨站请求被拒绝" });
  }

  // ---- 先交给身份路由与 key 路由（含旧 /api/login|logout|me 别名）----
  if (auth && (await handleAuthRoutes(req, res, auth))) return;
  if (auth && keys && (await handleKeyRoutes(req, res, auth, keys))) return;

  const p = new URL(req.url, "http://127.0.0.1:" + PORT).pathname;

  // ---- 优雅停机端点（仅在设 PT_TEST_SHUTDOWN_TOKEN 时存在）----
  if (process.env.PT_TEST_SHUTDOWN_TOKEN && p === "/__test_shutdown" && req.method === "POST") {
    const tok = req.headers["x-shutdown-token"] || "";
    if (tok !== process.env.PT_TEST_SHUTDOWN_TOKEN) return json(res, 403, { ok: false, error: "无权限" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, bye: true }));
    setTimeout(() => gracefulShutdown(), 80);
    return;
  }

  if (p === "/login" || p === "/login.html") return serveFile(res, path.join(PUBLIC, "login.html"));
  if (p === "/settings" || p === "/settings.html") return serveFile(res, path.join(PUBLIC, "settings.html"));
  // ---- U3：忘记/重置密码页（登出态公开页，不能套 authed 重定向）----
  if (p === "/forgot" || p === "/forgot.html") return serveFile(res, path.join(PUBLIC, "forgot.html"));
  if (p === "/reset" || p === "/reset.html") return serveFile(res, path.join(PUBLIC, "reset.html"));
  if (p === "/" || p === "/index.html") {
    if (!(await authed(req))) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    return serveFile(res, path.join(PUBLIC, "index.html"));
  }
  if (p.indexOf("/assets/") === 0) {
    const f = path.join(PUBLIC, p.slice("/assets/".length));
    if (f.indexOf(PUBLIC) !== 0) return json(res, 403, { ok: false, error: "非法路径" });
    return serveFile(res, f);
  }
  // ---- ⑨ 上传图片静态服务（P1-2：路径 = /uploads/<tenantId>/<filename>，校验登录用户租户归属）----
  if (p.indexOf("/uploads/") === 0) {
    const rel = decodeURIComponent(p.slice("/uploads/".length));
    const parts = rel.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return json(res, 403, { ok: false, error: "非法路径" });
    const [tenantId, fname] = parts;
    if (fname.indexOf("..") >= 0 || fname.indexOf("\\") >= 0) return json(res, 403, { ok: false, error: "非法路径" });
    // P1-2：必须登录且租户匹配才能读自己的上传
    const meUp = await authed(req);
    if (!meUp || !meUp.tenant || meUp.tenant.id !== tenantId) return json(res, 403, { ok: false, error: "无权访问" });
    const f = path.join(RUNTIME, "_uploads", tenantId, fname);
    const ct = UPLOAD_MIME[path.extname(f).toLowerCase()] || "application/octet-stream";
    return serveUploadedFile(req, res, f, ct);
  }
  if (p === "/dashboard" || p.indexOf("/dashboard/") === 0) {
    const meDash = await authed(req);
    if (!meDash) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    return proxyDashboard(req, res, meDash && meDash.tenant ? meDash.tenant.id : null);
  }

  // ---- 面板分享落地页（匿名可访问；校验 token）----
  const shareLandMatch = p.match(/^\/panel\/share\/([^\/]+)\/?$/);
  if (shareLandMatch) {
    const token = decodeURIComponent(shareLandMatch[1]);
    const v = await panelShares.verify(token);
    if (!v.valid) return serveShareInvalid(res);
    setShareCookie(res, token);
    return serveShareLanding(res, token);
  }

  // ---- 面板分享：只读看板反向代理（匿名可访问；每请求校验 token）----
  if (/^\/panel\/share\/[^\/]+\/view/.test(p)) {
    const m = p.match(/^\/panel\/share\/([^\/]+)\/view/);
    const v = await panelShares.check(decodeURIComponent(m[1]));
    if (!v.valid) return serveShareInvalid(res);
    return proxyShareDashboard(req, res);
  }

  // ---- /api/analytics 反向代理：登录用户 或 有效分享 cookie（均为只读 token）----
  // B14：不再使用全局 PT_DASH_TOKEN，而是按租户动态计算 HMAC 分析 token。
  if (p.indexOf("/api/analytics/") === 0) {
    const meAnalytics = await authed(req);
    let shareOk = null;
    const shareTok = cookie(req, "pt_share");
    if (shareTok) { shareOk = await panelShares.check(shareTok); }
    if (!meAnalytics && !(shareOk && shareOk.valid)) return json(res, 401, { ok: false, error: "没登录" });
    // 确定租户：登录用户用自己的租户；匿名分享用分享者的租户
    let tenantId = null;
    if (meAnalytics && meAnalytics.tenant) {
      tenantId = meAnalytics.tenant.id;
    } else if (shareOk && shareOk.share && shareOk.share.owner_user_id) {
      const owner = await auth.db.query("SELECT tenant_id FROM users WHERE id = $1", [shareOk.share.owner_user_id]);
      tenantId = owner.rows.length ? owner.rows[0].tenant_id : null;
    }
    if (!tenantId) return json(res, 403, { ok: false, error: "无法确定访问租户" });
    // B14：动态计算 HMAC token（无需缓存）
    const INTERNAL_KEY = process.env.PT_DASH_INTERNAL_KEY;
    if (!INTERNAL_KEY) return json(res, 503, { ok: false, error: "内部密钥 PT_DASH_INTERNAL_KEY 未配置" });
    const analyticsToken = crypto.createHmac("sha256", INTERNAL_KEY).update(tenantId).digest("hex");
    const up = http.request({ host: "127.0.0.1", port: DASH_PORT, path: req.url, method: req.method,
      headers: Object.assign(dashProxyHeaders(req, tenantId),
        { authorization: "Bearer " + analyticsToken }) },
      (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    up.on("error", (e) => { log.error("analytics_proxy_failed", { error: e && e.message ? e.message : String(e) }); json(res, 502, { ok: false, error: "看板服务不可用" }); });
    return req.pipe(up);
  }

  // ---- /api/attribution 反向代理：仅登录用户（归因结果 REST，只读）----
  // U2 前置：补上此前 B14 沟通时遗漏的前缀分支。模式同 /api/business/。
  if (p.indexOf("/api/attribution/") === 0) {
    const meAttribution = await authed(req);
    if (!meAttribution) return json(res, 401, { ok: false, error: "没登录" });
    const tenantId = meAttribution.tenant ? meAttribution.tenant.id : null;
    // B14：动态计算 HMAC token（无需缓存）
    const INTERNAL_KEY = process.env.PT_DASH_INTERNAL_KEY;
    if (!INTERNAL_KEY) return json(res, 503, { ok: false, error: "内部密钥 PT_DASH_INTERNAL_KEY 未配置" });
    const analyticsToken = crypto.createHmac("sha256", INTERNAL_KEY).update(tenantId).digest("hex");
    const up = http.request({ host: "127.0.0.1", port: DASH_PORT, path: req.url, method: req.method,
      headers: Object.assign(dashProxyHeaders(req, tenantId),
        { authorization: "Bearer " + analyticsToken }) },
      (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    up.on("error", (e) => { log.error("attribution_proxy_failed", { error: e && e.message ? e.message : String(e) }); json(res, 502, { ok: false, error: "归因服务不可用" }); });
    return req.pipe(up);
  }

  // ---- /api/business 反向代理：仅登录用户（业务线接口：归因导入 import / 事件接入适配层 ingestion 等）----
  // B13：此前 shell 完全没有 /api/business/ 反代，U1 前端请求到 shell 这层就 404，根本到不了业务线接口。
  // B14：不再使用全局 PT_DASH_TOKEN，而是按租户动态计算 HMAC 分析 token。
  if (p.indexOf("/api/business/") === 0) {
    const meBusiness = await authed(req);
    if (!meBusiness) return json(res, 401, { ok: false, error: "没登录" });
    const tenantId = meBusiness.tenant ? meBusiness.tenant.id : null;
    // B14：动态计算 HMAC token（无需缓存）
    const INTERNAL_KEY = process.env.PT_DASH_INTERNAL_KEY;
    if (!INTERNAL_KEY) return json(res, 503, { ok: false, error: "内部密钥 PT_DASH_INTERNAL_KEY 未配置" });
    const analyticsToken = crypto.createHmac("sha256", INTERNAL_KEY).update(tenantId).digest("hex");
    const up = http.request({ host: "127.0.0.1", port: DASH_PORT, path: req.url, method: req.method,
      headers: Object.assign(dashProxyHeaders(req, tenantId),
        { authorization: "Bearer " + analyticsToken }) },
      (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    up.on("error", (e) => { log.error("business_proxy_failed", { error: e && e.message ? e.message : String(e) }); json(res, 502, { ok: false, error: "业务线服务不可用" }); });
    return req.pipe(up);
  }

  const me = await authed(req);
  if (!me) return json(res, 401, { ok: false, error: "没登录" });
  if (await handleMemberRoutes(req, res, auth, me)) return;
  if (await handleAuthAccountsRoutes(req, res, auth, me)) return;

  // ---- M1：工具清单 / 工具执行 / 工具调用日志（按 workspace 隔离）----
  const workspaceIdFor = (m) => "ws_" + (m && m.tenant ? m.tenant.id : "");
  if (p === "/api/tools" && req.method === "GET") {
    const context = { userId: me.user.id, tenantId: me.tenant.id, workspaceId: workspaceIdFor(me) };
    const list = await toolsRegistry.listToolsForWorkspace(context.workspaceId, context);
    return json(res, 200, { ok: true, tools: list });
  }
  const toolExecMatch = p.match(/^\/api\/tools\/([^\/]+)\/execute$/);
  if (toolExecMatch && req.method === "POST") {
    const name = decodeURIComponent(toolExecMatch[1]);
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
    const args = body.args != null ? body.args : {};
    const context = { userId: me.user.id, tenantId: me.tenant.id, workspaceId: workspaceIdFor(me) };
    try {
      const result = await toolsRegistry.executeTool(name, args, context);
      return json(res, 200, { ok: true, result });
    } catch (e) {
      return json(res, 400, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  }
  if (p === "/api/usage/tool-calls" && req.method === "GET") {
    const u = new URL(req.url, "http://127.0.0.1:" + PORT);
    const range = (u.searchParams.get("range") || "today").toLowerCase();
    if (!["today", "week", "month"].includes(range)) {
      return json(res, 400, { ok: false, error: "range 只能是 today|week|month" });
    }
    const calls = await toolCalls.list({ tenantId: me.tenant.id, workspaceId: workspaceIdFor(me), range });
    return json(res, 200, { ok: true, calls });
  }
  if (p === "/api/usage/summary" && req.method === "GET") {
    const u = new URL(req.url, "http://127.0.0.1:" + PORT);
    const range = (u.searchParams.get("range") || "month").toLowerCase();
    if (!["today", "week", "month"].includes(range)) {
      return json(res, 400, { ok: false, error: "range 只能是 today|week|month" });
    }
    const summary = await toolCalls.usageSummary({ tenantId: me.tenant.id, workspaceId: workspaceIdFor(me), range });
    return json(res, 200, { ok: true, summary });
  }

  // ---- M3：工作区业务线启用状态查询（基座层只读接口）----
  // 内部调用业务线既有只读接口 GET /api/business/attribution/import/workspace，
  // 拿 firstConnectedAt 归一化成可扩展的 features 形状。不 import 业务线模块、不读其数据库表。
  if (p === "/api/workspaces/enabled-status" && req.method === "GET") {
    const INTERNAL_KEY = process.env.PT_DASH_INTERNAL_KEY;
    if (!INTERNAL_KEY) return json(res, 503, { ok: false, error: "内部密钥 PT_DASH_INTERNAL_KEY 未配置" });
    try {
      const raw = await queryBusinessWorkspace({
        internalKey: INTERNAL_KEY,
        dashPort: DASH_PORT,
        tenantId: me.tenant.id,
      });
      if (raw.statusCode !== 200) {
        return json(res, 502, { ok: false, error: "业务线工作区状态查询失败（" + raw.statusCode + "）" });
      }
      const status = normalizeEnabledStatus(raw.body);
      return json(res, 200, Object.assign({ ok: true }, status));
    } catch (e) {
      log.error("workspace_enabled_status_failed", { error: e && e.message ? e.message : String(e) });
      return json(res, 502, { ok: false, error: "业务线服务不可用" });
    }
  }

  if (p === "/api/skills") {
    // 技能清单 = 已注册的业务工具（与「业务流库」/api/tools 同一数据源 toolsRegistry）。
    // 不再读从未被写入过的 runtime/workspace/.dsh/skills/ 目录。
    const context = { userId: me.user.id, tenantId: me.tenant.id, workspaceId: workspaceIdFor(me) };
    const SKILL_TITLES = { "attribution.query": "归因查询", "media.route": "媒体生成", "ga.query": "GA 数据查询", "tracking_quality_audit": "埋点质量分析" };
    const SKILL_QUESTIONS = {
      "attribution.query": "最近7天各渠道素材表现如何？",
      "media.route": "帮我生成一张产品宣传图：画面是一杯咖啡放在木桌上，暖色灯光，简约高级风格。",
      "ga.query": "这周我的GA网站访问量多少？",
      "tracking_quality_audit": "帮我审计一下当前工作区的埋点质量，看看事件ID和时间戳兜底情况。",
    };
    const SKILL_DESCRIPTIONS = {
      "attribution.query": "查询广告归因漏斗与素材投放表现，回答转化、渠道、素材效果等问题。",
      "media.route": "根据文字描述或参考图生成图片/视频，支持文生图、图生图、文生视频、图生视频。",
      "ga.query": "授权你自己的 Google Analytics 账户后，可以直接在对话里问真实网站数据。",
      "tracking_quality_audit": "只读审计当前工作区的真实事件适配统计，按 Token 业务模板返回埋点质量评分、问题列表与整改建议。",
    };
    const REQUIRES_CONNECTOR = { "ga.query": true };

    let gaConnected = false;
    const INTERNAL_KEY = process.env.PT_DASH_INTERNAL_KEY;
    if (INTERNAL_KEY) {
      try {
        const raw = await queryGaConnectorStatus({ internalKey: INTERNAL_KEY, dashPort: DASH_PORT, tenantId: me.tenant.id });
        if (raw.statusCode === 200) {
          try { gaConnected = Boolean(JSON.parse(raw.body || "{}").connected); } catch (e) {}
        }
      } catch (e) {
        log.error("ga_connector_status_failed", { error: e && e.message ? e.message : String(e) });
      }
    }

    const tools = await toolsRegistry.listToolsForWorkspace(context.workspaceId, context);
    const skills = tools.map((t) => {
      const requiresConnector = REQUIRES_CONNECTOR[t.name] || false;
      const skill = {
        id: t.name,
        title: SKILL_TITLES[t.name] || t.name,
        desc: t.description || "",
        description: SKILL_DESCRIPTIONS[t.name] || t.description || "",
        sampleQuestion: SKILL_QUESTIONS[t.name] || "",
        requiresConnector,
      };
      if (requiresConnector) skill.connectorStatus = gaConnected;
      return skill;
    });
    return json(res, 200, { ok: true, skills });
  }

  if (p === "/api/status") {
    const st = { dshHome: DSH_HOME, workspace: WORKSPACE, dashboard: DASH_PORT, skills: 0, dashboardOk: false, dshEntry: DSH.js,
      multiTenant: true, settingsUrl: "/settings" };
    try { st.skills = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch (e) {}
    await new Promise((r) => {
      const q = http.request({ host: "127.0.0.1", port: DASH_PORT, path: "/", timeout: 1500 },
        (s) => { st.dashboardOk = s.statusCode === 200; s.resume(); r(); });
      q.on("error", () => r()); q.on("timeout", () => { q.destroy(); r(); }); q.end();
    });
    return json(res, 200, Object.assign({ ok: true }, st));
  }

  // ---- 停止当前用户正在跑的 DSH ----
  if (p === "/api/chat/stop" && req.method === "POST") {
    const uid = me.user.id;
    const job = runningJobs.get(uid);
    if (!job) return json(res, 200, { ok: true, stopped: false, error: "当前没有正在运行的任务" });
    job.kill(); // 杀掉子进程；杀完由 handleChat 里的 close 事件回报 stopped=true，未完成回答丢弃
    return json(res, 200, { ok: true, stopped: true });
  }

  // ---- 对话列表 / 新建 ----
  if (p === "/api/conversations" && req.method === "GET") {
    const list = await conversations.list(me.user.id);
    return json(res, 200, { ok: true, conversations: list });
  }
  if (p === "/api/conversations" && req.method === "POST") {
    const conv = await conversations.create(me.user.id);
    return json(res, 200, { ok: true, id: conv.id, conversation: conv });
  }

  // ---- ⑦ 搜索（标题 + 消息正文）----
  if (p === "/api/conversations/search" && req.method === "GET") {
    const u = new URL(req.url, "http://127.0.0.1:" + PORT);
    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return json(res, 200, { ok: true, conversations: [] });
    const list = await conversations.search(me.user.id, q);
    return json(res, 200, { ok: true, conversations: list });
  }

  // ---- 单对话：读 / 改标题 / 删除 ----
  const convMatch = p.match(/^\/api\/conversations\/([^\/]+)$/);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]);
    if (req.method === "GET") {
      const conv = await conversations.get(me.user.id, id);
      if (!conv) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });
      return json(res, 200, { ok: true, conversation: conv });
    }
    if (req.method === "PATCH") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      const r = await conversations.rename(me.user.id, id, body.title);
      if (r.notFound) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      return json(res, 200, { ok: true, title: r.title });
    }
    if (req.method === "DELETE") {
      const r = await conversations.remove(me.user.id, id);
      if (r.notFound) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });
      // 常驻架构：同步释放该对话对应的 DSH session（轨迹）
      try { tenantMod.closeDshSession(id); } catch (e) {}
      return json(res, 200, { ok: true });
    }
  }

  // ---- ⑥ 归档 / 恢复；⑧ 导出 ----
  const actionMatch = p.match(/^\/api\/conversations\/([^\/]+)\/(archive|unarchive|export)$/);
  if (actionMatch) {
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    if (action === "archive" || action === "unarchive") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "只支持 POST" });
      const r = await conversations.setArchived(me.user.id, id, action === "archive");
      if (r.notFound) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });
      return json(res, 200, { ok: true, archived: action === "archive" });
    }
    if (action === "export") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "只支持 GET" });
      const conv = await conversations.get(me.user.id, id);
      if (!conv) return json(res, 404, { ok: false, error: "对话不存在或不属于你" });
      const u = new URL(req.url, "http://127.0.0.1:" + PORT);
      const fmt = (u.searchParams.get("fmt") || "md").toLowerCase();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const shortId = String(conv.id).slice(0, 8);
      if (fmt === "json") {
        return exportResponse(res, "conversation-" + shortId + "-" + stamp + ".json", JSON.stringify(conv.messages, null, 2), "application/json; charset=utf-8");
      }
      return exportResponse(res, "conversation-" + shortId + "-" + stamp + ".md", toMarkdown(conv.messages), "text/markdown; charset=utf-8");
    }
  }

  // ---- ⑪ 用户长期记忆 ----
  if (p === "/api/memory") {
    if (req.method === "GET") {
      const items = await memory.list(me.user.id);
      return json(res, 200, { ok: true, memories: items });
    }
    if (req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
      const r = await memory.set(me.user.id, body.key, body.value);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      return json(res, 200, { ok: true, key: r.key, value: r.value });
    }
    if (req.method === "DELETE") {
      const u = new URL(req.url, "http://127.0.0.1:" + PORT);
      const key = u.searchParams.get("key") || "";
      await memory.del(me.user.id, key);
      return json(res, 200, { ok: true });
    }
  }

  // ---- ⑩ 模型列表 / 选择 ----
  if (p === "/api/models" && req.method === "GET") {
    let current = null;
    try { current = await memory.getModel(me.user.id); } catch (e) {}
    const cat = await ensureModelCatalog();
    const fallbackModel = modelCatalog.pickDefaultModel(cat.models, tenantMod.defaultModel());
    // 默认选项改成 AUTO（智能路由）；没选过模型的用户一律落在 AUTO 上
    return json(res, 200, {
      ok: true,
      models: cat.models,
      current: current || modelCatalog.AUTO_ID,
      default: modelCatalog.AUTO_ID,
      auto: modelCatalog.AUTO_ID,
      fallbackModel,
      syncedAt: cat.syncedAt || 0,
      ...(cat.syncError ? { syncError: cat.syncError } : {}),
    });
  }
  if (p === "/api/models/select" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
    const model = String(body.model || "").trim();
    const catSel = await ensureModelCatalog();
    const valid = model === modelCatalog.AUTO_ID || catSel.models.some((m) => m.id === model) || tenantMod.readModels().some((m) => m.id === model);
    if (!valid) return json(res, 400, { ok: false, error: "未知模型" });
    const r = await memory.setModel(me.user.id, model);
    return json(res, 200, { ok: true, model: r.model });
  }

  // ---- ⑨ 上传图片（multipart/form-data，兼容 base64 JSON；按租户目录隔离 + 高熵随机名 + 魔数校验 + 磁盘配额）----
  if (p === "/api/upload" && req.method === "POST") {
    let buf = null;
    if (isMultipart(req)) {
      const mp = await readMultipartUpload(req, (20 << 20) + (1 << 20));
      if (!mp) return json(res, 400, { ok: false, error: "无法解析上传表单" });
      const file = mp.files["image"] || mp.files["file"] || mp.files["data"];
      if (!file || !file.data.length) return json(res, 400, { ok: false, error: "缺少图片数据" });
      buf = file.data;
    } else {
      let body = {};
      try { body = JSON.parse((await readBody(req, 20 << 20)) || "{}"); } catch (e) {}
      const b64 = String(body.image || body.data || "").trim();
      if (!b64) return json(res, 400, { ok: false, error: "缺少图片数据" });
      const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
      let data = b64;
      if (m) { data = m[2]; }
      try { buf = Buffer.from(data, "base64"); } catch (e) { return json(res, 400, { ok: false, error: "图片数据无效" }); }
    }
    if (!buf.length || buf.length > 20 * 1024 * 1024) return json(res, 400, { ok: false, error: "图片太大或无效" });
    // P1-2：按文件魔数校验真实图片类型（拒绝伪装成图片的非图片内容）
    const magicOk = (() => {
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
      if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
      if (buf.length >= 6 && buf.slice(0, 6).toString("ascii").startsWith("GIF8")) return "gif";
      if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
      return null;
    })();
    if (!magicOk) return json(res, 400, { ok: false, error: "不是有效的图片文件" });
    const ext = magicOk;
    const dir = path.join(RUNTIME, "_uploads", me.tenant.id);
    fs.mkdirSync(dir, { recursive: true });
    // P1-2：租户磁盘配额（默认 100MB，可用 PT_UPLOAD_QUOTA_MB 覆盖）
    const quotaBytes = Number(process.env.PT_UPLOAD_QUOTA_MB || 100) * 1024 * 1024;
    let used = 0;
    try { for (const fn of fs.readdirSync(dir)) { try { used += fs.statSync(path.join(dir, fn)).size; } catch (e) {} } } catch (e) {}
    if (used + buf.length > quotaBytes) return json(res, 400, { ok: false, error: "上传空间已满（配额 " + Math.round(quotaBytes / 1048576) + "MB）" });
    const name = crypto.randomBytes(16).toString("hex") + "." + ext; // 128 位高熵随机名
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, buf);
    return json(res, 200, { ok: true, url: "/uploads/" + me.tenant.id + "/" + name, path: abs });
  }
// ---- 产出文件预览：GET /api/artifact?p=<workspace 相对路径> ----
// Agent 在租户 workspace 里生成了 PDF / HTML / md，前端左侧面板靠这个地址把它显示出来。
// 三道门必须都守住：① 登录；② 租户隔离（只能看自己 workspace 里的）；③ 防目录穿越（../ 与软链接）。
if (p === "/api/artifact" && (req.method === "GET" || req.method === "HEAD")) {
  const meArt = await authed(req);
  if (!meArt) return json(res, 401, { ok: false, error: "没登录" });
  const artTenant = meArt.tenant && meArt.tenant.id;
  if (!artTenant) return json(res, 403, { ok: false, error: "无法确定访问租户" });
  const artRel = (new URL(req.url, "http://127.0.0.1:" + PORT).searchParams.get("p") || "").trim();
  if (!artifactsMod.isSafeRel(artRel)) return json(res, 400, { ok: false, error: "路径不合法" });
  if (!artifactsMod.isArtifactName(artRel)) return json(res, 400, { ok: false, error: "该类型不支持预览" });
  const artRoot = path.join(RUNTIME, "workspaces", artTenant);
  const artAbs = path.resolve(artRoot, artRel);
  // realpath 兜底软链接逃逸：解析后的真实路径必须仍落在租户 workspace 里
  let artRootReal = artRoot;
  try { artRootReal = fs.realpathSync(artRoot); } catch (e) { /* workspace 还没建，下面 stat 会 404 */ }
  if (artAbs !== artRootReal && artAbs.indexOf(artRootReal + path.sep) !== 0) {
    return json(res, 403, { ok: false, error: "无权访问该路径" });
  }
  let artSt = null;
  try { artSt = fs.statSync(artAbs); } catch (e) { return json(res, 404, { ok: false, error: "文件不存在" }); }
  if (!artSt || !artSt.isFile()) return json(res, 404, { ok: false, error: "文件不存在" });
  const artHeaders = {
    "Content-Type": artifactsMod.artifactContentType(artRel),
    "Content-Length": artSt.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  // HTML 是 Agent 生成的内容，里面可能有脚本；同源 iframe 里它能读父页面的 storage / cookie。
  // 这里先把脚本能力掐掉（前端 iframe 还会再套一层 sandbox，双保险）。
  if (artifactsMod.artifactKind(artRel) === "html") {
    artHeaders["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
  }
  res.writeHead(200, artHeaders);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(artAbs).pipe(res);
  return;
}


  // ---- 文档上传（multipart/form-data，兼容 base64 JSON；纯文本 v1：只收 .txt/.md/.csv，按内容判纯文本；5MB 上限；复用租户隔离落盘）----
  if (p === "/api/upload-doc" && req.method === "POST") {
    let buf = null;
    let rawName = "";
    if (isMultipart(req)) {
      const mp = await readMultipartUpload(req, DOC_UPLOAD_MAX_BYTES + (1 << 20));
      if (!mp) return json(res, 400, { ok: false, error: "无法解析上传表单" });
      const file = mp.files["file"] || mp.files["data"] || mp.files["doc"];
      if (!file || !file.data.length) return json(res, 400, { ok: false, error: "缺少文档数据" });
      buf = file.data;
      rawName = file.filename || mp.fields["name"] || mp.fields["filename"] || "";
    } else {
      let body = {};
      try { body = JSON.parse((await readBody(req, 16 << 20)) || "{}"); } catch (e) {}
      rawName = String(body.name || body.filename || "").trim();
      const b64 = String(body.data || body.content || "").trim();
      if (!b64) return json(res, 400, { ok: false, error: "缺少文档数据" });
      const dm = b64.match(/^data:[^;]*;base64,(.+)$/);
      const data = dm ? dm[1] : b64;
      try { buf = Buffer.from(data, "base64"); } catch (e) { return json(res, 400, { ok: false, error: "文档数据无效" }); }
    }
    // 扩展名白名单（先粗筛，最终以内容解码为准）
    const ext = path.extname(String(rawName).trim()).slice(1).toLowerCase();
    if (!DOC_EXT_WHITELIST.has(ext)) {
      return json(res, 400, { ok: false, error: "仅支持 .txt / .md / .csv 纯文本文档" });
    }
    if (!buf.length) return json(res, 400, { ok: false, error: "文档数据无效" });
    if (buf.length > DOC_UPLOAD_MAX_BYTES) {
      return json(res, 400, { ok: false, error: "文档过大（单文件上限 " + Math.round(DOC_UPLOAD_MAX_BYTES / 1048576) + "MB）" });
    }
    // 按内容判断是否纯文本（不看扩展名）：UTF-8 严格解码，NUL/非法字节一律拒绝
    const text = decodeTextBuffer(buf);
    if (text == null) return json(res, 400, { ok: false, error: "不是有效的纯文本文件" });
    const dir = path.join(RUNTIME, "_uploads", me.tenant.id);
    fs.mkdirSync(dir, { recursive: true });
    // 复用租户磁盘配额（默认 100MB，可用 PT_UPLOAD_QUOTA_MB 覆盖）
    const quotaBytes = Number(process.env.PT_UPLOAD_QUOTA_MB || 100) * 1024 * 1024;
    let used = 0;
    try { for (const fn of fs.readdirSync(dir)) { try { used += fs.statSync(path.join(dir, fn)).size; } catch (e) {} } } catch (e) {}
    if (used + buf.length > quotaBytes) return json(res, 400, { ok: false, error: "上传空间已满（配额 " + Math.round(quotaBytes / 1048576) + "MB）" });
    const name = crypto.randomBytes(16).toString("hex") + "." + ext; // 128 位高熵随机名
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, buf);
    return json(res, 200, { ok: true, url: "/uploads/" + me.tenant.id + "/" + name, path: abs, name, size: buf.length, chars: text.length });
  }

  // ---- 视频/音频上传（multipart/form-data，兼容 base64 JSON；按魔数校验真实类型；单文件上限 PT_MEDIA_UPLOAD_MB）----
  if (p === "/api/upload-media" && req.method === "POST") {
    let buf = null;
    if (isMultipart(req)) {
      const mp = await readMultipartUpload(req, MEDIA_UPLOAD_MAX_BYTES + (1 << 20));
      if (!mp) return json(res, 400, { ok: false, error: "无法解析上传表单" });
      const file = mp.files["file"] || mp.files["data"] || mp.files["media"];
      if (!file || !file.data.length) return json(res, 400, { ok: false, error: "缺少媒体数据" });
      buf = file.data;
    } else {
      let body = {};
      try { body = JSON.parse((await readBody(req, 80 << 20)) || "{}"); } catch (e) {}
      const b64 = String(body.data || body.content || "").trim();
      if (!b64) return json(res, 400, { ok: false, error: "缺少媒体数据" });
      const dm = b64.match(/^data:[^;]*;base64,(.+)$/);
      const data = dm ? dm[1] : b64;
      try { buf = Buffer.from(data, "base64"); } catch (e) { return json(res, 400, { ok: false, error: "媒体数据无效" }); }
    }
    if (!buf.length) return json(res, 400, { ok: false, error: "媒体数据无效" });
    if (buf.length > MEDIA_UPLOAD_MAX_BYTES) {
      return json(res, 400, { ok: false, error: "媒体过大（单文件上限 " + Math.round(MEDIA_UPLOAD_MAX_BYTES / 1048576) + "MB）" });
    }
    // 按内容魔数校验真实类型（拒绝伪装成视频/音频的其他文件）
    const media = detectMediaType(buf);
    if (!media) return json(res, 400, { ok: false, error: "不是有效的视频/音频文件（支持 mp4/webm/mov/mp3/wav/m4a）" });
    const dir = path.join(RUNTIME, "_uploads", me.tenant.id);
    fs.mkdirSync(dir, { recursive: true });
    // 复用租户磁盘配额（默认 100MB，可用 PT_UPLOAD_QUOTA_MB 覆盖）
    const quotaBytes = Number(process.env.PT_UPLOAD_QUOTA_MB || 100) * 1024 * 1024;
    let used = 0;
    try { for (const fn of fs.readdirSync(dir)) { try { used += fs.statSync(path.join(dir, fn)).size; } catch (e) {} } } catch (e) {}
    if (used + buf.length > quotaBytes) return json(res, 400, { ok: false, error: "上传空间已满（配额 " + Math.round(quotaBytes / 1048576) + "MB）" });
    const name = crypto.randomBytes(16).toString("hex") + "." + media.ext; // 128 位高熵随机名
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, buf);
    return json(res, 200, { ok: true, url: "/uploads/" + me.tenant.id + "/" + name, path: abs, name, size: buf.length, kind: media.kind, ext: media.ext });
  }

  // ---- 面板分享 API（需登录 owner；只读 + 整面板）----
  if (p === "/api/panel/shares" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
    const expiresInHours = body.expiresInHours;
    if (expiresInHours != null && !(Number(expiresInHours) > 0)) {
      return json(res, 400, { ok: false, error: "expiresInHours 必须是正数（小时）" });
    }
    const s2 = await panelShares.create(me.user.id, expiresInHours);
    return json(res, 200, { ok: true, id: s2.id, token: s2.token, url: s2.url, expires_at: s2.expires_at, share: s2 });
  }
  if (p === "/api/panel/shares" && req.method === "GET") {
    const shares = await panelShares.list(me.user.id);
    return json(res, 200, { ok: true, shares });
  }
  const shareVerifyMatch = p.match(/^\/api\/panel\/shares\/([^\/]+)\/verify$/);
  if (shareVerifyMatch && req.method === "GET") {
    const v = await panelShares.verify(decodeURIComponent(shareVerifyMatch[1]));
    return json(res, 200, { ok: true, valid: v.valid, reason: v.reason || null, share: v.share || null });
  }
  const shareDelMatch = p.match(/^\/api\/panel\/shares\/([^\/]+)$/);
  if (shareDelMatch && req.method === "DELETE") {
    const r = await panelShares.revoke(me.user.id, decodeURIComponent(shareDelMatch[1]));
    if (r.notFound) return json(res, 404, { ok: false, error: "分享不存在或不属于你" });
    return json(res, 200, { ok: true, revoked: true });
  }

  // ---- 发消息 / 重新生成 ----
  if (p === "/api/chat" && req.method === "POST") {
    if (!chatLimiter.allow(clientIp(req))) {
      return json(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" });
    }
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}

    const uid = me.user.id;
    // 并发控制：同一用户同一时刻只允许一个生成中的对话（同步 check-and-set，无 await，原子）
    if (runningJobs.has(uid)) {
      return json(res, 409, { ok: false, busy: true, error: "上一个还在跑，请先停止或等它结束" });
    }
    runningJobs.set(uid, null); // claim 占位（还没真正 spawn）
    try {
      return await handleChat(req, res, me, body);
    } finally {
      // handleChat 返回即代表本次运行已结束（成功/停止/失败/提前退出），一律清掉占位，
      // 否则会残留导致该用户永远「上一个还在跑」。
      runningJobs.delete(uid);
    }
  }

  return json(res, 404, { ok: false, error: "没有这个接口：" + p });
}

/** 端口被占就自动往后找一个。 */
function pickPort(start, cb) {
  const s = net.createServer();
  s.once("error", () => pickPort(start + 1, cb));
  s.once("listening", () => s.close(() => cb(start)));
  s.listen(start, LISTEN_HOST);
}

/* ============================================================================
 * 优雅停机：关闭 PGlite（清 postmaster 锁）
 * ========================================================================== */
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown_start", {});
  console.log("[业务壳] 优雅停机：关闭 PGlite…");
  try {
    if (auth && auth.close) await auth.close();
    log.info("shutdown_complete", {});
  } catch (e) {
    log.error("shutdown_db_close_failed", { error: e && e.message ? e.message : String(e) });
    console.error("[业务壳] 关闭 DB 失败：", e && e.message ? e.message : e);
  }
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

/* ============================================================================
 * 保活心跳（任务A）：低频最小请求，保持底层模型连接活跃，防空闲回收导致首字延迟。
 * 走与真实对话完全相同的 DSH 路径，但不经 /api/chat 的 runningJobs 锁。
 * ========================================================================== */
let heartbeatTimer = null;
let heartbeatRunning = false;
function startHeartbeat() {
  if (!HEARTBEAT_ENABLED) {
    console.log("  保活心跳：未开启（PT_HEARTBEAT_ENABLED != 1）");
    return;
  }
  const tick = async () => {
    if (heartbeatRunning) return; // 上一轮还没结束就跳过，避免堆积
    heartbeatRunning = true;
    try {
      // 每次触发时扫一遍「当前仍存活的常驻进程租户」，只给这些活跃租户各发一次心跳，
      // 覆盖所有正在被用的员工，同时不浪费在已回收进程、很久没登录的账号上。
      const targets = tenantMod.activeHeartbeatTargets();
      if (!targets || !targets.length) {
        log.info("heartbeat_idle", { reason: "无活跃常驻租户进程" });
        return;
      }
      for (const t of targets) {
        const tenantId = t.tenantId;
        const userId = t.userId || tenantId;
        try {
          const r = await tenantMod.heartbeat(userId, {
            tenantId,
            decryptApiKey: keys.decryptApiKey,
            prompt: HEARTBEAT_PROMPT,
          });
          if (r && r.ok) log.info("heartbeat_ok", { tenantId, ms: r.ms, usage: r.usage });
          else log.info("heartbeat_skip", { tenantId, error: r && r.error, skipped: r && r.skipped });
        } catch (e) {
          log.info("heartbeat_fail", { tenantId, error: e && e.message ? e.message : String(e) });
        }
      }
    } catch (e) {
      log.info("heartbeat_fail", { error: e && e.message ? e.message : String(e) });
    } finally {
      heartbeatRunning = false;
    }
  };
  // 不立即发首跳：服务刚起时还没有活跃进程，等有真实对话后再按间隔扫活跃租户。
  heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref && heartbeatTimer.unref();
  console.log("  保活心跳：已开启（每 " + Math.round(HEARTBEAT_INTERVAL_MS / 1000) + " 秒扫一次活跃租户，prompt=\"" + HEARTBEAT_PROMPT + "\"）");
}

/* ============================================================================
 * 启动：① initAuth（迁移 + 种默认管理员）→ ② initKeys（主密钥）→ ③ initConversations → ④ 监听
 * ========================================================================== */
async function main() {
  // B6-fix：门禁③ - 检查 DSH 环境是否泄漏 RYZE_MCP_TOKEN
  if (process.env.RYZE_MCP_TOKEN) {
    console.error("\n❌ 启动失败：DSH 环境检测到 RYZE_MCP_TOKEN，违反安全红线（凭证应只存在于后端代理）");
    process.exit(1);
  }

  auth = await initAuth({
    dataDir: DB_DIR,
    migrationsDir: path.join(SHELL, "db-migrations"),
    defaultAdmin: { username: USERNAME, password: PASSWORD },
  });
  
  // B3-fix：为默认管理员创建 workspace
  const defaultAdminTenant = await auth.db.query("SELECT id, tenant_id FROM users WHERE username = $1", [USERNAME]);
  if (defaultAdminTenant.rows.length > 0) {
    const { createWorkspace } = require("./workspace/index.cjs");
    await createWorkspace("ws_" + defaultAdminTenant.rows[0].tenant_id, defaultAdminTenant.rows[0].tenant_id);
    
    // B14：为演示租户（默认管理员）调用内部接口，签发 HMAC 分析 token
    const demoTenantId = defaultAdminTenant.rows[0].tenant_id;
    const { callAnalyticsInternalTokenEndpoint } = require("./auth.cjs");
    await callAnalyticsInternalTokenEndpoint(demoTenantId, "演示租户分析 token");
  }
  keys = await keysMod.initKeys({ db: auth.db, masterKeyFile: MASTER_KEY_FILE });
  conversations = await convMod.initConversations(auth.db);
  memory = await memoryMod.initMemory(auth.db);
  panelShares = await panelSharesMod.initPanelShares(auth.db);

  // 任务A：启动保活心跳（扫描「仍存活的常驻进程租户」，逐个发心跳），防空闲回收导致的首字延迟。
  startHeartbeat();
  
  // B4-fix: 初始化默认角色权限
  const { initializeDefaultRoles, setDb } = require("./permissions/index.cjs");
  // M1：让 checkPermission 复用 auth.db，避免二次开库 / 读到错误库（workspace 隔离前提）
  setDb(auth.db);
  await initializeDefaultRoles();
  
  // M1：工具调用日志（tool_calls 表）+ 注入 registry.executeTool()，执行前后各写一条。
  toolCalls = await toolCallsMod.initToolCalls(auth.db);
  toolsRegistry.setToolCallLogger(toolCalls);
  
  // 业务工具通用加载入口：遍历业务线模块公开导出的工具定义，循环注册 + 绑定真实 executor。
  // 真实数据经内部 HTTP 调业务线只读接口（如 GET /api/attribution/funnel），不 import 内部实现、不新建空数据源。
  const businessTools = loadBusinessTools({
    internalKey: process.env.PT_DASH_INTERNAL_KEY || "",
    dashPort: DASH_PORT,
    log,
  });
  for (const { definition, execute } of businessTools) {
    toolsRegistry.registerTool(Object.assign({}, definition, { execute }));
    log.info("tool_autoloaded", { name: definition.name, type: definition.type });
  }
  
  pruneUploads(); // P1-2：启动清理过期上传
  log.info("init", { stage: "ready", dbDir: DB_DIR, username: USERNAME, rateChatPerMin: RATE_CHAT_PER_MIN, dryRunChat: DRY_RUN_CHAT, dashTenantInject: DASH_TENANT_INJECT, trustProxy: process.env.TRUST_PROXY === "1" });

  pickPort(PORT, (port) => {
    http.createServer((req, res) => {
      const start = Date.now();
      let pathname = "/";
      try { pathname = new URL(req.url, "http://127.0.0.1:" + port).pathname; } catch (e) {}
      const method = req.method || "GET";
      const ip = clientIp(req);

      // P0-3 安全：所有响应禁止把 URL 泄露给第三方（Referrer-Policy）
      res.setHeader("Referrer-Policy", "no-referrer");

      // P1-3 安全：CSP + 防嗅探 + 防点击劫持（脚本/连接/图片仅同源 + data/blob；媒体域名放行 *.volces.com；禁内联脚本）
      // 注：img/media/connect 必须放行火山 TOS 的 *.volces.com，否则 media.route 生成的图/视频会在页面里被 CSP 拦掉（下载按钮的 fetch 同样依赖 connect-src）。
      res.setHeader("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.volces.com; media-src 'self' https://*.volces.com https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev; connect-src 'self' https://*.volces.com https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");

      // P0-4 安全：HTTPS 生产模式对所有响应加 HSTS
      if (COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

      res.on("finish", () => {
        log.info("request", { method, path: pathname, status: res.statusCode, ip, ms: Date.now() - start });
      });

      handle(req, res).catch((e) => {
        log.error("request_error", { method, path: pathname, ip, error: e && e.message ? e.message : String(e) });
        console.error("[业务壳] 出错：", e);
        try { json(res, 500, { ok: false, error: "服务器内部错误" }); } catch (e2) {}
      });
    }).listen(port, LISTEN_HOST, () => {
      log.info("listening", { port, host: LISTEN_HOST, dbDir: DB_DIR, dashboardPort: DASH_PORT, rateChatPerMin: RATE_CHAT_PER_MIN, dashTenantInject: DASH_TENANT_INJECT, trustProxy: process.env.TRUST_PROXY === "1" });

  /* ---- 模型目录：启动后同步一次，之后每 24 小时同步一次（B3）----
   * 失败不影响服务：拉不到就用缓存 / yaml 静态列表，下次定时再试。 */
  const syncOnce = (force) => modelCatalog.getCatalog({
    apiKey: process.env.PT_MODELS_API_KEY || process.env.POWERTOKENS_API_KEY || "",
    fallback: tenantMod.readModels(),
    force: force === true,
  }).then((c) => log.info("model-catalog", {
    fresh: !!c.fresh, count: c.models.length, syncedAt: c.syncedAt, error: c.syncError || null,
  })).catch((e) => log.warn("model-catalog", { error: (e && e.message) || String(e) }));
  setTimeout(() => { syncOnce(false); }, 3000).unref();
  setInterval(() => { syncOnce(true); }, modelCatalog.SYNC_TTL_MS).unref();

      console.log("================================================================");
      console.log("  北极星 · 业务壳（形态 B · 多租户 · 对话窗口化）");
      console.log("================================================================");
      console.log("");
      console.log("  ★ 这就是产品对外的唯一入口（DSH 本身不开端口）");
      console.log("      http://127.0.0.1:" + port + "   （监听 " + LISTEN_HOST + "）");
      console.log("  登录： " + USERNAME + "（密码见启动配置，不在屏幕/日志打印）");
      console.log("");
      console.log("  —— 隔离边界（多租户）——");
      console.log("    DSH_HOME      = " + DSH_HOME);
      console.log("    技能播种源    = " + WORKSPACE);
      console.log("    租户工作区根  = " + tenantMod.WORKSPACES_ROOT + "（每租户一个独立目录）");
      console.log("    看板后端      = 127.0.0.1:" + DASH_PORT + "（藏在 /dashboard 后面）");
      if (DSH.js) {
        console.log("    DSH 入口      = " + DSH.js);
      } else {
        console.log("    DSH 入口      = ★ 没找到，对话会失败！");
      }
      console.log("");
      console.log("  ★ 设置页（存 PT key / BYOK）：http://127.0.0.1:" + port + "/settings");
      console.log("  ★ 探活端点：/healthz（供监控/负载均衡探活）");
      console.log("  ★ 日志：结构化 JSON 行 → " + log.LOG_DIR + "（按天切割，零泄露）");
      console.log("  ★ 身份库已就绪：账号/会话落库（" + DB_DIR + "），重启不丢");
      console.log("  ★ 限流已启用（chat 限流 " + RATE_CHAT_PER_MIN + "/分）");
      console.log("  ★ 并发：同一用户同一时刻只允许一个生成中的对话；不同用户并行");
      console.log("  ★ TRUST_PROXY=" + (process.env.TRUST_PROXY === "1" ? "开" : "关")
        + " · 看板租户透传=" + (DASH_TENANT_INJECT ? "开" : "关（B 方案共享演示数据兜底）"));
      console.log("");
      if (!DSH.js) {
        console.error("================================================================");
        console.error("[DSH 警告] " + dshMissingHint());
        console.error("================================================================");
      }
    });
  });
}

main().catch((e) => {
  log.error("startup_failed", { error: e && e.message ? e.message : String(e) });
  console.error("[业务壳] 启动失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
