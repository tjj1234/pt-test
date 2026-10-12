/**
 * 第 3 项回归：设置页「广告与数据源授权」（非 GA 部分）
 *
 * 背景：这节 10/8 加过（M7）、10/10 连同 GA property 连接一起被整节删掉了。
 * 删它的理由只成立于 GA（GA 挪去了技能页），非 GA 的清单属于误杀 —— PRD 3.4
 * 要的「已授权账户清单 + 授权范围 + 三态 + 解除影响提醒」并没有撤销。
 *
 * 这里跑的是**真实的 shell/public/settings.js**（mock 开关为 true，不碰后端）。
 * 用法：node tests/regression/ui-settings-auth-accounts-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeDomStub } from "../helpers/dom-stub.mjs";

const JS = new URL("../../shell/public/settings.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HTML = new URL("../../shell/public/settings.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = readFileSync(JS, "utf8");
const html = readFileSync(HTML, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  -> " + extra : "")); }
};
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/* ---- HTML 侧的静态事实（页面结构本来就该在这一层保证）---- */
ok("页面确实有「广告与数据源授权」这一节", /id="sourcesHeading"/.test(html));
ok("GA property 连接入口没有跟着复活", !/gaPropertyId|id="gaConnect"/.test(html));
ok("三态徽标用的是 PRD 的三种语义", /有效[\s\S]{0,40}即将过期[\s\S]{0,40}需重验/.test(src) || /\.acct-badge\.ok[\s\S]*\.acct-badge\.warn[\s\S]*\.acct-badge\.danger/.test(html));

/* ---- 跑真实 settings.js ---- */
const dom = makeDomStub();
const calls = [];
const ctx = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  ...dom,
  window: { addEventListener() {}, ICONS: {} },
  location: { href: "/settings", replace() {}, search: "" },
  fetch: async (url, opt) => {
    calls.push({ url: String(url), method: (opt && opt.method) || "GET" });
    if (String(url) === "/api/auth/me") return { status: 200, ok: true, json: async () => ({ user: { username: "u", email: "u@x.com" }, tenant: { name: "t" } }) };
    if (String(url) === "/api/auth/key") return { status: 200, ok: true, json: async () => ({ ok: true, key: null }) };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  },
  setTimeout, clearTimeout, TextDecoder, URLSearchParams, AbortController,
  MutationObserver: class { observe() {} disconnect() {} },
});
vm.runInContext(src, ctx, { filename: "settings.js" });
await flush();

const list = dom.el("acctList");
const status = dom.el("acctStatus");
const modal = dom.el("revokeModal");
const body = dom.el("revokeBody");
const cancel = dom.el("revokeCancel");
const confirm = dom.el("revokeConfirm");

/* ---- 清单渲染 ---- */
const rendered = list.innerHTML || "";
ok("mock 清单渲染出来了", rendered.length > 0, "innerHTML 为空");
ok("含 SS-GTM 数据源", /SS-GTM/.test(rendered));
ok("含 Meta 数据源", /Meta/.test(rendered));
ok("含 MCP 数据源", /MCP/.test(rendered));
ok("每条都带授权范围 scope", (rendered.match(/acct-scope/g) || []).length === 3, String((rendered.match(/acct-scope/g) || []).length));
ok("每条都带最后更新时间", (rendered.match(/acct-updated/g) || []).length === 3);
ok("有效 → 绿 ok", /acct-badge ok/.test(rendered));
ok("即将过期 → 琥珀 warn", /acct-badge warn/.test(rendered));
ok("需重验 → 红 danger", /acct-badge danger/.test(rendered));
ok("每条都带「解除」按钮", (rendered.match(/acct-revoke/g) || []).length === 3);
ok("状态行说明了这是示例数据（不谎报真实授权）", /示例数据/.test(status.textContent), status.textContent);

/* ---- XSS：mock 里带 & 的那条必须转义 ---- */
ok("特殊字符被转义（&amp;）", /&amp;/.test(rendered) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(rendered), "渲染内容里出现未转义的 &");

/* ---- mock 阶段不真调后端 ---- */
ok("没有去打尚未实现的 /api/auth-accounts", !calls.some((c) => c.url.indexOf("/api/auth-accounts") >= 0),
  JSON.stringify(calls));

/* ---- 解除流程：弹「解除影响提醒」 ---- */
list.dispatch("click", { target: { closest: () => ({ getAttribute: () => "acc_meta_01" }) } });
await flush();
ok("点「解除」弹出确认框", modal.style.display === "flex", modal.style.display);
ok("询问里点名了要解除的账户", /Meta/.test(body.textContent), body.textContent.slice(0, 60));
ok("含「解除影响」提醒", /解除影响/.test(body.textContent));
ok("影响提醒写清了停止回传", /停止回传|不再归集/.test(body.textContent));
ok("影响提醒写清了已生成结果不受影响", /已生成的归因结果不受影响/.test(body.textContent));
ok("影响提醒给出了恢复路径", /重新授权/.test(body.textContent));

/* ---- 取消：不能误删 ---- */
const beforeCancel = (list.innerHTML.match(/acct-item/g) || []).length;
cancel.dispatch("click");
await flush();
ok("点取消关闭弹框", modal.style.display === "none", modal.style.display);
ok("点取消不删除任何一条", (list.innerHTML.match(/acct-item/g) || []).length === beforeCancel);

/* ---- 确认：真的移除 ---- */
list.dispatch("click", { target: { closest: () => ({ getAttribute: () => "acc_meta_01" }) } });
await flush();
confirm.dispatch("click");
await flush();
ok("确认后弹框关闭", modal.style.display === "none", modal.style.display);
ok("确认后剩 2 条", (list.innerHTML.match(/acct-item/g) || []).length === 2, String((list.innerHTML.match(/acct-item/g) || []).length));
ok("被解除的那条不再出现", !/acc_meta_01/.test(list.innerHTML));

/* ---- 点遮罩关闭（不解除） ---- */
list.dispatch("click", { target: { closest: () => ({ getAttribute: () => "acc_mcp_01" }) } });
await flush();
modal.dispatch("click", { target: modal });
await flush();
ok("点遮罩关闭且不误删", modal.style.display === "none" && (list.innerHTML.match(/acct-item/g) || []).length === 2);

console.log("\n账户授权（非 GA）回归：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）");
process.exit(fail ? 1 : 0);
