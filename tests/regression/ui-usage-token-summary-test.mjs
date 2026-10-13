/**
 * 用量与日志页顶部汇总「Token 数据暂缺」回归测试。
 *
 * 背景：后端已把「没有 token 数据」诚实标成 null（DSH 协议本身不返回该数据），
 * 但顶部汇总旧写法 `Number(c.tokenCount) || 0` 把 null 当 0 累加，显示「0 Tokens」，
 * 看着像「测出来零消耗」，实际是「压根没测」——与后端想修的是同一类误导。
 *
 * 老办法：仓库无 jsdom，用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 配内存版 /api/usage/tool-calls，验证的是真代码（bizLoadUsage → bizTokenSummary）。
 *
 * 覆盖：
 *   1. 全 null / 字段缺失 → 汇总显示「Token数据暂缺」，绝不出现「0 Tokens」。
 *   2. 有真实数据（部分或全部）→ 正常求和显示；真实测出的 0 也正常显示「0 Tokens」。
 *   3. 单条记录那一行仍是原始值透传（null → 「—」），没有被顺手改掉。
 *   4. 空列表 / 示例数据（mock 回退）路径的文案不受影响。
 *
 * 跑法：node tests/regression/ui-usage-token-summary-test.mjs
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
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } },
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
const db = { usageBody: null, usageMode: "ok", usageCalls: 0 };
function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}
function mkCall(tokenCount, i) {
  const c = {
    id: "c" + (i == null ? 0 : i),
    timestamp: "2026-10-13T08:30:00.000Z",
    toolName: "ga.query",
    inputSummary: "最近广告数据",
    outputSummary: "分析已完成",
    durationMs: 240,
    status: "success",
  };
  if (tokenCount !== undefined) c.tokenCount = tokenCount; // undefined = 字段整个缺失
  return c;
}
async function fakeFetch(url) {
  const u = String(url);
  if (u.indexOf("/api/usage/tool-calls") === 0) {
    db.usageCalls++;
    if (db.usageMode === "404") return res({ ok: false, error: "Not Found" }, 404);
    return res(db.usageBody);
  }
  if (u === "/api/tools") return res({ ok: true, tools: [] });
  if (u === "/api/skills") return res({ ok: true, skills: [] });
  if (u === "/api/conversations") return res({ ok: true, conversations: [] });
  if (u === "/api/models") return res({ ok: true, models: [] });
  if (u === "/api/me") return res({ ok: true, user: { id: "u1" }, tenant: { id: "t1" } });
  if (u === "/api/workspaces/enabled-status") return res({ ok: true, workspaceId: "ws-1", features: { attributionEnabled: true }, firstConnectedAt: null, updatedAt: null });
  return res({ ok: true });
}

/* ---------------- 把 app.js 真跑起来 ---------------- */
const ctx = vm.createContext({
  console, document, localStorage,
  window: { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {} },
  location: { search: "", href: "http://local/", assign: () => {} },
  navigator: {},
  fetch: fakeFetch,
  alert: () => {},
  confirm: () => false,
  prompt: () => null,
  FileReader: class { readAsDataURL() {} },
  Event: EventStub,
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  // app.js 的 bizTable 用 `c instanceof Node` 分流；vm 里必须提供，否则渲染表格直接 ReferenceError
  Node: class NodeStub {},
});
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const usageStatus = () => String(ctx.document.querySelector("#usageStatus").textContent || "");
/** 取 usageList 表格第 rowIdx 行第 5 列（Tokens 列）的文本 */
const tokenCell = (rowIdx) => {
  const table = ctx.document.querySelector("#usageList").children[0];
  const tbody = table.children[1];
  return String(tbody.children[rowIdx].children[5].textContent || "");
};

console.log("\n[1] 全 null（后端现状）→ 「Token数据暂缺」，不是「0 Tokens」");
{
  db.usageMode = "ok";
  db.usageBody = { ok: true, calls: [mkCall(null, 0), mkCall(null, 1), mkCall(null, 2)] };
  await run("bizLoadUsage()");
  ok("显示调用次数", /^3 次调用/.test(usageStatus()), usageStatus());
  ok("显示「Token数据暂缺」", /Token数据暂缺/.test(usageStatus()), usageStatus());
  ok("绝不出现「0 Tokens」", !/0 Tokens/.test(usageStatus()), usageStatus());
  ok("连「Tokens」字样都不出现", !/Tokens/.test(usageStatus()), usageStatus());
}
{
  db.usageBody = { ok: true, calls: [mkCall(undefined, 0), mkCall(undefined, 1)] };
  await run("bizLoadUsage()");
  ok("字段整个缺失同样按暂缺处理", /2 次调用 · Token数据暂缺/.test(usageStatus()) && !/0 Tokens/.test(usageStatus()), usageStatus());
}
{
  const s = run("bizTokenSummary([{tokenCount:null},{tokenCount:null}])");
  ok("helper 单测：全 null → 暂缺", s === "Token数据暂缺", s);
  const s2 = run("bizTokenSummary([])");
  ok("helper 单测：空数组 → 暂缺（不会画蛇头添 0）", s2 === "Token数据暂缺", s2);
}

console.log("\n[2] 有真实数据 → 正常求和");
{
  db.usageBody = { ok: true, calls: [mkCall(100, 0), mkCall(200, 1), mkCall(300, 2)] };
  await run("bizLoadUsage()");
  ok("全真实值精确求和", usageStatus() === "3 次调用 · 600 Tokens", usageStatus());

  db.usageBody = { ok: true, calls: [mkCall(380, 0), mkCall(null, 1), mkCall(440, 2)] };
  await run("bizLoadUsage()");
  ok("部分 null 不影响有数据时的求和（null 按 0 计入）", usageStatus() === "3 次调用 · 820 Tokens", usageStatus());

  db.usageBody = { ok: true, calls: [mkCall(0, 0)] };
  await run("bizLoadUsage()");
  ok("真实测出的 0 正常显示「0 Tokens」（这才是真的是 0）", usageStatus() === "1 次调用 · 0 Tokens", usageStatus());

  const s = run("bizTokenSummary([{tokenCount:5},{tokenCount:7}])");
  ok("helper 单测：求和", s === "12 Tokens", s);
}

console.log("\n[3] 单条记录那一行仍是原始值透传（这次只改汇总）");
{
  db.usageBody = { ok: true, calls: [mkCall(null, 0), mkCall(380, 1)] };
  await run("bizLoadUsage()");
  ok("null 的 Tokens 单元格透传为「—」", tokenCell(0) === "—", tokenCell(0));
  ok("真实值原样透传", tokenCell(1) === "380", tokenCell(1));
  const src = readFileSync(APP_JS, "utf8");
  ok("透传行仍是裸 c.tokenCount（没被顺手加 || 0）", /, c\.tokenCount,/.test(src));
  ok("旧的内联 reduce 写法已移除", src.indexOf("calls.reduce((n, c) => n + (Number(c.tokenCount) || 0), 0)") < 0);
}

console.log("\n[4] 其他路径不受影响");
{
  db.usageBody = { ok: true, calls: [] };
  await run("bizLoadUsage()");
  ok("空列表文案不变", usageStatus() === "所选时间范围内没有工具调用", usageStatus());

  db.usageMode = "404"; // 接口未接入 → 回退示例数据（带真实 tokenCount）
  await run("bizLoadUsage()");
  ok("示例数据仍正常求和并带 mock 前缀", /^示例数据 · 日志接口待接入。1 次调用 · 380 Tokens$/.test(usageStatus()), usageStatus());
  db.usageMode = "ok";

  db.usageBody = { ok: false, error: "读取失败" };
  await run("bizLoadUsage()");
  ok("接口报错时仍是错误文案（不画蛇头添汇总）", usageStatus() === "读取失败", usageStatus());
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
