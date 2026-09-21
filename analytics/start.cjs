/**
 * 北极星 · 看板后端一键启动（打包发布版）
 * ============================================================================
 *   node start.cjs
 *
 * 本文件 = start-x-v4.cjs（看板多租户 A 方案 + P1 跨租户泄漏修复），打包时：
 *   1. 编译产物目录   .dist-x-v4 → backend（self-contained，与迁移 SQL 同目录）
 *   2. 数据目录       .pgdata-x-v4 → .pgdata（可用 PT_DASH_DATA_DIR 覆盖，自测用临时目录）
 *   3. 迁移脚本目录   交付版外 ../backend/db → 本目录 backend/db
 *   4. 锁文件前缀     .deliveryv4- → .delivery-（去除版本号）
 *   5. 只读 token    可用 PT_DASH_TOKEN 覆盖（与业务壳的 DASH_TOKEN 保持一致）
 *
 * ★ A 方案怎么用（配合业务壳 server.cjs 的 PT_DASH_TENANT_INJECT=1）：
 *     本进程设  TRUST_TENANT_HEADER=1
 *     业务壳设  PT_DASH_TENANT_INJECT=1
 *   业务壳把「已登录用户 tenant_id」以 X-Tenant-Id 头透传过来，本服务据此
 *   set_config('app.current_tenant_id') 走 RLS 隔离。
 *
 *   【诚实边界】交付版种子数据只有一个演示租户（11111111-…）。业务壳的租户 UUID
 *   在本库里没有任何数据 → 非演示租户会看到「空数据」；这是 RLS 正确隔离的结果，
 *   不是造假。数据侧（按业务壳租户灌事件/ad_* 数据）待接入。
 *
 *   【信任边界】TRUST_TENANT_HEADER=1 仅当本服务只被可信业务壳（同机 127.0.0.1）
 *   反代访问时开启；若本服务可能被外部直连，保持默认关闭（租户只从 token 派生）。
 * ============================================================================
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const { createPgCompatPool } = require("./lib/db.cjs");
const deps = require("./lib/deps.cjs");
const { seed } = require("./lib/seed.cjs");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const OPT = {
  port: Number(getArg("--port", process.env.PT_DASH_PORT || 8095)),
  reseed: argv.includes("--reseed"),
  noSeed: argv.includes("--no-seed"),
  quiet: argv.includes("--quiet"),
};

const ROOT = __dirname;
const DATA_DIR = process.env.PT_DASH_DATA_DIR || path.join(ROOT, ".pgdata");
const MIGRATIONS = path.join(ROOT, "backend", "db");
const FRONTEND = path.join(ROOT, "frontend");
const DIST = path.join(ROOT, "backend");                 // 编译产物目录
const URL_FILE = path.join(ROOT, ".delivery-url.txt");

// P0-2 安全：token/secret 不再内置默认值，必须从环境变量显式提供，缺失拒绝启动。
const RO_TOKEN = process.env.PT_DASH_TOKEN || null;
const WEBHOOK_ID = process.env.PT_DASH_WEBHOOK_ID || "wh_powertokens_001";
const WEBHOOK_SECRET = process.env.PT_DASH_WEBHOOK_SECRET || null;
const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "ws_powertokens_main";

const TRUST_TENANT_HEADER = process.env.TRUST_TENANT_HEADER === "1";

const log = (...a) => {
  if (!OPT.quiet) console.log(...a);
};

// ---------------------------------------------------------------------------
// 单实例：只创建一个属于自己 PID 的锁文件；启动时把旧 PID 干掉
// （沙箱不允许覆盖既有文件，所以锁文件名带 PID）
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存在性，不真的发信号
    return true;
  } catch {
    return false;
  }
}

async function reapStaleInstances() {
  const victims = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (!/^\.delivery-(\d+)\.lock$/.test(f)) continue;
    const pid = Number(f.match(/^\.delivery-(\d+)\.lock$/)[1]);
    if (pid === process.pid) continue;
    victims.push(pid);
  }
  if (victims.length === 0) return;

  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已经不在了 */
    }
  }

  const deadline = Date.now() + 10000;
  let remaining = victims.filter(pidAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    remaining = remaining.filter(pidAlive);
  }
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (remaining.length > 0) await new Promise((r) => setTimeout(r, 800));

  for (const f of fs.readdirSync(ROOT)) {
    if (/^\.delivery-\d+\.lock$/.test(f)) {
      try {
        fs.unlinkSync(path.join(ROOT, f));
      } catch {
        /* ignore */
      }
    }
  }
  log(`  已清理 ${victims.length} 个残留实例（已确认退出）`);
}
function writeLock() {
  fs.writeFileSync(path.join(ROOT, `.delivery-${process.pid}.lock`), String(Date.now()), "utf8");
}
function clearLock() {
  try {
    fs.unlinkSync(path.join(ROOT, `.delivery-${process.pid}.lock`));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 静态文件服务（不引第三方包，自己写）
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function serveStatic(request, reply) {
  let rel = decodeURIComponent(request.url.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";

  const full = path.resolve(FRONTEND, "." + rel);
  if (!full.startsWith(FRONTEND + path.sep) && full !== FRONTEND) {
    return reply.code(403).send("forbidden");
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return reply.code(404).type("text/plain; charset=utf-8").send("not found: " + rel);
  }
  const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  return reply.type(type).send(fs.readFileSync(full));
}

// ---------------------------------------------------------------------------
// 端口探测
// ---------------------------------------------------------------------------
function isFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 40; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`从 ${start} 起 40 个端口都被占用`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let pool = null;
let wiring = null;
let started = null;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   PowerTokens 归因面板 · 北极星（打包发布版）                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  TRUST_TENANT_HEADER = " + (TRUST_TENANT_HEADER ? "开（可信租户头优先）" : "关（租户只从 token 派生，B 方案）"));
  console.log("  数据目录 = " + DATA_DIR);
  console.log("");

  await reapStaleInstances();
  writeLock();
  // ---- 0. 前置检查 ----
  console.log("[0/6] 前置检查");
  if (!fs.existsSync(DIST)) {
    console.error("  ❌ 缺少编译产物 " + path.basename(DIST) + "/ —— 请确认已复制 .dist-x-v4 到 backend/");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(FRONTEND, "index.html"))) {
    console.error("  ❌ 缺少前端 —— 请确认 frontend/ 目录完整");
    process.exit(1);
  }
  for (const f of ["001_init.sql", "002_attribution_index.sql"]) {
    if (!fs.existsSync(path.join(MIGRATIONS, f))) {
      console.error(`  ❌ 缺少迁移脚本 ${f}（应在 ${MIGRATIONS}）`);
      process.exit(1);
    }
  }
  console.log("  ✅ 编译产物 / 前端 / 迁移脚本 齐备");

  // ---- 0.5 密钥检查（P0-2：缺失拒绝启动，不再内置默认 token/secret）----
  if (!RO_TOKEN || !WEBHOOK_SECRET) {
    console.error("\n❌ 缺少密钥，拒绝启动。");
    console.error("   源码不再内置任何默认 token/secret，请通过环境变量显式提供：");
    console.error("     PT_DASH_TOKEN          = 看板只读 token（与业务壳 DASH_TOKEN 保持一致）");
    console.error("     PT_DASH_WEBHOOK_SECRET = 打点 webhook 签名密钥（随机长串）");
    process.exit(1);
  }

  // ---- 1. 数据库 ----
  console.log("\n[1/6] 启动数据库（真 PostgreSQL · PGlite）");
  if (OPT.reseed && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log("  --reseed：已清空原数据库");
  }
  const t0 = Date.now();
  pool = await openDatabase(DATA_DIR);
  console.log(`  ✅ 数据库就绪（${Date.now() - t0}ms）`);

  async function openDatabase(dir) {
    try {
      return await createPgCompatPool({
        dataDir: dir,
        migrationsDir: MIGRATIONS,
        recoverStalePidFile: true,
        log: (m) => log(m),
      });
    } catch (e) {
      const isLock = e && e.code === "STALE_LOCK_NOT_REMOVABLE";
      if (!isLock || dir !== DATA_DIR) throw e;
      const alt = DATA_DIR + "-recovered";
      console.log("");
      console.log("  ⚠️ 上次不是正常退出，数据库目录里留了锁，而当前环境不允许自动清除它。");
      console.log("     已自动改用新目录继续启动，功能完全一样（只是重新灌一次样例数据）。");
      console.log(`     旧数据仍在：${DATA_DIR}`);
      console.log("     想彻底清干净，退出后执行： Remove-Item .pgdata, .pgdata-recovered -Recurse -Force");
      console.log("");
      if (fs.existsSync(alt)) {
        try {
          fs.rmSync(alt, { recursive: true, force: true });
        } catch {
          /* 清不掉就复用，下面重试逻辑会处理 */
        }
      }
      return await createPgCompatPool({
        dataDir: alt,
        migrationsDir: MIGRATIONS,
        recoverStalePidFile: true,
        log: (m) => log(m),
      });
    }
  }

  // ---- 2. 安全自检 ----
  console.log("\n[2/6] 安全自检（不通过就拒绝启动）");
  const sc = await pool.query("SELECT * FROM pt_security_selfcheck()");
  for (const r of sc.rows) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.item}`);
  }
  const failed = sc.rows.filter((r) => r.ok !== true);
  if (failed.length > 0) {
    console.error("\n❌ 安全自检未通过，拒绝启动。");
    process.exit(1);
  }

  // ---- 3. 种子数据 ----
  console.log("\n[3/6] 准备数据");
  const cnt = await pool.query("SELECT count(*)::int AS n FROM pt_events");
  const existing = cnt.rows[0].n;
  if (OPT.noSeed) {
    console.log(`  已有 ${existing} 条事件（--no-seed，跳过灌数据）`);
  } else if (existing > 0) {
    console.log(`  已有 ${existing} 条事件，跳过灌数据（要重灌请加 --reseed）`);
  } else {
    const t1 = Date.now();
    await seed(pool, { log: (m) => log(m), scale: 1, days: 30, readToken: RO_TOKEN });
    console.log(`  ✅ 灌数据完成（${Date.now() - t1}ms）`);
  }

  // ---- 3.5 演示租户 → 工作区映射 幂等兜底 ----
  await pool.query(
    `INSERT INTO tenant_workspaces (tenant_id, workspace_id, label)
     VALUES ($1::uuid,$2,$3) ON CONFLICT (tenant_id) DO NOTHING`,
    [TENANT_ID, WORKSPACE_ID, "PowerTokens 主工作区"]
  );

  // ---- 4. 打点落库 worker ----
  console.log("\n[4/6] 启动打点落库 worker（webhook → 队列 → 真写库）");
  const ingestMod = require(path.join(DIST, "collect", "ingest.js"));
  wiring = deps.createCollectWiring(pool, ingestMod, (m) => log(m));
  console.log("  ✅ worker 已就绪");

  // ---- 5. Web 服务 ----
  console.log("\n[5/6] 启动 Web 服务");
  const { buildUnifiedServer } = require(path.join(DIST, "server.js"));

  const poolAdapter = {
    connect: pool.connect.bind(pool),
    query: pool.query.bind(pool),
  };

  const app = buildUnifiedServer({
    pool: poolAdapter,
    resolveEndpoint: deps.createEndpointResolver(pool),
    enqueue: wiring.enqueue,
    verifyAnalyticsToken: deps.createTokenVerifier(pool),
    loadAuditLogs: deps.createAuditLogLoader(pool),
    loadConfigFindings: deps.createConfigFindingsLoader(pool),
    resolveWorkspaceId: deps.createWorkspaceResolver(pool),
    now: () => Date.now(),
    logger: false,
  });

  // 前端静态资源（放最后注册，API 路由优先匹配）
  app.get("/*", serveStatic);

  // P0-5：不再自动换端口，端口被占直接失败（避免与业务壳固定端口不一致 → 「看板离线」）。
  const port = OPT.port;
  if (!(await isFree(port))) {
    console.error(`\n❌ 端口 ${port} 已被占用，拒绝启动（P0-5：不自动换端口）。`);
    process.exit(1);
  }
  await app.listen({ port, host: "127.0.0.1" });
  // P0-3：token 不再拼进 URL（避免进浏览器历史/代理日志/Referer）
  const url = `http://127.0.0.1:${port}/`;
  started = app;

  // ---- 6. 就绪自检 ----
  console.log("\n[6/6] 就绪自检（打自己的接口）");
  const base = `http://127.0.0.1:${port}`;
  const checks = [
    ["前端首页", `${base}/`, 200],
    ["前端骨架 app.js", `${base}/app.js`, 200],
    ["Tab 脚本 overview.js", `${base}/tabs/overview.js`, 200],
    ["归因漏斗 API（缺省时间窗）", `${base}/api/analytics/funnel?granularity=total`, 200],
    ["审计 API", `${base}/api/analytics/audit/token`, 200],
  ];
  let selfCheckFailed = 0;
  for (const [name, u, want] of checks) {
    const code = await httpStatus(u, RO_TOKEN);
    if (code !== want) selfCheckFailed += 1;
    console.log(`  ${code === want ? "✅" : "❌"} ${name}：HTTP ${code}`);
  }
  const negatives = [
    ["不带 token 查漏斗", `${base}/api/analytics/funnel?granularity=total`, null, [401, 403]],
    ["token 错误", `${base}/api/analytics/funnel?granularity=total`, "pt_ro_wrong_token", [401, 403]],
    ["参数非法（from 传空串）", `${base}/api/analytics/funnel?from=&to=&granularity=total`, RO_TOKEN, [400]],
  ];
  for (const [name, u, tk, wantAny] of negatives) {
    const code = await httpStatus(u, tk);
    const ok = wantAny.includes(code);
    if (!ok) selfCheckFailed += 1;
    console.log(`  ${ok ? "✅" : "❌"} ${name} 应被拒 → HTTP ${code}`);
  }
  if (selfCheckFailed > 0) {
    console.log(`\n  ⚠️ 有 ${selfCheckFailed} 项自检未通过 —— 服务已起来，但请把上面的 ❌ 报给开发。`);
  }

  // ---- 打印给人看的地址 ----
  let urlFileWritten = URL_FILE;
  try {
    fs.writeFileSync(URL_FILE, url, "utf8");
  } catch {
    urlFileWritten = null;
    try {
      const alt = path.join(ROOT, `.delivery-url-${process.pid}.txt`);
      fs.writeFileSync(alt, url, "utf8");
      urlFileWritten = alt;
    } catch {
      urlFileWritten = null;
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ✅ 已启动 —— 在浏览器打开下面这个网址即可                      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("   " + url);
  console.log("");
  console.log("   只读 token（sha256 前 8 位）：" + crypto.createHash("sha256").update(RO_TOKEN).digest("hex").slice(0, 8) + "（不打印完整值）");
  console.log("   租户：" + TENANT_ID);
  console.log("   工作区：" + WORKSPACE_ID);
  console.log("   TRUST_TENANT_HEADER：" + (TRUST_TENANT_HEADER ? "开" : "关"));
  console.log("");
  console.log("   打点接入地址（POST）：");
  console.log(`     http://127.0.0.1:${port}/api/v1/collect/${WEBHOOK_ID}`);
  console.log("     Header: x-pt-webhook-secret: " + crypto.createHash("sha256").update(WEBHOOK_SECRET).digest("hex").slice(0, 8) + "（sha256 前 8 位，不打印完整值）");
  console.log("");
  console.log("   地址也写到了：" + (urlFileWritten ? path.basename(urlFileWritten) : "（本环境不允许写文件，看上面这行即可）"));
  console.log("   按 Ctrl+C 停止（正常退出，下次启动不需要重建数据库）。");
  console.log("");

  const shutdown = async (sig) => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    try {
      if (wiring) await wiring.stop();
      if (started) await started.close();
      if (pool) await pool.end();
    } catch (e) {
      console.error("关闭时出错：" + e.message);
    }
    clearLock();
    console.log("已停止。");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", clearLock);
}

/** 带可选 Bearer token 的 HTTP 状态码探测 */
function httpStatus(url, token) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: token ? { Authorization: "Bearer " + token } : {} }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve(-1);
    });
  });
}

main().catch(async (e) => {
  console.error("\n❌ 启动失败：" + (e && e.message ? e.message : e));
  if (e && e.stack && !OPT.quiet) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  try {
    if (wiring) await wiring.stop();
    if (started) await started.close();
    if (pool) await pool.end();
  } catch {
    /* ignore */
  }
  clearLock();
  process.exit(1);
});
