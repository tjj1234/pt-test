/**
 * 对话隔离回归测试。
 *
 * 老办法：仓库无 jsdom，用「最小 DOM 桩 + vm」把真实的 shell/public/app.js 跑起来，
 * 配一个可控的内存后端（含可手动推送的 SSE 流），验证的是真代码。
 *
 * 覆盖：
 *   Bug A  A 生成期间切到 B：A 的结果回来后只标未读，绝不覆盖 B 的视图
 *           —— 流式 / 非流式 / 请求异常 三条路径都验；没切走、切到别的页面两种对照也验。
 *   Bug B  技能「去使用」（gotoChatWithQuestion）总是新开对话，不再默默复用旧对话
 *           —— 新建、复用已有空对话、创建失败三种情况都验。
 *
 * 跑法：node tests/regression/ui-conversation-isolation-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDomStub } from "../helpers/dom-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, "../../shell/public/app.js");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

const dom = makeDomStub();
const chatEl = dom.el("chat");
const convListEl = dom.el("convList");

/* ---------------- 内存后端 ---------------- */
const db = {
  convs: {
    A: [{ role: "user", text: "问A" }, { role: "assistant", text: "答A" }],
    B: [{ role: "user", text: "问B" }, { role: "assistant", text: "答B" }],
  },
  list: [],
  created: 0,
  createFails: false,
  chatMode: "sse",       // "sse" | "json"
  chatJson: null,
  chatThrows: false,
  sse: null,
};

function res(obj, code) {
  return {
    ok: (code || 200) < 400, status: code || 200,
    headers: { get: () => "application/json" },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}

/** 一条可以手动推事件的 SSE 响应：db.sse.push(obj) 发一段，db.sse.end() 收流。 */
function sseResponse() {
  const q = [];
  let waiter = null;
  const enc = new TextEncoder();
  const reader = {
    read() {
      if (q.length) {
        const s = q.shift();
        if (s === null) return Promise.resolve({ done: true, value: undefined });
        return Promise.resolve({ done: false, value: enc.encode(s) });
      }
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
  const emit = (chunk) => {
    if (waiter) { const w = waiter; waiter = null; w({ done: false, value: enc.encode(chunk) }); }
    else q.push(chunk);
  };
  db.sse = {
    // 真实服务端发完 done 就关流；桩也照做，否则 runChat 的 while 会一直挂在 read() 上
    push(obj) {
      emit("data: " + JSON.stringify(obj) + "\n\n");
      if (obj && obj.done) this.end();
    },
    end() { if (waiter) { const w = waiter; waiter = null; w({ done: true, value: undefined }); } else q.push(null); },
  };
  return {
    ok: true, status: 200,
    headers: { get: () => "text/event-stream" },
    body: { getReader: () => reader },
  };
}

async function fakeFetch(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  if (u === "/api/conversations" && method === "GET") return res({ ok: true, conversations: db.list });
  if (u === "/api/conversations" && method === "POST") {
    if (db.createFails) return res({ ok: false, error: "创建失败（模拟）" }, 500);
    db.created++;
    const id = "NEW" + db.created;
    db.convs[id] = [];
    db.list.push({ id, title: "新对话", preview: "", msgCount: 0, updated_at: Date.now() });
    return res({ ok: true, id });
  }
  const m = u.match(/^\/api\/conversations\/(.+)$/);
  if (m && method === "GET") {
    const id = decodeURIComponent(m[1]);
    if (!(id in db.convs)) return res({ ok: false, error: "not found" }, 404);
    return res({ ok: true, conversation: { id, messages: db.convs[id] } });
  }
  if (u === "/api/chat") {
    if (db.chatThrows) throw new Error("网络断了");
    if (db.chatMode === "json") {
      // 故意慢一点：给测试留出「结果回来之前先把对话切走」的窗口，否则跑太快根本复现不了
      await new Promise((r) => setTimeout(r, 60));
      return res(db.chatJson || { ok: true, turns: 1, messages: [{ role: "assistant", text: "JSON回复" }] });
    }
    return sseResponse();
  }
  if (u === "/api/tools") return res({ ok: true, tools: [] });
  if (u === "/api/skills") return res({ ok: true, skills: [] });
  if (u === "/api/models") return res({ ok: true, models: [] });
  if (u === "/api/me") return res({ ok: true, user: { id: "u1" }, tenant: { id: "t1" } });
  return res({ ok: true });
}

/* ---------------- 把 app.js 真跑起来 ---------------- */
const ctx = vm.createContext({
  console,
  document: dom.document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  window: { ICONS: {}, initIcons() {}, innerWidth: 1200, addEventListener() {} },
  location: { search: "", href: "http://local/", assign: () => {} },
  navigator: {},
  fetch: fakeFetch,
  alert: () => {}, confirm: () => false, prompt: () => null,
  FileReader: class { readAsDataURL() { setTimeout(() => { this.result = "data:text/plain;base64,aGk="; if (this.onload) this.onload(); }, 0); } },
  Event: dom.Event,
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  TextDecoder, TextEncoder,
});
vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
const run = (src) => vm.runInContext(src, ctx);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

const reset = (list, activeId) =>
  run("(function(){ state.list = " + JSON.stringify(list) +
      "; state.activeId = " + JSON.stringify(activeId) +
      "; state.loadedId = null; state.unread = {}; state.busy = false; })()");
const unreadKeys = () => JSON.stringify(run("Object.keys(state.unread)"));
const activeId = () => run("state.activeId");
const taValue = () => String(dom.el("ta").value || "");

/** 把 #chat 子树里的文字全拼出来 —— 用来判断视图有没有被别人覆盖 */
function chatTexts() {
  const walk = (el) => {
    let s = el.textContent ? String(el.textContent) : "";
    (el.children || []).forEach((c) => { s += "\n" + walk(c); });
    return s;
  };
  return walk(chatEl);
}
function convItems() {
  const out = [];
  const walk = (el) => {
    if (String(el.className).indexOf("conv-item") === 0) out.push(el);
    (el.children || []).forEach(walk);
  };
  walk(convListEl);
  return out;
}
function hasDot(item) {
  let found = false;
  const walk = (el) => { if (el.className === "conv-dot") found = true; (el.children || []).forEach(walk); };
  walk(item);
  return found;
}

const TWO = () => [
  { id: "A", title: "对话A", preview: "问A", msgCount: 2, updated_at: Date.now() },
  { id: "B", title: "对话B", preview: "问B", msgCount: 2, updated_at: Date.now() },
];

console.log("\n[0] 源码层面：修的是根因，不是补丁");
{
  const src = readFileSync(APP_JS, "utf8");
  ok("runChat 记住了这条请求是替哪个对话发的",
    /const targetId = payload\.conversationId \|\| state\.activeId;/.test(src));
  ok("结果回来时比对「现在显示的还是不是它」", /isViewing\(targetId\)/.test(src));
  ok("gotoChatWithQuestion 不再「activeId 非空就复用旧对话」", !/if \(state\.activeId\) fill\(\)/.test(src));
}

console.log("\n[1] Bug A（流式）：A 生成中切到 B，A 的结果不覆盖 B");
{
  db.list = TWO();
  reset(db.list, "A");
  run("state.loadedId = 'A'");
  db.chatMode = "sse"; db.chatThrows = false;

  const p = run("runChat({conversationId:'A', message:'问A'})");
  await tick();
  ok("请求已发出，正在等流", !!db.sse);

  db.sse.push({ delta: "A正在回答" });
  await tick();
  ok("还停在 A 上时打字机正常渲染", /A正在回答/.test(chatTexts()), chatTexts());

  // 关键动作：A 还在生成，用户切到 B
  await run("openConversation('B')");
  ok("已切到 B，右侧是 B 的内容", /答B/.test(chatTexts()), chatTexts());
  const before = chatTexts();

  db.convs["A"] = [{ role: "user", text: "问A" }, { role: "assistant", text: "A的完整回复" }];
  db.sse.push({ done: true, ok: true, turns: 1, messages: db.convs["A"] });
  await p;

  const after = chatTexts();
  ok("A 的结果回来后，B 的视图一个字都没变", after === before, "after=" + JSON.stringify(after));
  ok("B 里没有混进 A 的回复", !/A的完整回复|A正在回答/.test(after), after);
  ok("A 被标记为未读", run("!!state.unread['A']") === true);
  ok("未读里只有 A", unreadKeys() === '["A"]', unreadKeys());

  const items = convItems();
  ok("侧边栏给 A 挂了「有新回复」圆点", items.length >= 2 && hasDot(items[0]), "items=" + items.length);
  ok("当前正在看的 B 不挂圆点", items.length >= 2 && !hasDot(items[1]));

  // 点回 A 要能拿到真内容（因为结果没写进视图，必须靠重新拉取）
  await run("openConversation('A')");
  ok("点回 A 能拿到 A 的真实内容", /A的完整回复/.test(chatTexts()), chatTexts());
  ok("点回 A 后未读标记清除", run("!!state.unread['A']") === false);
}

console.log("\n[2] 对照：没切走时结果照常渲染");
{
  db.list = TWO();
  reset(db.list, "A");
  run("state.loadedId = 'A'");
  db.chatMode = "sse";
  const p = run("runChat({conversationId:'A', message:'问A'})");
  await tick();
  db.sse.push({ done: true, ok: true, turns: 2, messages: [{ role: "assistant", text: "正常渲染的回复" }] });
  await p;
  ok("没切走时结果正常写进视图", /正常渲染的回复/.test(chatTexts()), chatTexts());
  ok("没切走时不标未读", unreadKeys() === "[]", unreadKeys());
}

console.log("\n[3] 对照：切到别的页面（不是别的对话）也照常渲染");
{
  db.list = TWO();
  reset(db.list, "A");
  run("state.loadedId = 'A'");
  db.chatMode = "sse";
  const p = run("runChat({conversationId:'A', message:'问A'})");
  await tick();
  run("switchView('flows')");       // 换页不改 activeId，回来还得能看到结果
  ok("页面标题已切走", dom.el("title").textContent === "业务流库", dom.el("title").textContent);
  db.sse.push({ done: true, ok: true, turns: 1, messages: [{ role: "assistant", text: "切页面也该渲染" }] });
  await p;
  ok("切到别的页面时结果仍写进 A（回来能看到）", /切页面也该渲染/.test(chatTexts()), chatTexts());
  ok("不误标未读", unreadKeys() === "[]", unreadKeys());
}

console.log("\n[4] 非流式（JSON）返回同样不覆盖 B");
{
  db.list = TWO();
  reset(db.list, "A");
  run("state.loadedId = 'A'");
  db.chatMode = "json";
  db.chatJson = { ok: true, turns: 1, messages: [{ role: "assistant", text: "JSON回复" }] };
  const p = run("runChat({conversationId:'A', message:'问A'})");
  await tick(10);                       // 后端故意慢 60ms，这里先切走对话
  await run("openConversation('B')");
  const before = chatTexts();
  ok("切走时 A 的结果还没回来", !/JSON回复/.test(before), before);
  await p;
  ok("非流式返回也不覆盖 B", chatTexts() === before, chatTexts());
  ok("非流式返回同样标未读", run("!!state.unread['A']") === true);
}

console.log("\n[5] 请求异常时不往别的对话里插错误气泡");
{
  db.list = TWO();
  reset(db.list, "A");
  run("state.loadedId = 'A'");
  db.chatMode = "sse"; db.chatThrows = true;
  const p = run("runChat({conversationId:'A', message:'问A'})");
  await tick();
  await run("openConversation('B')");
  const before = chatTexts();
  await p;
  ok("异常时不覆盖 B", chatTexts() === before, chatTexts());
  ok("异常时不把「请求出错」插到 B 里", !/请求出错/.test(chatTexts()), chatTexts());
  db.chatThrows = false;
}

console.log("\n[6] Bug B：技能「去使用」总是新开对话");
{
  db.created = 0;
  db.createFails = false;
  db.list = [{ id: "A", title: "老对话", preview: "聊过", msgCount: 5, updated_at: Date.now() }];
  reset(db.list, "A");
  dom.el("ta").value = "";
  await run("gotoChatWithQuestion('分析一下上周的投放')");
  ok("确实新建了一条对话", db.created === 1, "created=" + db.created);
  ok("不再复用原来那条老对话", activeId() !== "A", activeId());
  ok("问题被预填进输入框", taValue() === "分析一下上周的投放", taValue());
}

console.log("\n[7] Bug B：已有空对话时复用它，不堆空记录");
{
  db.created = 0;
  db.list = [
    { id: "A", title: "老对话", preview: "聊过", msgCount: 5, updated_at: Date.now() },
    { id: "E", title: "新对话", preview: "", msgCount: 0, updated_at: Date.now() },
  ];
  reset(db.list, "A");
  dom.el("ta").value = "";
  await run("gotoChatWithQuestion('问题Y')");
  ok("没再新建（复用了那条空的）", db.created === 0, "created=" + db.created);
  ok("切到了那条空对话", activeId() === "E", activeId());
  ok("问题照样预填", taValue() === "问题Y", taValue());
}

console.log("\n[8] Bug B：创建失败时不默默塞进旧对话");
{
  db.createFails = true;
  db.list = [{ id: "A", title: "老对话", preview: "聊过", msgCount: 5, updated_at: Date.now() }];
  reset(db.list, "A");
  dom.el("ta").value = "原来在打的字";
  chatEl.children.length = 0;
  await run("gotoChatWithQuestion('问题Z')");
  ok("创建失败时不切对话", activeId() === "A", activeId());
  ok("创建失败时给提示", /无法新建对话/.test(chatTexts()), chatTexts());
  ok("创建失败时不覆盖输入框里正在打的字", taValue() === "原来在打的字", taValue());
  db.createFails = false;
}

console.log("\n结果：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
