"use strict";
/**
 * tests/regression/auth-flow-fixes-test.mjs
 * ============================================================================
 * 北极星紧急 Bug（登录/注册/找回密码，2026-10-15）回归验收
 * ----------------------------------------------------------------------------
 * 覆盖四条：
 *   #1【最高优先级】找回密码真实发信 —— mailer 决策 + forgot-password 路由集成
 *       （生产模式下调用 mailer 把重置链接发到账号邮箱；反枚举通用文案保留，
 *        响应里绝不含 token；开发模式 PT_RESET_DELIVERY=return 才直返 token。）
 *   #2/#3【低风险】登录/注册按钮卡住 —— register.js 的 setBusy(busy=false) 必须恢复 idle 文案
 *   #4【安全加固】密码复杂度 —— 后端 auth.cjs + 前端 pw-strength.js 规则一致（≥8 位 + 字母 + 数字）
 *
 * 跑法：node tests/regression/auth-flow-fixes-test.mjs
 * ========================================================================== */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(__dirname, "../../shell");

import authRoutesMod from "../../shell/auth-routes.cjs";
const { handleAuthRoutes } = authRoutesMod;
import mailerMod from "../../shell/mailer.cjs";
const { createMailer, getMailer, setMailer, buildResetEmail } = mailerMod;
import authMod from "../../shell/auth.cjs";
const { validatePasswordComplexity: backendComplexity } = authMod;

const REGISTER = path.resolve(SHELL, "public/register.js");
const PW_STRENGTH = path.resolve(SHELL, "public/pw-strength.js");
const AUTH_ROUTES = path.resolve(SHELL, "auth-routes.cjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};

async function main() {
  console.log("\n🔐 北极星 auth 流程修复回归");

  /* ==================================================================
   * [#4] 密码复杂度 —— 后端 auth.cjs.validatePasswordComplexity
   * ================================================================== */
  console.log("\n[#4] 后端密码复杂度（auth.cjs）");
  {
    ok("纯数字 8 位被拦截（缺字母）", backendComplexity("11111111") === "密码需包含至少一个字母", String(backendComplexity("11111111")));
    ok("纯字母 8 位被拦截（缺数字）", backendComplexity("abcdefgh") === "密码需包含至少一个数字", String(backendComplexity("abcdefgh")));
    ok("长度不足被拦截", backendComplexity("abc12") === "密码至少 8 位", String(backendComplexity("abc12")));
    ok("空密码被拦截", backendComplexity("") === "密码至少 8 位", String(backendComplexity("")));
    ok("合规：字母+数字 8 位通过", backendComplexity("abcd1234") === null);
    ok("合规：含符号也通过", backendComplexity("Abcd1234!") === null);
  }

  /* ==================================================================
   * [#4] 密码复杂度 —— 前端 pw-strength.js window.validatePasswordComplexity
   *       （必须与后端规则一致，否则前后端会各拦截各的）
   * ================================================================== */
  console.log("\n[#4] 前端密码复杂度（pw-strength.js，vm 运行真实源码）");
  let frontendComplexity = null;
  {
    const src = readFileSync(PW_STRENGTH, "utf8");
    const ctx = { window: {}, console: { log() {}, warn() {}, error() {} } };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    frontendComplexity = ctx.window.validatePasswordComplexity;
    ok("前端确实暴露了 window.validatePasswordComplexity", typeof frontendComplexity === "function");
  }
  if (frontendComplexity) {
    ok("前端：纯数字 8 位拦截原因与后端一致", frontendComplexity("11111111") === "密码需包含至少一个字母", String(frontendComplexity("11111111")));
    ok("前端：纯字母 8 位拦截原因与后端一致", frontendComplexity("abcdefgh") === "密码需包含至少一个数字", String(frontendComplexity("abcdefgh")));
    ok("前端：长度不足拦截", frontendComplexity("abc12") === "密码至少 8 位");
    ok("前端：合规密码通过", frontendComplexity("abcd1234") === null);
  }

  /* ==================================================================
   * [#2/#3] 登录/注册按钮卡住 —— 提取 register.js 的 setBusy 实测
   * ================================================================== */
  console.log("\n[#2/#3] setBusy 修复（register.js，提取真实函数实测）");
  {
    const regSrc = readFileSync(REGISTER, "utf8");
    const m = regSrc.match(/const setBusy = \(btn, busy, busyText, idleText\) => \{[\s\S]*?\n  \};/);
    ok("源码里能定位 setBusy 定义", !!m);
    ok("旧误改逻辑已移除（无 `if (busyText)` 分支）", !/\bif\s*\(\s*busyText\s*\)/.test(regSrc),
      "若此处失败，说明又退回了只在 busyText 为真才改文案的旧写法");

    let setBusy = null;
    if (m) { try { setBusy = new Function(m[0] + "\nreturn setBusy;")(); } catch (e) { console.log("  (提取失败：" + e.message + ")"); } }
    ok("setBusy 可被实例化", typeof setBusy === "function");

    if (setBusy) {
      const btn = { disabled: false, textContent: "" };
      setBusy(btn, true, "登录中…", "登录");
      ok("busy=true → 文案变 busyText 且禁用", btn.textContent === "登录中…" && btn.disabled === true, JSON.stringify(btn));
      setBusy(btn, false, "登录中…", "登录");
      ok("busy=false → 文案恢复 idleText（修 #2/#3 关键）", btn.textContent === "登录" && btn.disabled === false, JSON.stringify(btn));
      // 注册场景同样的助手
      const rb = { disabled: false, textContent: "" };
      setBusy(rb, true, "注册中…", "注册并进入对话");
      setBusy(rb, false, "注册中…", "注册并进入对话");
      ok("注册按钮失败/成功后也恢复 idle 文案", rb.textContent === "注册并进入对话", JSON.stringify(rb));
    }
  }

  /* ==================================================================
   * [#1] mailer 发信决策（mailer.cjs）
   * ================================================================== */
  console.log("\n[#1] mailer 发信决策（mailer.cjs）");
  {
    // console 模式：不真发，把链接打到日志，返回 sent:true
    let captured = [];
    const origLog = console.log;
    console.log = (...a) => captured.push(a.join(" "));
    let r;
    try { r = await createMailer({ mode: "console", publicBaseUrl: "https://app.example.com" }).sendResetEmail({ to: "a@b.com", token: "tok123", username: "alice", ttlMs: 30 * 60 * 1000 }); }
    finally { console.log = origLog; }
    ok("console 模式返回 sent:true", r && r.sent === true && r.mode === "console", JSON.stringify(r));
    ok("console 模式把重置链接打到日志", captured.some((l) => /reset\?token=tok123/.test(l)), JSON.stringify(captured).slice(0, 120));

    // off 模式：不发送，返回 sent:false，不依赖 transport
    const off = createMailer({ mode: "off", publicBaseUrl: "https://app.example.com" });
    const offR = await off.sendResetEmail({ to: "a@b.com", token: "tok123", username: "alice", ttlMs: 30 * 60 * 1000 });
    ok("off 模式返回 sent:false", offR && offR.sent === false && offR.mode === "off", JSON.stringify(offR));

    // smtp 模式 + 注入 transport：调用 sendMail，链接正确拼接
    let sentArgs = null;
    const fakeTransport = { async sendMail(mail) { sentArgs = mail; return { messageId: "x" }; } };
    const smtp = createMailer({ mode: "smtp", publicBaseUrl: "https://app.example.com", transport: fakeTransport });
    const smtpR = await smtp.sendResetEmail({ to: "alice@example.com", token: "tokABC", username: "alice", ttlMs: 30 * 60 * 1000 });
    ok("smtp 模式返回 sent:true", smtpR && smtpR.sent === true && smtpR.mode === "smtp", JSON.stringify(smtpR));
    ok("smtp 模式调用了 transport.sendMail", !!sentArgs, "未调用");
    ok("邮件 to 是账号邮箱", sentArgs && sentArgs.to === "alice@example.com", sentArgs && sentArgs.to);
    ok("重置链接 = publicBaseUrl + /reset?token= + encodeURIComponent(token)",
      sentArgs && sentArgs.html.includes("https://app.example.com/reset?token=tokABC"),
      sentArgs && sentArgs.html.slice(0, 160));

    // buildResetEmail：username 被转义（防 XSS）
    const evil = buildResetEmail({ username: "<script>x</script>", resetUrl: "https://app.example.com/reset?token=t", ttlMin: 30 });
    ok("buildResetEmail 转义用户名（无原样 <script>）", !/<script>/i.test(evil.html), "出现未转义标签");
    ok("buildResetEmail 含重置链接", evil.html.includes("https://app.example.com/reset?token=t"));
  }

  /* ==================================================================
   * [#1] forgot-password 路由集成（auth-routes.cjs handleAuthRoutes）
   *   生产模式：调用 mailer，响应不泄漏 token；开发模式：直返 token，不调 mailer
   * ================================================================== */
  console.log("\n[#1] forgot-password 路由集成（auth-routes.cjs）");
  {
    // 注入一个可观测的 fake mailer（与路由里 getMailer() 同一模块实例）
    let mailCalls = [];
    const fakeMailer = {
      mode: "fake",
      async sendResetEmail(args) { mailCalls.push(args); return { sent: true, mode: "fake" }; },
    };
    setMailer(fakeMailer);

    function makeDb(userExists) {
      return {
        async query(sql, params) {
          if (/FROM users/.test(sql)) return { rows: userExists ? [{ id: "u1", username: "alice", email: "alice@example.com" }] : [] };
          if (/INSERT INTO password_reset_tokens/.test(sql)) return { rows: [] };
          return { rows: [] };
        },
      };
    }
    function makeReq(bodyObj, headers = {}) {
      const body = JSON.stringify(bodyObj);
      const h = {};
      const req = {
        url: "/api/auth/forgot-password", method: "POST", headers, socket: { remoteAddress: "127.0.0.1" },
        on(ev, cb) {
          (h[ev] = h[ev] || []).push(cb);
          if (!req._sched) {
            req._sched = true;
            Promise.resolve().then(() => { const d = Buffer.from(body); (h.data || []).forEach((f) => f(d)); (h.end || []).forEach((f) => f()); });
          }
          return req;
        },
      };
      return req;
    }
    function makeRes() {
      let code = null, body = null;
      return {
        writeHead(c) { code = c; },
        end(b) { body = b; },
        get status() { return code; },
        get json() { try { return JSON.parse(body); } catch { return null; } },
      };
    }

    // ---- 生产模式（PT_RESET_DELIVERY 未设）：存在账号 ----
    mailCalls = [];
    delete process.env.PT_RESET_DELIVERY;
    const authExist = { db: makeDb(true) };
    let res1 = makeRes();
    await handleAuthRoutes(makeReq({ email: "alice@example.com" }), res1, authExist);
    ok("生产模式：返回 200 通用文案", res1.status === 200, String(res1.status));
    ok("生产模式：文案是反枚举通用语", res1.json && res1.json.ok === true && /若该账号存在/.test(res1.json.message), JSON.stringify(res1.json));
    ok("生产模式：响应里不含 token（防枚举泄露）", res1.json && !("token" in res1.json) && !("resetUrl" in res1.json), JSON.stringify(res1.json));
    ok("生产模式：真的调用了 mailer 发信", mailCalls.length === 1, JSON.stringify(mailCalls.length));
    ok("生产模式：发信 to 是账号邮箱", mailCalls[0] && mailCalls[0].to === "alice@example.com", mailCalls[0] && mailCalls[0].to);

    // ---- 生产模式：不存在的账号（反枚举，不调用 mailer，不留痕）----
    mailCalls = [];
    const authNoUser = { db: makeDb(false) };
    let res2 = makeRes();
    await handleAuthRoutes(makeReq({ username: "ghost" }), res2, authNoUser);
    ok("不存在账号：仍返回同一套通用文案", res2.json && res2.json.ok === true && /若该账号存在/.test(res2.json.message), JSON.stringify(res2.json));
    ok("不存在账号：不调用 mailer（不留下「账号不存在」痕迹）", mailCalls.length === 0, JSON.stringify(mailCalls.length));

    // ---- 开发模式（PT_RESET_DELIVERY=return）：直返 token，不调 mailer ----
    mailCalls = [];
    process.env.PT_RESET_DELIVERY = "return";
    let res3 = makeRes();
    await handleAuthRoutes(makeReq({ email: "alice@example.com" }), res3, authExist);
    ok("开发模式：响应含 token（本地联调用）", res3.json && typeof res3.json.token === "string" && res3.json.token.length > 0, JSON.stringify(res3.json));
    ok("开发模式：响应含 resetUrl", res3.json && typeof res3.json.resetUrl === "string" && /reset\?token=/.test(res3.json.resetUrl), JSON.stringify(res3.json));
    ok("开发模式：不调用 mailer（绕开真实发信）", mailCalls.length === 0, JSON.stringify(mailCalls.length));
    delete process.env.PT_RESET_DELIVERY;

    // 复位 mailer 注入，避免影响其它测试/进程
    setMailer(null);
  }

  /* ==================================================================
   * 静态契约：reset-password / change-password 路由都接入了复杂度校验
   * （与后端 validatePasswordComplexity 共用同一函数，单一事实来源）
   * ================================================================== */
  console.log("\n[契约] 重置/改密码路由接入复杂度校验");
  {
    const src = readFileSync(AUTH_ROUTES, "utf8");
    ok("reset-password 路由调用 validatePasswordComplexity", /const pwErr = validatePasswordComplexity\(password\);/.test(src));
    ok("change-password 路由调用 validatePasswordComplexity", /const npErr = validatePasswordComplexity\(np\);/.test(src));
    ok("register() 接入复杂度校验（auth.cjs 内）", /const pwErr = validatePasswordComplexity\(pass\);/.test(readFileSync(path.resolve(SHELL, "auth.cjs"), "utf8")));
  }

  console.log(`\n==== auth 流程修复回归：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试运行失败:", err && err.stack ? err.stack : err);
  process.exit(1);
});
