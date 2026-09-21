"use strict";
/**
 * 本地真实测试 v12：shell/ 复制到临时目录 + 覆盖 conv/ 的 v12 新文件，起真实 DSH 服务。
 * 用法：node run-local-v12.cjs          （真实模式，需 DSH_JS）
 *       DRYRUN=1 node run-local-v12.cjs （假回复，只测界面/接口）
 * v12 变化（相对 v11）：DSH 调用层迁到【常驻 agent 架构】——
 *   server-v5（历史交给 DSH session）+ tenant-v7（每租户常驻进程）+ persistent-runner.mjs（常驻插件）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CONV_DIR = __dirname;
const SHELL_DIR = path.resolve(CONV_DIR, "..", "shell");
const PGLITE_ENTRY = path.join(SHELL_DIR, "node_modules", "@electric-sql", "pglite", "dist", "index.cjs");
const TMP = path.resolve(CONV_DIR, "..", "local-test-runtime-v12");
const tmpShell = path.join(TMP, "shell");
const PORT = process.env.PORT || "8099";
const DSH_JS = process.env.DSH_JS || "";
const DRYRUN = process.env.DRYRUN || "0";

if (!fs.existsSync(PGLITE_ENTRY)) { console.error("找不到 PGlite 入口：" + PGLITE_ENTRY); process.exit(2); }
if (DRYRUN !== "1" && !fs.existsSync(DSH_JS)) { console.error("找不到 DSH_JS：" + DSH_JS); process.exit(2); }

// 1. 复制 shell -> tmpShell（排除 node_modules）
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(tmpShell, { recursive: true });
for (const name of fs.readdirSync(SHELL_DIR)) {
  if (name === "node_modules") continue;
  fs.cpSync(path.join(SHELL_DIR, name), path.join(tmpShell, name), { recursive: true });
}
// 2. 覆盖 conv v12 文件
const c2 = (src, dst) => fs.copyFileSync(path.join(CONV_DIR, src), path.join(tmpShell, dst));
c2("server-v5.cjs", "server.cjs");
c2("conversations-v2.cjs", "conversations.cjs");
c2("memory.cjs", "memory.cjs");
c2("tenant-v7.cjs", "tenant.cjs");
c2("persistent-runner.mjs", "persistent-runner.mjs");
c2("panel-share.cjs", "panel-share.cjs");
c2("dsh-settings.yaml", "dsh-settings.yaml");
c2("app-v7.js", path.join("public", "app.js"));
c2("index-v4.html", path.join("public", "index.html"));
c2("key-drawer-v3.js", path.join("public", "key-drawer.js"));
c2("register-v3.js", path.join("public", "register.js"));
c2("login-v2.html", path.join("public", "login.html"));
c2("styles-v4.css", path.join("public", "styles.css"));
c2("004_conversations_v2.sql", path.join("db-migrations", "004_conversations_v2.sql"));
c2("005_archive_memory.sql", path.join("db-migrations", "005_archive_memory.sql"));
c2("006_panel_shares.sql", path.join("db-migrations", "006_panel_shares.sql"));

// db-pg.cjs 也要进运行时：db.cjs 从 ../conv/db-pg.cjs 加载它（真实 PG 切换用）
fs.mkdirSync(path.join(TMP, "conv"), { recursive: true });
fs.copyFileSync(path.join(CONV_DIR, "db-pg.cjs"), path.join(TMP, "conv", "db-pg.cjs"));

// 3. master key（本地测试用）
const masterKeyFile = path.join(TMP, "secrets", "master.key");
fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true });
fs.writeFileSync(masterKeyFile, JSON.stringify({ scheme: "raw-0600", key: crypto.randomBytes(32).toString("base64"), created_at: new Date().toISOString() }), "utf8");

// 4. 环境 + 起服务
const env = Object.assign({}, process.env, {
  PT_DB_DIR: path.join(TMP, "pgdata"),
  PT_MASTER_KEY_FILE: masterKeyFile,
  PT_LOG_DIR: path.join(TMP, "logs"),
  PT_PGLITE_PATH: PGLITE_ENTRY,
  PT_LISTEN_HOST: "127.0.0.1",
  PT_BF_MAX_FAILURES: "50",
  PT_BF_LOCK_MS: "30000",
  DSH_JS,
});
if (DRYRUN === "1") env.PT_CHAT_DRYRUN = "1";

const child = spawn(process.execPath, [path.join(tmpShell, "server.cjs"), "--port", PORT], {
  cwd: tmpShell, env, stdio: "inherit", windowsHide: false,
});
child.on("exit", (code) => { console.log("server exited code=" + code); process.exit(code ?? 0); });
console.log("server -> http://127.0.0.1:" + PORT + "  (DRYRUN=" + DRYRUN + ")");
