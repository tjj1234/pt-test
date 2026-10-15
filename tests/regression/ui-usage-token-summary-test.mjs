/**
 * 用量与日志页顶部「Token 数据暂缺」回归测试（对应 A2/A5 的 chat_usage 汇总）。
 *
 * 背景：旧的汇总把「没有 token 数据」诚实标成 null（DSH 协议本身不返回该数据），
 * 但旧写法 `Number(c.tokenCount) || 0` 把 null 当 0 累加，显示「0 Tokens」，
 * 看着像「测出来零消耗」，实际是「压根没测」。
 *
 * 新版把 token 汇总从 tool_calls 单条记录里拆出来，落独立的 chat_usage 表，
 * 由 GET /api/usage/summary 返回 today/month/byModel 聚合；前端渲染成「今日/本月」卡片。
 * 这里要守住同一条规则：卡片必须能区分「范围内压根没有 usage 记录」（显示「暂缺」）
 * 和「有记录但汇总出来真的是 0」（显示「0」），不能把 null/空表伪装成 0。
 *
 * 老办法：仓库无 jsdom，用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 配内存版 /api/usage/tool-calls 与 /api/usage/summary，验证真代码（bizLoadUsage → bizUsageRenderCards）。
 *
 * 覆盖：
 *   1. bizUsageRenderCards：无记录(count=0) → 暂缺；有记录但真 0 → 0；有真实值 → 数字。
 *   2. summary 为 null / 字段缺失 → 暂缺，绝不出现「0」。
 *   3. bizLoadUsage 拉两个接口：状态行只报调用次数，token 汇总落到卡片。
 *   4. 接口报错 → 卡片清空；summary 404 → 回退示例（带 count）仍显示数字。
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
const db = { usageBody: null, usageMode: "ok", summaryBody: null, summaryMode: "ok" };
function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}
function mkCall(i) {
  return {
    id: "c" + (i == null ? 0 : i),
    timestamp: "2026-10-13T08:30:00.000Z",
    toolName: "ga.query",
    category: "Workflow",
    modelName: null,
    inputSummary: "最近广告数据",
    outputSummary: "分析已完成",
    durationMs: 240,
    status: "success",
  };
}
async function fakeFetch(url) {
  const u = String(url);
  if (u.indexOf("/api/usage/summary") === 0) {
    if (db.summaryMode === "404") return res({ ok: false, error: "Not Found" }, 404);
    return res(db.summaryBody);
  }
  if (u.indexOf("/api/usage/tool-calls") === 0) {
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
  Node: class NodeStub {},
});
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const usageStatus = () => String(ctx.document.querySelector("#usageStatus").textContent || "");
/** 取「用量卡片」里指定 label 卡片的数值文本（找不到返回 null）。 */
const cardValue = (label) => {
  const host = ctx.document.querySelector("#usageCards");
  for (const card of host.children) {
    if (card.children && card.children[0] && card.children[0].textContent === label) {
      const val = card.children[1];
      return val == null || val.textContent == null ? null : String(val.textContent);
    }
  }
  return null;
};
const modelBlocks = () => ctx.document.querySelector("#usageModels").children.length;

console.log("\n[1] 卡片区分「无记录(暂缺)」「有记录但真是 0」「有真实值」");
{
  run(`bizUsageRenderCards({ today: { totalTokens: 0, count: 0 }, month: { totalTokens: 0, count: 0 }, byModel: [] })`);
  ok("今日无记录 → 暂缺", cardValue("今日 Tokens") === "暂缺", cardValue("今日 Tokens"));
  ok("本月无记录 → 暂缺", cardValue("本月 Tokens") === "暂缺", cardValue("本月 Tokens"));
}
{
  run(`bizUsageRenderCards({ today: { totalTokens: 0, count: 1 }, month: { totalTokens: 0, count: 2 }, byModel: [] })`);
  ok("今日有记录但汇总真是 0 → 0", cardValue("今日 Tokens") === "0", cardValue("今日 Tokens"));
  ok("本月有记录但汇总真是 0 → 0", cardValue("本月 Tokens") === "0", cardValue("本月 Tokens"));
}
{
  run(`bizUsageRenderCards({ today: { totalTokens: 600, count: 3 }, month: { totalTokens: 820, count: 4 }, byModel: [] })`);
  ok("今日真实值正常显示", cardValue("今日 Tokens") === "600", cardValue("今日 Tokens"));
  ok("本月真实值正常显示", cardValue("本月 Tokens") === "820", cardValue("本月 Tokens"));
}
{
  run(`bizUsageRenderCards(null)`);
  ok("summary 为 null → 今日/本月都暂缺", cardValue("今日 Tokens") === "暂缺" && cardValue("本月 Tokens") === "暂缺", cardValue("今日 Tokens") + "/" + cardValue("本月 Tokens"));
}
{
  run(`bizUsageRenderCards({ today: { totalTokens: 500 }, month: { totalTokens: 900 }, byModel: [] })`);
  ok("字段缺失 count 同样按暂缺处理（不把缺 count 当 0 显示）", cardValue("今日 Tokens") === "暂缺" && cardValue("本月 Tokens") === "暂缺", cardValue("今日 Tokens") + "/" + cardValue("本月 Tokens"));
}

console.log("\n[2] 模型分布只在有数据时渲染");
{
  run(`bizUsageRenderModels({ byModel: [{ model: "deepseek-chat", totalTokens: 300, calls: 2 }] })`);
  ok("有模型数据时渲染 1 块", modelBlocks() === 1, String(modelBlocks()));
  run(`bizUsageRenderModels({ byModel: [] })`);
  ok("无模型数据时不渲染", modelBlocks() === 0, String(modelBlocks()));
}

console.log("\n[3] bizLoadUsage 拉 tool-calls + summary，状态行只报调用次数");
{
  db.usageMode = "ok";
  db.usageBody = { ok: true, calls: [mkCall(0), mkCall(1)] };
  db.summaryMode = "ok";
  db.summaryBody = { ok: true, summary: { today: { totalTokens: 300, count: 2 }, month: { totalTokens: 300, count: 2 }, byModel: [{ model: "deepseek-chat", totalTokens: 300, calls: 2 }] } };
  await run("bizLoadUsage()");
  ok("状态行显示调用次数（不再混 token 汇总）", usageStatus() === "2 次调用", usageStatus());
  ok("卡片显示今日汇总", cardValue("今日 Tokens") === "300", cardValue("今日 Tokens"));
}
{
  db.usageBody = { ok: true, calls: [] };
  db.summaryBody = { ok: true, summary: { today: { totalTokens: 0, count: 0 }, month: { totalTokens: 0, count: 0 }, byModel: [] } };
  await run("bizLoadUsage()");
  ok("无调用时状态行文案", usageStatus() === "所选时间范围内没有工具调用", usageStatus());
  ok("无记录时卡片暂缺", cardValue("今日 Tokens") === "暂缺" && cardValue("本月 Tokens") === "暂缺", cardValue("今日 Tokens") + "/" + cardValue("本月 Tokens"));
}

console.log("\n[4] 错误路径与示例回退");
{
  db.summaryMode = "ok";
  db.summaryBody = { ok: false, error: "读取失败" };
  db.usageBody = { ok: true, calls: [] };
  await run("bizLoadUsage()");
  ok("summary 报错 → 状态行显示错误", usageStatus() === "读取失败", usageStatus());
  ok("报错时卡片清空", cardValue("今日 Tokens") === null, cardValue("今日 Tokens"));
  db.summaryBody = null;
}
{
  db.summaryMode = "404"; // summary 接口未接入 → 回退示例（示例带 count>0）
  db.usageBody = { ok: true, calls: [mkCall(0)] };
  await run("bizLoadUsage()");
  ok("summary 404 回退示例仍显示真实数字", cardValue("今日 Tokens") === "1,200", cardValue("今日 Tokens"));
  db.summaryMode = "ok";
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
