/**
 * 业务流库「启用状态 + 启用按钮跳转」回归测试。
 *
 * 老办法：仓库无 jsdom，用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 配内存版 /api/workspaces/enabled-status（返回形状对齐基座 workspace-enabled-status.cjs
 * 的 normalizeEnabledStatus），验证的是真代码。
 *
 * 覆盖：
 *   1. 启用状态来自真实接口，不再写死「示例状态」；已启用/未启用文案正确并显示首次接入时间。
 *   2. 故障（502 业务线不可用 / 503 密钥没配 / 401）只说「读不到」，绝不伪装成「未启用」。
 *   3. 「启用」按钮真的跳：未启用 → 广告数据导入页；已启用 → 归因面板；状态未知 → 不瞎跳。
 *   4. data-onboarding-path 覆盖仍然生效（外部跳转的逃生口）。
 *
 * 跑法：node tests/regression/ui-flows-enable-real-status-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag) {
  const listeners = Object.create(null);
  let _html = "";
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    src: "", title: "", alt: "", disabled: false, files: null,
    scrollTop: 0, scrollHeight: 0, style: {}, dataset: {}, accept: "",
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(child) { el.children.push(child); return child; },
    append(...cs) { cs.forEach((c) => el.children.push(c)); },
    remove() {}, removeAttribute() {}, setAttribute() {},
    replaceChildren() { el.children.length = 0; }, replaceWith() {}, insertBefore() {},
    cloneNode() { return makeEl(); },
    matches() { return false; }, scrollIntoView() {}, contains() { return false; },
    children: [], firstChild: null, lastChild: null, parentNode: null,
    _q: null,
    querySelector(sel) {
      el._q = el._q || new Map();
      if (!el._q.has(sel)) el._q.set(sel, makeEl());
      return el._q.get(sel);
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    insertAdjacentHTML() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return _html; },
    set(v) { _html = String(v); if (_html === "") el.children.length = 0; },
  });
  return el;
}

const elCache = new Map();
const document = {
  body: makeEl("body"),
  querySelector(sel) {
    if (!elCache.has(sel)) { const e = makeEl(); e.id = String(sel).replace(/^#/, ""); elCache.set(sel, e); }
    return elCache.get(sel);
  },
  querySelectorAll() { return []; },
  // app.js 的导入页用的是 getElementById（impEl），桩里补上并复用同一份缓存
  getElementById(id) { return document.querySelector("#" + String(id)); },
  createElement(t) { return makeEl(t); },
  addEventListener() {}, removeEventListener() {},
};
const lsStore = new Map();
const localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};
class EventStub { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } }

/* ---------------- 内存版后端 ---------------- */
const db = { status: null, statusCalls: 0, toolCalls: 0, lastChat: null };
const assigned = [];
function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}
/** 造一个符合 normalizeEnabledStatus 形状的返回体 */
function statusBody(enabled, at) {
  return {
    ok: true,
    workspaceId: "ws-1",
    features: { attributionEnabled: enabled },
    firstConnectedAt: at || null,
    updatedAt: at || null,
  };
}
async function fakeFetch(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  if (u === "/api/workspaces/enabled-status") {
    db.statusCalls++;
    if (db.status === "ok-on") return res(statusBody(true, "2026-10-01T08:30:00.000Z"));
    if (db.status === "ok-off") return res(statusBody(false, null));
    if (db.status === "bad-shape") return res({ ok: true, workspaceId: "ws-1" });            // 缺 features
    if (db.status === "502") return res({ ok: false, error: "业务线服务不可用" }, 502);
    if (db.status === "503") return res({ ok: false, error: "内部密钥 PT_DASH_INTERNAL_KEY 未配置" }, 503);
    if (db.status === "401") return res({ ok: false, error: "没登录" }, 401);
    if (db.status === "404") return res({ ok: false, error: "Not Found" }, 404);
  }
  if (u === "/api/tools") { db.toolCalls++; return res({ ok: true, tools: [] }); }
  if (u === "/api/skills") return res({ ok: true, skills: [] });
  if (u === "/api/conversations" && method === "GET") return res({ ok: true, conversations: [] });
  if (u === "/api/models") return res({ ok: true, models: [] });
  if (u === "/api/me") return res({ ok: true, user: { id: "u1" }, tenant: { id: "t1" } });
  return res({ ok: true });
}

/* ---------------- 把 app.js 真跑起来 ---------------- */
const ctx = vm.createContext({
  console, document, localStorage,
  window: { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {} },
  location: { search: "", href: "http://local/", assign: (p) => assigned.push(String(p)) },
  navigator: {},
  fetch: fakeFetch,
  alert: () => {},
  confirm: () => false,
  prompt: () => null,
  FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:text/plain;base64,aGk="; if (this.onload) this.onload(); }, 0); } },
  Event: EventStub,
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
});
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const tick = () => new Promise((r) => setTimeout(r, 30));
const flowStatus = () => String(ctx.document.querySelector("#flowStatus").textContent || "");
const flowHint = () => String(ctx.document.querySelector("#flowHint").textContent || "");
const flowBtn = () => String(ctx.document.querySelector("#flowEnable").textContent || "");
const pageTitle = () => String(ctx.document.querySelector("#title").textContent || "");
const clickEnable = () => run("(function(){ document.querySelector('#flowEnable').dispatch('click', {}); })()");

console.log("\n[1] 启用状态来自真实接口，不再写死");
{
  const src = readFileSync(APP_JS, "utf8");
  ok("源码里没有写死的「示例状态（启用查询待接入）」", !/示例状态（启用查询待接入）/.test(src));
  ok("源码里调用 /api/workspaces/enabled-status", src.indexOf('"/api/workspaces/enabled-status"') > 0);

  db.status = "ok-on";
  await run("bizLoadFlowStatus()");
  ok("已启用时文案说「已启用」", /已启用/.test(flowStatus()), flowStatus());
  ok("已启用时显示首次接入时间", /首次接入/.test(flowStatus()) && !/首次接入 —/.test(flowStatus()), flowStatus());
  ok("已启用时不出现「未启用」字样", !/未启用/.test(flowStatus()), flowStatus());
  ok("已启用时按钮变成「去归因面板」", flowBtn() === "去归因面板", flowBtn());
  ok("确实打了真实接口", db.statusCalls === 1, "calls=" + db.statusCalls);

  db.status = "ok-off";
  await run("bizLoadFlowStatus()");
  ok("未启用时文案说「未启用」", /未启用/.test(flowStatus()), flowStatus());
  ok("未启用时不显示首次接入时间", !/首次接入/.test(flowStatus()), flowStatus());
  ok("未启用时按钮是「启用」", flowBtn() === "启用", flowBtn());
}

console.log("\n[2] 故障只说「读不到」，不伪装成「未启用」");
{
  for (const kind of ["502", "503", "401", "404", "bad-shape"]) {
    db.status = kind;
    await run("bizLoadFlowStatus()");
    ok(kind + " 时不显示「已启用」", !/已启用/.test(flowStatus()), flowStatus());
    ok(kind + " 时不谎报「未启用」", !/未启用/.test(flowStatus()), flowStatus());
    ok(kind + " 时明确说读不到", /读不到|格式不正确|失败/.test(flowStatus()), flowStatus());
    ok(kind + " 时把原因写进 #flowHint", flowHint().length > 0, flowHint());
    ok(kind + " 时状态标记为未知（null）", run("bizAttributionEnabled") === null);
  }
}

console.log("\n[3] 「启用」按钮真的跳");
{
  // 未启用 → 广告数据导入页
  db.status = "ok-off";
  await run("bizLoadFlowStatus()");
  run("switchView('home')");
  clickEnable();
  ok("未启用点「启用」跳到「广告数据导入」页", pageTitle() === "广告数据导入", pageTitle());

  // 已启用 → 归因面板
  db.status = "ok-on";
  await run("bizLoadFlowStatus()");
  run("switchView('home')");
  clickEnable();
  ok("已启用点按钮跳到「归因看板」", pageTitle() === "归因看板", pageTitle());

  // 状态未知 → 不瞎跳，只提示
  db.status = "502";
  await run("bizLoadFlowStatus()");
  run("switchView('home')");
  const before = pageTitle();
  clickEnable();
  ok("状态未知时不跳转（停在原页）", pageTitle() === before, pageTitle() + " vs " + before);
  ok("状态未知时提示先刷新重试", /刷新/.test(flowHint()), flowHint());

  // 进入业务流库页会自动拉一次启用状态
  db.statusCalls = 0; db.toolCalls = 0;
  db.status = "ok-on";
  run("bizLoadFlows()");
  await tick();
  ok("进业务流库页自动拉启用状态（与工具列表并行）", db.statusCalls === 1, "status=" + db.statusCalls);
  ok("同时也会拉工具列表", db.toolCalls === 1, "tools=" + db.toolCalls);
}

console.log("\n[4] data-onboarding-path 覆盖仍然生效");
{
  assigned.length = 0;
  db.status = "ok-off";
  await run("bizLoadFlowStatus()");
  const page = ctx.document.querySelector("#v-flows .page");
  page.dataset.onboardingPath = "/some/onboarding";
  clickEnable();
  ok("填了合法路径就跳过去（外部覆盖优先）", assigned.length === 1 && assigned[0] === "/some/onboarding", JSON.stringify(assigned));

  assigned.length = 0;
  page.dataset.onboardingPath = "//evil.example.com";
  clickEnable();
  ok("协议相对地址 // 被拒绝（不当跳转）", assigned.length === 0, JSON.stringify(assigned));

  page.dataset.onboardingPath = "";
  ok("清空后回到默认逻辑", clickEnable() === undefined && pageTitle() === "广告数据导入", pageTitle());
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
