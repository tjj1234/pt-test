/**
 * app.js 的最小运行 harness —— 把**真实的 shell/public/app.js** 塞进 vm 跑起来。
 *
 * 之前每个 UI 测试都自带一份构造逻辑，改一处要动三个文件。这里统一对外暴露 bootApp()：
 *   const app = await bootApp({ conversations: {...} });
 *   await app.awaitRun("openConversation('A')");
 *   app.el("ta").disabled
 *
 * 三个约定：
 *   1. fetch 打到内存里的假后端 db —— 断言走 db.xxxCalls，不靠 mock 函数计数。
 *   2. sessionStorage 可以外部传入，用来模拟「同一个标签页里刷新页面」。
 *   3. 缺 DOM API 就补在这里，不要在测试里 monkey patch（否则桩会分叉）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeDomStub } from "./dom-stub.mjs";

const APP_JS = new URL("../../shell/public/app.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const json = (obj, status) => ({
  ok: (status || 200) < 400,
  status: status || 200,
  headers: { get: () => "application/json" },
  json: async () => obj,
});

/**
 * @param {object} o
 * @param {object} o.conversations  预置对话 { A: {id,title,archived,msgCount,messages...} }
 * @param {object|null} o.route     预置到 sessionStorage 的路由（模拟上次浏览位置）
 * @param {object|null} o.storage   传入已存在的 sessionStorage，模拟刷新页面
 */
export async function bootApp(o = {}) {
  const dom = o.storage ? makeDomStubWith(o.storage) : makeDomStub();
  const db = {
    convs: Object.assign({}, o.conversations || {}),
    chatCalls: [], archiveCalls: [], created: 0,
    detail404: new Set(o.detail404 || []),  // 必须是启动前注入：启动 IIFE 会立刻尝试恢复
    failArchiveOps: false,         // /archive /unarchive 不真的改状态
  };

  const fetchStub = async (url, opt) => {
    const m = String(url);
    const opt2 = opt || {};
    const method = opt2.method || "GET";

    if (m === "/api/conversations" && method === "GET") {
      return json({ ok: true, conversations: Object.values(db.convs) });
    }
    if (m === "/api/conversations" && method === "POST") {
      db.created++;
      const id = "new" + db.created;
      db.convs[id] = { id, title: "新对话", preview: "", msgCount: 0, archived: false, updated_at: Date.now(), messages: [] };
      return json({ ok: true, id, conversation: db.convs[id] });
    }
    if (/\/unarchive$/.test(m) || /\/archive$/.test(m)) {
      const id = decodeURIComponent(m.split("/")[3]);
      const wantArchived = /\/archive$/.test(m);
      db.archiveCalls.push({ id, to: wantArchived ? "archive" : "unarchive" });
      if (!db.failArchiveOps && db.convs[id]) db.convs[id].archived = wantArchived;
      return json({ ok: true, archived: wantArchived });
    }
    const detail = m.match(/^\/api\/conversations\/([^/?]+)$/);
    if (detail && method === "GET") {
      const id = decodeURIComponent(detail[1]);
      if (db.detail404.has(id)) return json({ ok: false, error: "对话不存在" }, 404);
      const c = db.convs[id];
      if (!c) return json({ ok: false, error: "对话不存在" }, 404);
      return json({ ok: true, conversation: { ...c, messages: c.messages || [] } });
    }
    if (m === "/api/chat") { db.chatCalls.push({ body: opt2.body }); return json({ ok: true, turns: 1, messages: [] }); }
    if (m === "/api/skills") return json({ skills: [] });
    if (m === "/api/status") return json({ dashboardOk: true });
    if (m === "/api/models") return json({ models: [] });
    if (m === "/api/auth/key") return json({ ok: true, key: null });
    if (m === "/api/conversations/search") return json({ ok: true, conversations: [] });
    return json({ ok: true });
  };

  if (o.route) {
    dom.sessionStorage.setItem("ptShellRoute", typeof o.route === "string" ? o.route : JSON.stringify(o.route));
  }

  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    ...dom,
    window: { ICONS: {}, addEventListener() {}, getSelection: () => null, open: () => null, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { href: "/", search: "", hash: "", assign() {}, replace() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchStub,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout, clearTimeout,
    TextDecoder, URLSearchParams, AbortController,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0,
    alert: () => {}, confirm: () => true, prompt: () => null,
  });

  vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
  await flush();     // 让启动 IIFE（拉列表 + 路由恢复）先跑完，避免和后面的断言抢时序

  const run = (expr) => vm.runInContext(expr, ctx);
  const awaitRun = async (expr) => { await run(expr); };
  return { db, run, awaitRun, el: dom.el, sessionStorage: dom.sessionStorage, document: dom.document };
}

function makeDomStubWith(storage) {
  const dom = makeDomStub();
  const patched = { ...dom, sessionStorage: storage };
  return patched;
}
