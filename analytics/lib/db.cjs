/**
 * 交付版 · 数据库连接层
 * ============================================================================
 * 用一个 `pg` 兼容的连接池包住 PGlite（真 PostgreSQL，编译为 WASM 的嵌入版）。
 *
 * 为什么要做这一层：
 *   后端 14 个模块是用 `pg` 的 `pool.connect()` / `client.query()` / `client.release()`
 *   写的，一行都不用改 —— 换成真库只需要在这里把接口对上。
 *
 * 三个必须做对的地方（否则会静默出错）：
 *
 *   ① 【安全】以**非超级用户**角色运行
 *      PostgreSQL 的超级用户与 BYPASSRLS 角色**无条件绕过 RLS**（见 003 注释）。
 *      经真库实测：以 postgres 连接时，pt_events 的租户隔离策略静默失效。
 *      所以建完表后立刻 `SET ROLE pt_app`，并在启动时自检；不自检就是自欺欺人。
 *
 *   ② 【正确】单连接串行化
 *      PGlite 是**单连接**嵌入库。后端用 BEGIN…COMMIT 包事务，
 *      如果两个请求的语句交错执行，事务会串味（读到别人的未提交数据）。
 *      这里用互斥锁保证「一个 client 的所有语句连续执行完才轮到下一个」。
 *
 *   ③ 【兼容】返回形状对齐 pg
 *      PGlite 返回 affectedRows，pg 返回 rowCount；NUMERIC/BIGINT 的 JS 类型也需归一。
 * ============================================================================
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

const APP_ROLE = "pt_app";

// ---------------------------------------------------------------------------
// 互斥锁：保证同一时刻只有一个 client 在用那条唯一的连接
// ---------------------------------------------------------------------------

function createMutex() {
  let tail = Promise.resolve();
  return function acquire() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const prev = tail;
    tail = prev.then(() => gate);
    return prev.then(() => release);
  };
}

// ---------------------------------------------------------------------------
// 迁移：读取真实迁移脚本并执行
// ---------------------------------------------------------------------------

/**
 * 从 psql 迁移脚本里取出 UP 段。
 * 原脚本用 `\if :{?migrate_down} … \else … \endif` 在 UP/DOWN 之间切换，
 * 那是 psql 的元命令，PGlite 不认；这里直接把 UP 段取出来、丢掉元命令行。
 */
function extractUp(sqlText) {
  const elseIdx = sqlText.indexOf("\\else");
  const endIdx = sqlText.indexOf("\\endif");
  let body = sqlText;
  if (elseIdx !== -1 && endIdx !== -1 && endIdx > elseIdx) {
    body = sqlText.slice(elseIdx + "\\else".length, endIdx);
  }
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*\\/.test(l))
    .join("\n");
}

// ---------------------------------------------------------------------------
// 返回形状兼容层
// ---------------------------------------------------------------------------

/** 把 PGlite 的结果归一成 pg 的形状。 */
function normalizeResult(res) {
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  return {
    rows,
    rowCount:
      res && typeof res.affectedRows === "number" ? res.affectedRows : rows.length,
    fields: (res && res.fields) || [],
    command: (res && res.command) || "",
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 建立 PGlite 连接池（接口与 `pg` 的 Pool 一致）。
 *
 * @param {object} opts
 * @param {string} opts.dataDir  数据目录（PGlite 落盘位置）
 * @param {string} [opts.appRole] 应用角色名，默认 pt_app
 * @param {boolean} [opts.migrate] 是否执行迁移（默认 true）
 * @param {number} [opts.openRetries] 打开失败时的重试次数（默认 12）
 * @param {(msg:string)=>void} [opts.log]
 */
async function createPgCompatPool(opts) {
  const dataDir = opts.dataDir;
  const appRole = opts.appRole || APP_ROLE;
  const log = opts.log || (() => {});
  const doMigrate = opts.migrate !== false;
  const openRetries = opts.openRetries === undefined ? 12 : opts.openRetries;

  fs.mkdirSync(dataDir, { recursive: true });

  // ---- 处理 PostgreSQL 的残留 pid 文件 ----
  // 现象：进程被强杀（或没走优雅退出）后，数据目录里会留下 postmaster.pid。
  //      下次启动 PGlite 会认为「还有实例在跑」而拒绝初始化，报
  //      "PGlite failed to initialize properly"。
  //      PGlite 写进这个文件的 PID 固定是 -42（不是真实进程号），所以没法靠它判断死活。
  // 因此：由调用方（start.cjs 已用真实 PID 确认没有活着的实例）显式授权清理。
  //      这是 PostgreSQL 的标准做法 —— 确认没有活实例后删掉 stale pid 文件再启动。
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    if (opts.recoverStalePidFile) {
      try {
        fs.rmSync(pidFile, { force: true });
        log("  已清除上次异常退出留下的 postmaster.pid（残留锁）");
      } catch (e) {
        // 有些受限环境不允许删除「不是本进程创建」的文件。
        // 这时不要死在这 —— 把情况明确回报给调用方，由它决定换目录。
        const err = new Error("STALE_LOCK_NOT_REMOVABLE: " + e.message);
        err.code = "STALE_LOCK_NOT_REMOVABLE";
        err.pidFile = pidFile;
        throw err;
      }
    } else {
      log("  检测到 postmaster.pid（上次可能未正常退出）。若确认没有实例在跑，请用 recoverStalePidFile 允许清理。");
    }
  }

  // ---- 打开数据库（带重试）----
  // 为什么需要重试：PGlite 的数据目录同一时刻只能被一个进程持有。
  // 上一个实例刚被 SIGTERM 时，它的文件句柄不一定已经释放完；
  // 这时立刻打开会报 "PGlite failed to initialize properly"。
  // 首版没做重试，于是「关掉再启动」这种最平常的操作会直接失败。
  let db = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= openRetries; attempt++) {
    try {
      db = new PGlite(dataDir);
      await db.waitReady;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      db = null;
      if (attempt === 1) {
        log(`  数据库目录被占用，正在等待上一个实例释放…`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!db) {
    throw new Error(
      `无法打开数据库目录（已重试 ${openRetries} 次）：${lastErr && lastErr.message}\n` +
        `  目录：${dataDir}\n` +
        `  常见原因：另一个实例仍在运行。请先停掉它（Ctrl+C），或换一个 --port 重试。`
    );
  }

  const q = async (text, params) => normalizeResult(await db.query(text, params));

  // ---- 迁移（以超级用户身份跑 DDL；PGlite 默认连接用户就是超级用户）----
  if (doMigrate) {
    const origDir = opts.migrationsDir;                       // 原有迁移（只读引用，不复制）
    const deliveryDir = opts.deliveryMigrationsDir || path.join(__dirname, "..", "schema");
    if (!origDir) throw new Error("createPgCompatPool 需要 migrationsDir（指向 backend/db）");

    const files = [
      // 原有两个迁移脚本**直接读原文件**，不复制 —— 保证与仓库永不脱节
      { label: "001_init.sql", path: path.join(origDir, "001_init.sql"), isPsqlScript: true },
      { label: "002_attribution_index.sql", path: path.join(origDir, "002_attribution_index.sql"), isPsqlScript: true },
      { label: "003_add_x_platform.sql", path: path.join(origDir, "003_add_x_platform.sql"), isPsqlScript: true },
      // 交付版新增的一层（应用角色 / 缺失的表 / 安全自检）
      { label: "003_delivery.sql", path: path.join(deliveryDir, "003_delivery.sql"), isPsqlScript: false },
      // A2/A13：attribution_raw_events / attribution_event_dlq 建表 + RLS。
      // 必须在这里（超级用户阶段）建，不能留给运行时 pt_app 身份去补建——
      // pt_app 只有 003_delivery.sql 授予的 DML 权限，没有 CREATE，运行时补建必然失败
      // （collect/deps.cjs 里的 ensureSchema() 调用会把这个失败静默吞掉，表就永远建不出来）。
      // 且必须排在 003_delivery.sql 之后：它的 GRANT ... TO pt_app 依赖 pt_app 角色已存在。
      {
        label: "a2_raw_dlq.sql",
        path: path.join(__dirname, "..", "..", "business", "attribution", "schema", "a2_raw_dlq.sql"),
        isPsqlScript: false,
      },
    ];

    for (const f of files) {
      if (!fs.existsSync(f.path)) throw new Error("缺少迁移脚本：" + f.path);
      const sql = f.isPsqlScript
        ? extractUp(fs.readFileSync(f.path, "utf8"))
        : fs.readFileSync(f.path, "utf8");
      try {
        await db.exec(sql);
        log(`  迁移 ${f.label} 执行成功`);
      } catch (e) {
        throw new Error(`迁移 ${f.label} 失败：${e.message}`);
      }
    }
  }

  // ---- 切到非超级用户角色（RLS 才会真正生效）----
  // 顺序很重要：迁移用超级用户跑 DDL，但**自检必须在切完角色之后**——
  // 要检的是「实际运行时的身份」，而不是建表时的身份。
  // （第一版把自检写在切角色之前，结果永远报"你是超级用户"，等于自己把门焊死。）
  await db.exec(`SET ROLE ${appRole}`);

  // ---- 安全自检：不通过就拒绝启动（fail-closed）----
  const check = normalizeResult(await db.query(`SELECT * FROM pt_security_selfcheck()`));
  const failed = check.rows.filter((r) => r.ok !== true);
  if (failed.length > 0) {
    const detail = failed.map((r) => `  ✗ ${r.item}：${r.detail}`).join("\n");
    throw new Error(
      "安全自检未通过，拒绝启动（fail-closed）：\n" + detail +
        "\n提示：若提示角色是超级用户，说明 SET ROLE 没生效；若提示 RLS 未开启，说明 003 迁移没跑全。"
    );
  }

  const who = normalizeResult(
    await db.query(
      `SELECT current_user AS u,
              (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`
    )
  );
  const me = who.rows[0];
  if (me.is_super === true || me.bypass === true) {
    throw new Error(
      `切换应用到 ${appRole} 后仍是超级用户/BYPASSRLS（is_super=${me.is_super}, bypass=${me.bypass}）—— ` +
        "RLS 会静默失效，拒绝启动。"
    );
  }
  log(`  已切换应用角色：${me.u}（超级用户=${me.is_super} · 绕过RLS=${me.bypass}）`);

  // ---- 互斥锁 + pg 兼容接口 ----
  const acquire = createMutex();
  let releaseCurrent = null;

  const pool = {
    /** 与 pg 一致：借出一个 client，用完必须 release()。 */
    async connect() {
      releaseCurrent = await acquire();
      let released = false;

      // 兜底：万一调用方忘了 release，不能让整个服务卡死
      const guard = setTimeout(() => {
        if (!released) {
          log("  [警告] 有 client 超过 60s 未 release，已强制释放（请检查调用方）");
          released = true;
          const r = releaseCurrent;
          releaseCurrent = null;
          if (r) r();
        }
      }, 60000);
      if (guard.unref) guard.unref();

      return {
        async query(text, params) {
          return q(text, params);
        },
        release() {
          if (released) return;
          released = true;
          clearTimeout(guard);
          const r = releaseCurrent;
          releaseCurrent = null;
          if (r) r();
        },
        // 少数代码可能用 client.end()
        async end() {
          /* no-op */
        },
      };
    },

    /** 与 pg 一致：一次性查询（内部借还）。 */
    async query(text, params) {
      const client = await pool.connect();
      try {
        return await client.query(text, params);
      } finally {
        client.release();
      }
    },

    async end() {
      await db.close();
    },

    /** 交付版额外能力 */
    async exec(sql) {
      return db.exec(sql);
    },
    async rawQuery(text, params) {
      return db.query(text, params);
    },
    _pglite: db,
  };

  return pool;
}

/** SHA-256 十六进制（与后端 token 哈希口径一致）。 */
function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

module.exports = { createPgCompatPool, sha256Hex, extractUp, APP_ROLE };
