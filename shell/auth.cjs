"use strict";
/**
 * auth-v2.cjs —— 多租户身份（U1.1）：scrypt 密码哈希 + 数据库会话
 * ============================================================================
 * U1.1 修复（相对 auth.cjs / auth-v1）：
 *   P0 · 提权：register() 不再接收/使用 role 参数 —— 角色永远由服务端决定
 *             （首个用户 admin，其余 member）；ensureDefaultAdmin 也改为显式
 *             role='admin'，不再走 register，保证「默认管理员」永远是 admin。
 *   P3 · 健壮性：verifyPassword() 对「空/畸形 hex」哈希一律返回 false，杜绝
 *             「Buffer.from 无效 hex 得空 buffer → timingSafeEqual(空,空)=true」。
 * 其余能力与 auth.cjs 完全一致（scrypt + 随机盐 + 会话落库 + 1 用户 = 1 租户）。
 * ============================================================================
 */
const crypto = require("crypto");
const path = require("path");
const dbmod = require("./db.cjs");

const SCRYPT_N = 16384;   // 2^14，产品级起步成本，自测跑得动
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;        // 512 bit 派生密钥
const SALT_LEN = 16;      // 128 bit 随机盐
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话默认 7 天

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/**
 * 哈希格式：scrypt$N$r$p$<salt hex>$<key hex>
 * 参数一并写进哈希串，将来调高成本也能向后兼容旧哈希。
 */
function hashPassword(password, opts = {}) {
  const N = opts.N || SCRYPT_N;
  const r = opts.r || SCRYPT_R;
  const p = opts.p || SCRYPT_P;
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(String(password), salt, KEYLEN, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("hex"), key.toString("hex")].join("$");
}

/** 防时序攻击比较：scrypt 结果长度一致后用 timingSafeEqual；任何畸形/空哈希一律 false。 */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (!(N > 0 && r > 0 && p > 0)) return false;
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    // P3 修复：空/畸形 hex 会得到 0 长度 buffer，绝不能走 timingSafeEqual(空,空)=true 的路径
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    if (derived.length === 0 || derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch (e) {
    return false; // 哈希串损坏也当「不匹配」，绝不抛出而泄露信息
  }
}

// 用户名不存在时也跑一次等价耗时比较，抹平「用户名是否存在」的时序侧信道
const DUMMY_HASH = hashPassword("northstar-dummy-timing-equalizer");

const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email, role: u.role, tenant_id: u.tenant_id });
const publicTenant = (t) => (t ? { id: t.id, name: t.name } : null);

/**
 * 初始化身份库：打开 PGlite + 跑迁移，返回一组业务方法。
 * 幂等：可反复调用（迁移自动跳过），默认管理员种子只在缺的时候插入。
 */
async function initAuth(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, "..", "db");
  const migrationsDir = opts.migrationsDir || path.join(__dirname, "db-migrations");
  const ttlMs = Number(opts.sessionTtlMs || process.env.PT_SESSION_TTL_MS || DEFAULT_TTL_MS);

  const { db, close } = await dbmod.open({ dataDir });
  await dbmod.migrate(db, migrationsDir);

  /** 内部建用户：role 由「调用方（服务端逻辑）」显式给出，绝不经 HTTP 请求体。 */
  async function _createUser({ username, email, password, role }) {
    const hash = hashPassword(password);
    let user = null, tenant = null;
    await db.transaction(async (tx) => {
      const t = await tx.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id, name", [username]);
      tenant = t.rows[0];
      const u = await tx.query(
        "INSERT INTO users (tenant_id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, email, role, tenant_id",
        [tenant.id, username, email, hash, role]
      );
      user = u.rows[0];
    });
    return { user: publicUser(user), tenant: publicTenant(tenant) };
  }

  /** 注册：自动建 tenant 并绑定；角色永远服务端决定，不接收 role。 */
  async function register({ username, email, password } = {}) {
    const uname = String(username || "").trim();
    const pass = String(password || "");
    const mail = String(email || "").trim() || null;

    if (uname.length < 2 || uname.length > 64) return { ok: false, code: "VALIDATION", error: "用户名需 2~64 个字符" };
    if (pass.length < 8) return { ok: false, code: "VALIDATION", error: "密码至少 8 位" };
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, code: "VALIDATION", error: "邮箱格式不对" };

    const dup = await db.query("SELECT 1 FROM users WHERE username = $1", [uname]);
    if (dup.rows.length) return { ok: false, code: "USERNAME_TAKEN", error: "用户名已被占用" };
    if (mail) {
      const em = await db.query("SELECT 1 FROM users WHERE email = $1", [mail]);
      if (em.rows.length) return { ok: false, code: "EMAIL_TAKEN", error: "邮箱已被注册" };
    }

    const cnt = await db.query("SELECT count(*)::int AS n FROM users");
    const isFirst = cnt.rows[0].n === 0;
    // P0 修复：role 绝不再从参数/请求体取，只按「是否首个用户」决定
    // B4-fix: 使用 VIEWER 角色替代 MEMBER 角色以保持一致性
    const finalRole = isFirst ? "admin" : "viewer";

    try {
      const created = await _createUser({ username: uname, email: mail, password: pass, role: finalRole });
      return { ok: true, user: created.user, tenant: created.tenant };
    } catch (e) {
      // UNIQUE 约束是并发兜底；单进程下基本到不了这
      if (String(e && e.message).indexOf("duplicate key") !== -1) return { ok: false, code: "USERNAME_TAKEN", error: "用户名已被占用" };
      throw e;
    }
  }

  /** 登录：scrypt 校验 → 生成会话 token（服务端存哈希）→ 返回 token。 */
  async function login({ username, password } = {}) {
    const uname = String(username || "").trim();
    const pass = String(password || "");
    const r = await db.query(
      "SELECT id, tenant_id, username, email, password_hash, role FROM users WHERE username = $1",
      [uname]
    );
    if (!r.rows.length) {
      verifyPassword(pass, DUMMY_HASH); // 抹平时序，不泄露「用户是否存在」
      return { ok: false, error: "账号或密码不对" };
    }
    const u = r.rows[0];
    if (!verifyPassword(pass, u.password_hash)) return { ok: false, error: "账号或密码不对" };

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + ttlMs);
    await db.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [u.id, tokenHash, expiresAt]);

    const t = await db.query("SELECT id, name FROM tenants WHERE id = $1", [u.tenant_id]);
    return { ok: true, token, user: publicUser(u), tenant: publicTenant(t.rows[0]), expiresAt: expiresAt.toISOString() };
  }

  /** 用 token 反查会话（含过期判断）；返回 { user, tenant } 或 null。 */
  async function getSession(token) {
    if (!token) return null;
    const th = sha256(token);
    const r = await db.query(
      `SELECT s.expires_at,
              u.id AS user_id, u.username, u.email, u.role, u.tenant_id,
              t.id AS tid, t.name AS tenant_name
         FROM sessions s
         JOIN users u   ON u.id = s.user_id
         JOIN tenants t ON t.id = u.tenant_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [th]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      user: { id: row.user_id, username: row.username, email: row.email, role: row.role, tenant_id: row.tenant_id },
      tenant: { id: row.tid, name: row.tenant_name },
    };
  }

  /** 登出：删掉服务端会话（token 哈希），客户端清 cookie 由路由层做。 */
  async function logout(token) {
    if (!token) return false;
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    return true;
  }

  const me = (token) => getSession(token);

  /** 幂等种子：保证「默认管理员」存在且 role 恒为 admin（不依赖是否首个用户）。 */
  async function ensureDefaultAdmin(username, password) {
    const uname = String(username || "admin").trim();
    const pass = String(password || "");
    if (!pass) throw new Error("默认管理员密码不能为空：必须设置 PT_SHELL_PASSWORD（或由启动逻辑生成随机密码）");
    const exists = await db.query("SELECT 1 FROM users WHERE username = $1", [uname]);
    if (exists.rows.length) return { ok: true, created: false };
    // 直接以显式 role='admin' 落库（服务端种子，不经 register 的 isFirst 逻辑）
    await _createUser({ username: uname, email: null, password: pass, role: "admin" });
    return { ok: true, created: true };
  }

  const api = { db, close, register, login, getSession, logout, me, ensureDefaultAdmin, ttlMs };

  if (opts.defaultAdmin && opts.defaultAdmin.username) {
    await api.ensureDefaultAdmin(opts.defaultAdmin.username, opts.defaultAdmin.password);
  }
  return api;
}

module.exports = { initAuth, hashPassword, verifyPassword, sha256, DEFAULT_TTL_MS };
