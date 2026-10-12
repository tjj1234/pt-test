/**
 * 第 2 项回归：刷新记住当前位置
 *
 * 根因：启动那段注释写着「自动选中最近一个」，实际永远 switchView("home") ——
 * 注释和实现是反的，刷新就回首页，不管你刚才在哪条对话、哪个 Tab。
 *
 * 用法：node tests/regression/ui-route-memory-test.mjs
 */
import { bootApp, flush } from "../helpers/app-harness.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  -> " + extra : "")); }
};
const READ = "ptShellRoute";
const conv = (id) => ({ id, title: "对话" + id, preview: "…", msgCount: 2, archived: false, updated_at: Date.now(), messages: [{ role: "user", text: "hi", ts: 1 }] });

/* ============ 一组：会不会记 ============ */
{
  const app = await bootApp({ conversations: { A: conv("A"), B: conv("B") } });

  await app.awaitRun("openConversation('B')");
  const raw = app.sessionStorage.getItem(READ);
  const saved = JSON.parse(raw || "null");
  ok("打开对话后记下了位置", !!saved, "raw=" + raw);
  ok("记的是 chat 视图", saved && saved.v === "chat", saved && saved.v);
  ok("记的是这条对话的 id", saved && saved.id === "B", saved && saved.id);

  app.run("switchView('skills')");
  ok("切 Tab 也会更新记录", JSON.parse(app.sessionStorage.getItem(READ) || "null").v === "skills");

  await app.awaitRun("openConversation('A')");
  ok("切回对话会把 id 换成 A", JSON.parse(app.sessionStorage.getItem(READ) || "null").id === "A");
}

/* ============ 二组：真实「刷新」语义（同一份 sessionStorage 换实例） ============ */
{
  const first = await bootApp({ conversations: { A: conv("A"), B: conv("B") } });
  await first.awaitRun("openConversation('B')");
  const second = await bootApp({ conversations: { A: conv("A"), B: conv("B") }, storage: first.sessionStorage });
  await flush();
  ok("刷新后回到原来那条对话", second.run("state.activeId") === "B", second.run("state.activeId"));
  ok("刷新后回到对话视图", second.run("state.view") === "chat", second.run("state.view"));
  ok("刷新后标题是「对话」", second.el("title").textContent === "对话", second.el("title").textContent);
  ok("刷新后内容真拉回来了", second.run("state.loadedId") === "B", second.run("state.loadedId"));
}
{
  const first = await bootApp({ conversations: { A: conv("A") } });
  first.run("switchView('flows')");
  const second = await bootApp({ conversations: { A: conv("A") }, storage: first.sessionStorage });
  await flush();
  ok("刷新后停在同一 Tab", second.run("state.view") === "flows", second.run("state.view"));
  ok("该 Tab 的标题正确", second.el("title").textContent === "业务流库", second.el("title").textContent);
}

/* ============ 三组：兜底回首页，不能卡死或空白 ============ */
{
  // 记住的对话已被删（列表里没有了）
  const app = await bootApp({ conversations: { A: conv("A") }, route: { v: "chat", id: "GONE" } });
  await flush();
  ok("对话被删 → 兜底回首页", app.run("state.view") === "home", app.run("state.view"));
  ok("标题是「首页」而不是空白", app.el("title").textContent === "首页", app.el("title").textContent);
  ok("不会残留一个打不开的 activeId", app.run("state.activeId") === null, String(app.run("state.activeId")));
}
{
  // 列表里还在，但 GET 详情 404（竞态被删的真实场景）—— 404 必须在启动前注入，
  // 否则启动 IIFE 早就恢复成功了，测不到兜底
  const ghost2 = await bootApp({ conversations: { A: conv("A") }, route: { v: "chat", id: "A" }, detail404: ["A"] });
  await flush();
  ok("详情 404 → 兜底回首页", ghost2.run("state.view") === "home", ghost2.run("state.view"));
  ok("详情 404 不留白屏", ghost2.el("title").textContent === "首页", ghost2.el("title").textContent);
}
{
  const app = await bootApp({});
  ok("没有任何记录 → 首页", app.run("state.view") === "home", app.run("state.view"));
}
{
  const broken = await bootApp({ conversations: { A: conv("A") }, route: "{不是JSON" });
  ok("记录损坏（非法 JSON）→ 首页", broken.run("state.view") === "home", broken.run("state.view"));
}
{
  const ghost = await bootApp({ conversations: { A: conv("A") }, route: { v: "已经下线的Tab", id: null } });
  ok("记录里的视图已不存在 → 首页（不猜）", ghost.run("state.view") === "home", ghost.run("state.view"));
}
{
  const noId = await bootApp({ conversations: { A: conv("A") }, route: { v: "chat", id: null } });
  ok("chat 但没记 id → 首页", noId.run("state.view") === "home", noId.run("state.view"));
}
{
  const home = await bootApp({ conversations: { A: conv("A") }, route: { v: "home", id: null } });
  ok("本来就在首页（不是归档对话）→ 留在首页", home.run("state.view") === "home", home.run("state.view"));
}

/* ============ 四组：和第 1 项交叉 —— 归档对话刷新回来仍是只读 ============ */
{
  const arc = { id: "A", title: "归档的", preview: "…", msgCount: 1, archived: true, updated_at: Date.now(), messages: [] };
  const first = await bootApp({ conversations: { A: arc } });
  await first.awaitRun("openConversation('A')");
  ok("刷新前是只读", first.el("ta").disabled === true);

  const second = await bootApp({ conversations: { A: { ...arc } }, storage: first.sessionStorage });
  await flush();
  ok("刷新后回到归档对话", second.run("state.activeId") === "A", second.run("state.activeId"));
  ok("刷新后仍然只读（不是刷新就能钻空子）", second.el("ta").disabled === true, "disabled=" + second.el("ta").disabled);
  ok("刷新后提示条照样亮", second.el("archBanner").hidden === false, "hidden=" + second.el("archBanner").hidden);
}

console.log("\n刷新记路由回归：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）");
process.exit(fail ? 1 : 0);
