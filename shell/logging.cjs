"use strict";
/**
 * logging.cjs —— 北极星 · 轻量结构化日志（零第三方依赖，原生 fs 追加）
 * ============================================================================
 * 目标（P1 #13 运维观测）：
 *   ① 把散落的 console.log 收敛成「结构化 JSON 行日志」，落到 北极星产品\logs\（按天切割）；
 *   ② 每行固定含：ts（ISO 时间）/ level（info|warn|error|debug）/ event（事件名）/ 关键字段；
 *   ③ 零泄露：绝不写 key 明文、密码、token。三道防线：
 *      a. 字段名黑名单（password/token/api_key/authorization/cookie/session…）→ 值替换为 [REDACTED]；
 *      b. addSecret()：调用方在启动时登记「绝不允许出现」的明文串，写行前统一替换为 [REDACTED]；
 *      c. 约定：只记元数据（method/path/status/ip/耗时），永不记请求体、响应体、解密后的 key。
 *   ④ 日志写失败不能拖垮主服务：try/catch 兜底，只往 stderr 打一行提示。
 *
 * 用法：
 *   const log = require("./logging.cjs");
 *   log.addSecret(PASSWORD, DASH_TOKEN);          // 启动时登记敏感串（防御兜底）
 *   log.info("listening", { port: 8098 });        // 事件 + 关键字段
 *   log.error("request_error", { method, path, error: e.message });
 *
 * 目录覆盖：PT_LOG_DIR 环境变量可指向别处（自测用临时目录，不污染真实 logs）。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");

/** 日志目录：默认 北极星产品\logs，可用 PT_LOG_DIR 覆盖（自测/容器用）。 */
const LOG_DIR = process.env.PT_LOG_DIR || path.join(__dirname, "..", "logs");

/** 命中即视为敏感字段名 → 值一律 [REDACTED]（无论调用方传什么）。 */
const SENSITIVE_FIELD = /^(password|passwd|pass|pwd|secret|token|api[_-]?key|authorization|authorisation|cookie|session|credential|bearer|master[_-]?key)$/i;

/** 已登记「绝不允许出现在日志里」的明文串（server 启动时登记 password / token）。 */
const _secrets = new Set();

/** 登记敏感明文串（长度 < 3 的忽略，避免误伤）；返回 logger 自身便于链式。 */
function addSecret(...strs) {
  for (const s of strs) {
    const v = String(s == null ? "" : s);
    if (v.length >= 3) _secrets.add(v);
  }
  return module.exports;
}

/** 把已登记的敏感串从字符串中替换为 [REDACTED]（写行前的最后一道防线）。 */
function scrub(input) {
  let out = String(input == null ? "" : input);
  for (const sec of _secrets) {
    out = out.split(sec).join("[REDACTED]");
  }
  return out;
}

/** 字段名脱敏：黑名单字段的值一律换成 [REDACTED]，其余原样保留。 */
function sanitize(fields) {
  const out = {};
  if (fields && typeof fields === "object") {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      out[k] = SENSITIVE_FIELD.test(k) ? "[REDACTED]" : v;
    }
  }
  return out;
}

/** 写一行（按天切割文件名 app-YYYY-MM-DD.log；先 scrub 再落盘）。 */
function writeLine(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const file = path.join(LOG_DIR, "app-" + y + "-" + m + "-" + day + ".log");
    fs.appendFileSync(file, scrub(JSON.stringify(entry)) + "\n", "utf8");
  } catch (e) {
    // 日志本身失败不能拖垮主服务：静默兜底，只往 stderr 提示一次。
    process.stderr.write("[logging] 写日志失败：" + (e && e.message ? e.message : e) + "\n");
  }
}

function emit(level, event, fields) {
  const entry = Object.assign({ ts: new Date().toISOString(), level, event }, sanitize(fields));
  writeLine(entry);
}

module.exports = {
  LOG_DIR,
  addSecret,
  scrub,
  sanitize,
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};
