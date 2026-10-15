"use strict";
/**
 * mailer.cjs —— 重置密码邮件投递（北极星 U3：补齐「真实发信基础设施」）
 * ============================================================================
 * 设计目标：
 *   1) 让「忘记密码」在真实发信模式下真正把重置链接发到账号邮箱（修 #1 核心）。
 *   2) 不破坏既有反枚举设计：无论是否找到账号、是否成功发信，/forgot-password
 *      始终只回通用文案，绝不在响应里回传 token。
 *   3) 可降级、可测试：
 *        PT_MAIL_MODE=off     —— 不发（仅告警），适合完全不需要邮件的环境
 *        PT_MAIL_MODE=console —— 把邮件内容打到服务端日志（默认；本地联调可见链接，不依赖外部服务，不会崩）
 *        PT_MAIL_MODE=smtp    —— 通过 SMTP 真实发送（生产；需安装 nodemailer + 配置 PT_SMTP_*）
 *   4) 测试可注入：setMailer(fake) 让路由测试不依赖真实 SMTP；createMailer({transport})
 *      可用 nodemailer 的 jsonTransport 验证邮件内容/链接。
 *
 * 注意：node 未内置 SMTP，smtp 模式依赖 nodemailer。require 做了兜底，未安装时
 * 仅 smtp 模式报错（带明确信息），console/off 模式不受影响，服务照常启动。
 * ========================================================================== */
const crypto = require("crypto");

let _nodemailer = null;
let _nodemailerTried = false;
function loadNodemailer() {
  if (!_nodemailerTried) {
    try { _nodemailer = require("nodemailer"); } catch (e) { _nodemailer = null; }
    _nodemailerTried = true;
  }
  if (!_nodemailer) throw new Error("mailer: 未安装 nodemailer（请 npm i nodemailer），无法使用 smtp 模式");
  return _nodemailer;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** 构建重置邮件正文（纯文本 + HTML），链接来自 publicBaseUrl + token。 */
function buildResetEmail({ username, resetUrl, ttlMin }) {
  const safeName = escapeHtml(username);
  const text =
`你好 ${username}，

我们收到了你的「密码重置」请求。如果是你本人操作，请点击下面的链接重置密码（${ttlMin} 分钟内有效）：

${resetUrl}

如果这不是你发起的，请忽略本邮件，你的密码不会变更。

—— 北极星团队`;

  const html =
`<!doctype html>
<html lang="zh-CN"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;line-height:1.6">
  <h2 style="margin:0 0 12px">密码重置请求</h2>
  <p>你好 <b>${safeName}</b>，</p>
  <p>我们收到了你的「密码重置」请求。如果是你本人操作，请点击下面的按钮重置密码（<b>${ttlMin} 分钟内有效</b>）：</p>
  <p><a href="${resetUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">重置密码</a></p>
  <p style="color:#6b7280;font-size:13px">如果按钮无法点击，请复制以下链接到浏览器打开：<br><code style="word-break:break-all">${resetUrl}</code></p>
  <p style="color:#6b7280;font-size:13px">如果这不是你发起的，请忽略本邮件，你的密码不会变更。</p>
  <p style="color:#6b7280;font-size:13px">—— 北极星团队</p>
</body></html>`;
  return { text, html };
}

/**
 * 创建邮件投递器。
 * @param {object} [config]
 *   mode           'off' | 'console' | 'smtp'（默认读 PT_MAIL_MODE，再默认 'console'）
 *   from           发件人（默认 PT_MAIL_FROM 或 noreply@localhost）
 *   publicBaseUrl  重置链接的公网基址（默认 PT_PUBLIC_BASE_URL），用于拼 /reset?token=
 *   transport      已构建的 nodemailer transport（测试注入用；smtp 模式下优先）
 */
function createMailer(config = {}) {
  const mode = String(config.mode || process.env.PT_MAIL_MODE || "console").toLowerCase();
  const from = config.from || process.env.PT_MAIL_FROM || "noreply@localhost";
  const publicBaseUrl = String(config.publicBaseUrl || process.env.PT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  let transport = config.transport || null;

  if (mode === "smtp" && !transport) {
    const nodemailer = loadNodemailer();
    transport = nodemailer.createTransport({
      host: process.env.PT_SMTP_HOST,
      port: Number(process.env.PT_SMTP_PORT || 465),
      secure: process.env.PT_SMTP_SECURE === "1" || Number(process.env.PT_SMTP_PORT || 465) === 465,
      auth: process.env.PT_SMTP_USER ? { user: process.env.PT_SMTP_USER, pass: process.env.PT_SMTP_PASS } : undefined,
    });
  }

  return {
    mode,
    /**
     * 发送密码重置邮件。
     * @returns {Promise<{sent:boolean, mode:string, info?:any, skipped?:string}>}
     */
    async sendResetEmail({ to, token, username, ttlMs }) {
      const ttlMin = Math.max(1, Math.round((Number(ttlMs) || 30 * 60 * 1000) / 60000));
      const resetUrl = publicBaseUrl + "/reset?token=" + encodeURIComponent(token);
      const { text, html } = buildResetEmail({ username, resetUrl, ttlMin });
      const mail = { from, to, subject: "北极星 · 密码重置请求", text, html };

      if (mode === "off") {
        console.warn("[mailer] PT_MAIL_MODE=off：未发送重置邮件给 " + to);
        return { sent: false, mode, skipped: "off" };
      }
      if (mode === "console") {
        console.log("[mailer][CONSOLE] 重置邮件（未真实发送；设 PT_MAIL_MODE=smtp 才真发）：\n" + JSON.stringify(mail, null, 2));
        return { sent: true, mode: "console" };
      }
      if (mode === "smtp") {
        if (!transport) throw new Error("mailer: smtp 模式但未正确初始化传输（检查 PT_SMTP_HOST / nodemailer 是否安装）");
        if (!publicBaseUrl) console.warn("[mailer] PT_PUBLIC_BASE_URL 未设置，邮件里的重置链接是相对地址，外网无法点击");
        const info = await transport.sendMail(mail);
        return { sent: true, mode: "smtp", info };
      }
      throw new Error("mailer: 未知 mode=" + mode);
    },
  };
}

// ---- 单例 + 测试注入 ----
let _singleton = null;
let _override = null;
function setMailer(m) { _override = m; }
function getMailer() { return _override || _singleton || (_singleton = createMailer()); }

module.exports = { createMailer, getMailer, setMailer, buildResetEmail, escapeHtml };
