"use strict";
/**
 * keys.cjs —— PT key（BYOK）加密落盘（跨平台版）
 * ============================================================================
 * 职责（只做 key 加密，不越界做租户隔离 / 前端）：
 *   ① 用一个 AES-256 主密钥（master key）加解密用户的 PT key（AES-256-GCM）；
 *   ② 这个 master key 本身的落盘方式按平台分支：
 *        · Windows：用 DPAPI（ProtectedData，CurrentUser 作用域）Protect 后落盘，
 *          运行时 Unprotect 出来用——绝不在磁盘留明文副本；
 *        · 其他平台（Mac/Linux）：生成 32 字节随机 key，以 base64 落到
 *          secrets/master.key，文件权限 chmod 0600，并在启动日志打中文警告。
 *   ③ 明文 PT key 绝不落盘、绝不进日志、绝不回传前端（只给 key_last4）。
 *
 * 对外接口（server.cjs / tenant.cjs 会调，务必按此签名）：
 *   const keys = await initKeys({ db, masterKeyFile });
 *   await keys.encryptApiKey(userId, plaintext)   // 保存/覆盖用户 PT key
 *   await keys.decryptApiKey(userId)              // -> Promise<string|null> 明文
 *   await keys.getKeyMeta(userId)                 // -> { key_last4, created_at, updated_at } | null
 * ============================================================================
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const IV_LEN = 12;          // GCM 推荐 96-bit 随机 IV
const AUTH_TAG_LEN = 16;    // 128-bit auth tag
const MASTER_KEY_LEN = 32;  // AES-256 = 32 字节主密钥
const MAX_KEY_LEN = 256;    // PT key 长度上限（字符）

/* ============================================================================
 * DPAPI 后端（仅 Windows 使用；真 DPAPI，非明文存 master key）
 * ----------------------------------------------------------------------------
 * PowerShell 5.1 不允许在 -EncodedCommand 之后传位置参数（$args 只在
 * -Command/-File 下有效），所以「模式」走环境变量 DPAPI_MODE，「数据」走
 * stdin 管道（base64），两个方向都不上 argv、不上磁盘。
 * ========================================================================== */
const DPAPI_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$Mode = $env:DPAPI_MODE",
  "$Data = [Console]::In.ReadToEnd().Trim()",
  "Add-Type -AssemblyName System.Security",
  "$bytes = [Convert]::FromBase64String($Data)",
  "if ($Mode -eq 'protect') {",
  "  $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "} else {",
  "  $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "}",
  "[Convert]::ToBase64String($out)",
].join("\n");
const DPAPI_SCRIPT_B64 = Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64");

/** mode ∈ { "protect", "unprotect" }；dataBase64 走 stdin；返回 base64 字符串。 */
function dpapi(mode, dataBase64) {
  let r;
  try {
    r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", DPAPI_SCRIPT_B64], {
      input: dataBase64,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      env: Object.assign({}, process.env, { DPAPI_MODE: mode }),
    });
  } catch (e) {
    throw new Error("无法启动 PowerShell 调 DPAPI：" + (e && e.message));
  }
  if (r.error) throw new Error("DPAPI 调用失败（PowerShell 不可用？）：" + (r.error.code || r.error.message || String(r.error)));
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || ("exit " + r.status)).trim();
    throw new Error("DPAPI " + mode + " 失败：" + msg.slice(0, 300));
  }
  const out = String(r.stdout || "").trim();
  if (!out) throw new Error("DPAPI " + mode + " 返回空输出");
  return out;
}

/** 把 Buffer 清零，尽力抹掉内存里的明文。 */
function zero(buf) {
  try { if (buf && buf.length) buf.fill(0); } catch (e) { /* 尽力而为 */ }
}

/* ============================================================================
 * master key 文件的读写（两种 scheme：dpapi-currentuser / raw-0600）
 * ========================================================================== */
function readMasterKeyFile(masterKeyFile) {
  const obj = JSON.parse(fs.readFileSync(masterKeyFile, "utf8"));
  if (obj && obj.scheme === "dpapi-currentuser" && typeof obj.blob === "string" && obj.blob) {
    return obj;
  }
  if (obj && obj.scheme === "raw-0600" && typeof obj.key === "string" && obj.key) {
    return obj;
  }
  throw new Error("master key 文件格式不对（缺 scheme/blob 或 scheme/key）");
}

function writeMasterKeyFile(masterKeyFile, obj) {
  fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true });
  fs.writeFileSync(masterKeyFile, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(masterKeyFile, 0o600); } catch (e) { /* Windows 上尽力 */ }
}

/**
 * 取或生成 master key（按平台分支）：
 *   Windows：随机 32 字节 → DPAPI Protect → 只把 DPAPI blob(base64) 写盘；
 *   非 Windows：随机 32 字节 → base64 落盘，文件权限 0600（明文只受文件权限保护）。
 *   明文 master key 在 Windows 上从头到尾不落盘；在非 Windows 上仅以 0600 权限保护。
 */
function getOrCreateMasterKey(masterKeyFile) {
  if (fs.existsSync(masterKeyFile)) return readMasterKeyFile(masterKeyFile);
  const raw = crypto.randomBytes(MASTER_KEY_LEN);

  if (process.platform === "win32") {
    const blob = dpapi("protect", raw.toString("base64"));
    zero(raw); // 明文主密钥用完即弃
    const obj = { scheme: "dpapi-currentuser", protected: true, blob, created_at: new Date().toISOString() };
    writeMasterKeyFile(masterKeyFile, obj);
    return obj;
  }

  // ---- 非 Windows（Mac / Linux）：随机 key 落盘，文件权限 0600 ----
  const obj = { scheme: "raw-0600", protected: false, key: raw.toString("base64"), created_at: new Date().toISOString() };
  zero(raw);
  writeMasterKeyFile(masterKeyFile, obj); // 内部已 chmod 0600
  console.warn(
    "[安全警告] 非 Windows：master key 以文件权限 0600 保护，请勿提交/共享该文件：" + masterKeyFile
  );
  return obj;
}

/** 解出 32 字节主密钥（只在内存，调用方用完必须 zero）。 */
function unprotectMasterKey(masterKeyObj) {
  let b64;
  if (masterKeyObj.scheme === "raw-0600") {
    b64 = masterKeyObj.key;                 // 非 Windows：直接读 base64
  } else {
    b64 = dpapi("unprotect", masterKeyObj.blob); // Windows：DPAPI Unprotect
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== MASTER_KEY_LEN) {
    zero(key);
    throw new Error("master key 长度不对（期望 " + MASTER_KEY_LEN + " 字节，实得 " + key.length + "）");
  }
  return key;
}

/* ============================================================================
 * AES-256-GCM 原语（iv 随机、auth tag 校验）
 * ========================================================================== */

/** 加密：返回 { iv(base64), ciphertext(base64 = 密文‖auth tag) }。 */
function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
  };
}

/** 解密：auth tag 不符（密文/iv 被篡改）会抛错。 */
function decryptWithKey(key, ivBase64, ciphertextBase64) {
  const iv = Buffer.from(ivBase64, "base64");
  const data = Buffer.from(ciphertextBase64, "base64");
  if (iv.length !== IV_LEN) throw new Error("iv 长度不对");
  if (data.length < AUTH_TAG_LEN) throw new Error("密文太短（缺 auth tag）");
  const enc = data.slice(0, data.length - AUTH_TAG_LEN);
  const tag = data.slice(data.length - AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/* ============================================================================
 * 初始化：绑定 db + master key 文件，返回业务方法
 * ========================================================================== */
async function initKeys(opts = {}) {
  const db = opts.db;
  if (!db) throw new Error("initKeys 需要 opts.db（PGlite 实例）");
  const masterKeyFile = opts.masterKeyFile || path.join(__dirname, "..", "secrets", "master.key");

  const masterKeyObj = getOrCreateMasterKey(masterKeyFile);

  /**
   * 保存 / 覆盖当前用户的 PT key（幂等：user_id 唯一，重复保存覆盖更新）。
   * 明文只在内存，落库的只有 ciphertext + iv + key_last4。
   */
  async function encryptApiKey(userId, plaintext) {
    if (typeof plaintext !== "string") {
      return { ok: false, code: "NOT_STRING", error: "PT key 必须是字符串" };
    }
    const text = plaintext.trim();
    if (!text) return { ok: false, code: "EMPTY", error: "PT key 不能为空" };
    if (text.length < 4) return { ok: false, code: "TOO_SHORT", error: "PT key 太短（至少 4 位）" };
    if (text.length > MAX_KEY_LEN) return { ok: false, code: "TOO_LONG", error: "PT key 太长（最多 " + MAX_KEY_LEN + " 字符）" };

    const key = unprotectMasterKey(masterKeyObj);
    let iv, ciphertext;
    try {
      ({ iv, ciphertext } = encryptWithKey(key, text));
    } finally {
      zero(key); // 主密钥用完即弃
    }

    const last4 = text.slice(-4);
    const r = await db.query(
      `INSERT INTO api_keys (user_id, ciphertext, iv, key_last4)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                     iv         = EXCLUDED.iv,
                     key_last4  = EXCLUDED.key_last4,
                     updated_at = now()
       RETURNING key_last4`,
      [userId, ciphertext, iv, last4]
    );
    return { ok: true, key_last4: r.rows[0].key_last4 };
  }

  /** 解出当前用户的明文 PT key（供 tenant spawn DSH 注入 env）；无 key 返回 null。 */
  async function decryptApiKey(userId) {
    const r = await db.query("SELECT ciphertext, iv FROM api_keys WHERE user_id = $1", [userId]);
    if (!r.rows.length) return null;
    const key = unprotectMasterKey(masterKeyObj);
    try {
      return decryptWithKey(key, r.rows[0].iv, r.rows[0].ciphertext);
    } finally {
      zero(key); // 主密钥用完即弃
    }
  }

  /** 只返回展示用元信息（末 4 位 + 时间），绝不返回明文。 */
  async function getKeyMeta(userId) {
    const r = await db.query("SELECT key_last4, created_at, updated_at FROM api_keys WHERE user_id = $1", [userId]);
    if (!r.rows.length) return null;
    return {
      key_last4: r.rows[0].key_last4,
      created_at: r.rows[0].created_at,
      updated_at: r.rows[0].updated_at,
    };
  }

  return { encryptApiKey, decryptApiKey, getKeyMeta, masterKeyFile, scheme: masterKeyObj.scheme };
}

module.exports = {
  initKeys,
  encryptWithKey,
  decryptWithKey,
  getOrCreateMasterKey,
  readMasterKeyFile,
  unprotectMasterKey,
  dpapi,
  IV_LEN,
  AUTH_TAG_LEN,
  MASTER_KEY_LEN,
  MAX_KEY_LEN,
};
