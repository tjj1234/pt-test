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

// ---- 模块接线（全部最终名；conversations / tenant 为对话窗口化后的新版）----
const { initAuth } = require("./auth.cjs");
const { handleAuthRoutes, sessionFromCookie } = require("./auth-routes.cjs");
const keysMod = require("./keys.cjs");
const { handleKeyRoutes } = require("./key-routes.cjs");
const tenantMod = require("./tenant.cjs");
const convMod = require("./conversations.cjs");
const memoryMod = require("./memory.cjs");
const panelSharesMod = require("./panel-share.cjs");
const { createRateLimiter, clientIp } = require("./ratelimit.cjs");

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
const DASH_TOKEN = arg("--dashboard-token", process.env.PT_DASH_TOKEN || "pt_ro_delivery_9f3c21");
const PASSWORD = arg("--password", process.env.PT_SHELL_PASSWORD || "northstar");
const USERNAME = arg("--user", process.env.PT_SHELL_USER || "admin");
const DSH_TIMEOUT_MS = Number(arg("--timeout", 300000));

// ---- 监听地址（默认 127.0.0.1，容器/反代部署用 0.0.0.0）----
const LISTEN_HOST = process.env.PT_LISTEN_HOST || "127.0.0.1";

// 身份库 / master key 落点（可用环境变量覆盖，便于自测用临时目录）
const DB_DIR = process.env.PT_DB_DIR || path.join(REPO_ROOT, "db");
const MASTER_KEY_FILE = process.env.PT_MASTER_KEY_FILE || path.join(REPO_ROOT, "secrets", "master.key");

// ---- 登记「绝不允许写进日志」的明文串（密码 / 看板只读 token）----
log.addSecret(PASSWORD, DASH_TOKEN);

// 自测开关：PT_CHAT_DRYRUN=1 时 /api/chat 不 spawn DSH
const DRY_RUN_CHAT = process.env.PT_CHAT_DRYRUN === "1";

// ---- /api/chat 限流（按 IP，默认 20/分；可用 PT_RATE_CHAT_PER_MIN 覆盖）----
const RATE_CHAT_PER_MIN = Number(process.env.PT_RATE_CHAT_PER_MIN || 20);
const chatLimiter = createRateLimiter({ windowMs: 60000, max: RATE_CHAT_PER_MIN });

let auth = null;                 // 身份库句柄
let keys = null;                 // key 加密句柄
let conversations = null;        // 对话窗口化落库句柄
let memory = null;               // 用户长期记忆 / 所选模型
let panelShares = null;          // 面板分享落库句柄

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

/** 从 /uploads/<file> URL 反推本地绝对路径（供 DSH 任务文本引用）。 */
function uploadsAbsPath(url) {
  const m = String(url || "").match(/\/uploads\/([^\/?#]+)/);
  return m ? path.join(RUNTIME, "_uploads", m[1]) : String(url || "");
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

  let messages = Array.isArray(conv.messages) ? conv.messages : [];
  let question = msgRaw;

  // ⑩ 当前所选模型（默认 deepseek-v4-pro）
  let selectedModel = null;
  try { selectedModel = (memory && (await memory.getModel(uid))) || tenantMod.defaultModel(); }
  catch (e) { selectedModel = tenantMod.defaultModel(); }

  // ⑨ 发消息附带的图片（URL 或本地路径）落到消息里
  const image = String(body.image || "").trim() || null;

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
  // ⑨ 图片路径说明（多模态：告知 DSH 图片已上传到本地路径）
  const lastUser = messages[messages.length - 1];
  let imageNote = "";
  if (lastUser && lastUser.image) {
    const imgAbs = uploadsAbsPath(lastUser.image);
    imageNote = "用户这次附带了一张图片，已上传到本地路径：" + imgAbs + "（如你有读取文件 / 识别图片的能力请读取它；否则请据路径说明你暂无法直接看图）";
  }

  // ===== 流式（SSE）：先切响应头，后续增量用 sse() 逐段下发 =====
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const sse = (obj) => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} };

  // ⑤ 分岔 / 重新生成：重置该对话的 DSH session（丢弃旧轨迹），下一问冷启动、只重放截断后的历史
  if (hasBranch || regenerate) {
    try { tenantMod.closeDshSession(conversationId); } catch (e) { /* 忽略 */ }
  }

  const r = await tenantMod.runDshForUser(uid, question, {
    tenantId: me.tenant.id,
    conversationId,
    history: histText,
    memory: memText,
    imageNote,
    decryptApiKey: keys.decryptApiKey,
    dryRun: DRY_RUN_CHAT,
    model: selectedModel,
    onSpawn: (job) => { runningJobs.set(uid, job); },
    onDelta: (delta) => { sse({ delta }); },
    onStep: (step) => { sse({ step }); },
  });

  // 兜底：runDshForUser 内部因 key 来源缺失 / 无 key 失败
  if (!r.ok && (r.code === tenantMod.NO_API_KEY_CODE || r.code === tenantMod.NO_KEY_SOURCE_CODE)) {
    sse({ done: true, ok: false, needKey: true, error: r.error, messages });
    return res.end();
  }

  // 停止：问题已保存，没跑完的回答丢弃不保存
  if (r.stopped) {
    const cur = await conversations.get(uid, conversationId);
    sse({ done: true, ok: false, stopped: true, error: "已停止", messages: cur ? cur.messages : messages });
    return res.end();
  }

  if (!r.ok) {
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
  const saved = messages.concat([{ role: "assistant", text: reply || (r.ok ? "（DSH 没有输出）" : ""), ts: new Date().toISOString(), steps }]);
  await conversations.saveMessages(uid, conversationId, saved);

  sse({
    done: true,
    ok: true,
    reply: reply || "（DSH 没有输出）",
    messages: saved,
    steps,
    ms: r.ms || 0,
    turns: saved.filter((m) => m.role === "assistant").length,
    ...(DRY_RUN_CHAT ? { dryRun: true, tenantId: r.tenantId, workspace: r.cwd, userId: r.userId, keySha256: r.keySha256 } : {}),
  });
  return res.end();
}

/** 反向代理：把看板藏到业务壳后面。 */
function proxyDashboard(req, res, tenantId) {
  const sub = req.url.replace(/^\/dashboard/, "") || "/";
  const target = (sub === "/" || sub === "") ? "/?pt_ro_token=" + encodeURIComponent(DASH_TOKEN) : sub;
  const p = http.request({ host: "127.0.0.1", port: DASH_PORT, path: target, method: req.method,
    headers: dashProxyHeaders(req, tenantId) },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  p.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>看板服务没起来</h2><p>请先启动北极星后端（默认 127.0.0.1:" + DASH_PORT + "）。</p><pre>" + e.message + "</pre>");
  });
  req.pipe(p);
}
/** 写分享会话 cookie（HttpOnly，供 /api/analytics 匿名只读回退识别）。 */
function setShareCookie(res, token) {
  res.setHeader("Set-Cookie", "pt_share=" + encodeURIComponent(token) + "; HttpOnly; SameSite=Lax; Path=/");
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
  const target = (sub === "/" || sub === "") ? "/?pt_ro_token=" + encodeURIComponent(DASH_TOKEN) : sub;
  const p = http.request({ host: "127.0.0.1", port: DASH_PORT, path: target, method: req.method,
    headers: dashProxyHeaders(req, null) },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  p.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>看板服务没起来</h2><p>请先启动北极星后端（默认 127.0.0.1:" + DASH_PORT + "）。</p><pre>" + e.message + "</pre>");
  });
  req.pipe(p);
}

function serveFile(res, f) {
  if (!fs.existsSync(f)) { res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<h2>404</h2>"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(f));
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
  if (p === "/" || p === "/index.html") {
    if (!(await authed(req))) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    return serveFile(res, path.join(PUBLIC, "index.html"));
  }
  if (p.indexOf("/assets/") === 0) {
    const f = path.join(PUBLIC, p.slice("/assets/".length));
    if (f.indexOf(PUBLIC) !== 0) return json(res, 403, { ok: false, error: "非法路径" });
    return serveFile(res, f);
  }
  // ---- ⑨ 上传图片静态服务（随机文件名，无需鉴权，供 <img> 引用）----
  if (p.indexOf("/uploads/") === 0) {
    const rel = decodeURIComponent(p.slice("/uploads/".length));
    if (!rel || rel.indexOf("..") >= 0 || rel.indexOf("\\") >= 0 || rel.indexOf("/") >= 0) {
      return json(res, 403, { ok: false, error: "非法路径" });
    }
    const f = path.join(RUNTIME, "_uploads", rel);
    if (!fs.existsSync(f)) { res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<h2>404</h2>"); }
    const ct = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" })[path.extname(f).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=86400" });
    return res.end(fs.readFileSync(f));
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
  if (p.indexOf("/api/analytics/") === 0) {
    const meAnalytics = await authed(req);
    let shareOk = false;
    const shareTok = cookie(req, "pt_share");
    if (shareTok) { const sv = await panelShares.check(shareTok); shareOk = !!(sv && sv.valid); }
    if (!meAnalytics && !shareOk) return json(res, 401, { ok: false, error: "没登录" });
    const tenantId = meAnalytics && meAnalytics.tenant ? meAnalytics.tenant.id : null;
    const up = http.request({ host: "127.0.0.1", port: DASH_PORT, path: req.url, method: req.method,
      headers: Object.assign(dashProxyHeaders(req, tenantId),
        { authorization: "Bearer " + DASH_TOKEN }) },
      (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    up.on("error", (e) => json(res, 502, { ok: false, error: "dashboard unreachable: " + e.message }));
    return req.pipe(up);
  }

  const me = await authed(req);
  if (!me) return json(res, 401, { ok: false, error: "没登录" });

  if (p === "/api/skills") {
    const list = [];
    try {
      for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        let title = d.name, desc = "";
        const md = path.join(SKILLS, d.name, "SKILL.md");
        if (fs.existsSync(md)) {
          const txt = fs.readFileSync(md, "utf8").slice(0, 2000);
          const h = txt.match(/^#\s+(.+)$/m);
          if (h) title = h[1].trim();
          const para = txt.split(/\n\s*\n/).map((s) => s.trim())
            .find((s) => s && s[0] !== "#" && s.indexOf("---") !== 0 && s[0] !== ">");
          if (para) desc = para.replace(/\s+/g, " ").slice(0, 170);
        }
        list.push({ id: d.name, title, desc });
      }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    return json(res, 200, { ok: true, skills: list });
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
    return json(res, 200, { ok: true, models: tenantMod.readModels(), current: current || tenantMod.defaultModel(), default: tenantMod.defaultModel() });
  }
  if (p === "/api/models/select" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
    const model = String(body.model || "").trim();
    const valid = tenantMod.readModels().some((m) => m.id === model);
    if (!valid) return json(res, 400, { ok: false, error: "未知模型" });
    const r = await memory.setModel(me.user.id, model);
    return json(res, 200, { ok: true, model: r.model });
  }

  // ---- ⑨ 上传图片（base64 JSON，落到 runtime/_uploads/）----
  if (p === "/api/upload" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readBody(req, 20 << 20)) || "{}"); } catch (e) {}
    const b64 = String(body.image || body.data || "").trim();
    if (!b64) return json(res, 400, { ok: false, error: "缺少图片数据" });
    const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
    let ext = "png", data = b64;
    if (m) { ext = m[1] === "jpeg" ? "jpg" : m[1]; data = m[2]; }
    let buf;
    try { buf = Buffer.from(data, "base64"); } catch (e) { return json(res, 400, { ok: false, error: "图片数据无效" }); }
    if (!buf.length || buf.length > 20 * 1024 * 1024) return json(res, 400, { ok: false, error: "图片太大或无效" });
    const dir = path.join(RUNTIME, "_uploads");
    fs.mkdirSync(dir, { recursive: true });
    const name = "u-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex") + "." + ext;
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, buf);
    return json(res, 200, { ok: true, url: "/uploads/" + name, path: abs });
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
 * 启动：① initAuth（迁移 + 种默认管理员）→ ② initKeys（主密钥）→ ③ initConversations → ④ 监听
 * ========================================================================== */
async function main() {
  auth = await initAuth({
    dataDir: DB_DIR,
    migrationsDir: path.join(SHELL, "db-migrations"),
    defaultAdmin: { username: USERNAME, password: PASSWORD },
  });
  keys = await keysMod.initKeys({ db: auth.db, masterKeyFile: MASTER_KEY_FILE });
  conversations = await convMod.initConversations(auth.db);
  memory = await memoryMod.initMemory(auth.db);
  panelShares = await panelSharesMod.initPanelShares(auth.db);
  log.info("init", { stage: "ready", dbDir: DB_DIR, username: USERNAME, rateChatPerMin: RATE_CHAT_PER_MIN, dryRunChat: DRY_RUN_CHAT, dashTenantInject: DASH_TENANT_INJECT, trustProxy: process.env.TRUST_PROXY === "1" });

  pickPort(PORT, (port) => {
    http.createServer((req, res) => {
      const start = Date.now();
      let pathname = "/";
      try { pathname = new URL(req.url, "http://127.0.0.1:" + port).pathname; } catch (e) {}
      const method = req.method || "GET";
      const ip = clientIp(req);

      res.on("finish", () => {
        log.info("request", { method, path: pathname, status: res.statusCode, ip, ms: Date.now() - start });
      });

      handle(req, res).catch((e) => {
        log.error("request_error", { method, path: pathname, ip, error: e && e.message ? e.message : String(e) });
        console.error("[业务壳] 出错：", e);
        try { json(res, 500, { ok: false, error: e.message }); } catch (e2) {}
      });
    }).listen(port, LISTEN_HOST, () => {
      log.info("listening", { port, host: LISTEN_HOST, dbDir: DB_DIR, dashboardPort: DASH_PORT, rateChatPerMin: RATE_CHAT_PER_MIN, dashTenantInject: DASH_TENANT_INJECT, trustProxy: process.env.TRUST_PROXY === "1" });
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
