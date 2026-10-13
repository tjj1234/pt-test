/**
 * 回归：设置页「广告与数据源授权」（非 GA 部分）
 *
 * 2026-10-13 重写（上一版 7 PASS / 21 FAIL，全红在「断言还停在 mock 阶段」）：
 * 基座 M7 后端 `shell/auth-accounts-routes.cjs` 已上线，settings.js 里的
 * USE_MOCK_AUTH_ACCOUNTS 已从 true 翻成 false，走真实接口。而老测试断言的是
 * 「不该去打 /api/auth-accounts」「状态行要写示例数据」——接口一上线每条都反了。
 * 这一版按**真实接口的行为**重写，并把每个场景拆成独立 boot，互不串味。
 *
 * 真实契约（shell/auth-accounts-routes.cjs）：
 *   GET    /api/auth-accounts      -> { ok:true, accounts:[{id,tenantId,accountType,status,scope,updatedAt}] }
 *                                     按 tenant_id 过滤，updated_at DESC, id 排序；未登录 401；非 GET 405
 *   DELETE /api/auth-accounts/:id  -> { ok:true, deleted:<id> }；id 非 UUID 400；找不到或跨租户 404
 *
 * 跑的是**真实的 shell/public/settings.js**，不是另写一份逻辑。
 * 跑法：node tests/regression/ui-settings-auth-accounts-test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDomStub } from "../helpers/dom-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, "../../shell/public/settings.js");
const HTML = path.resolve(HERE, "../../shell/public/settings.html");
const ROUTES = path.resolve(HERE, "../../shell/auth-accounts-routes.cjs");
const src = readFileSync(JS, "utf8");
const html = readFileSync(HTML, "utf8");

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? "  -> " + extra : "")); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
};
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/* 真实后端会返回的形状：id 是 UUID（后端 DELETE 用 UUID_RE 校验），
 * Meta 那条 scope 里刻意带 & 和 <script>，用来验证转义。 */
function seedAccounts() {
  return [
    { id: "11111111-1111-1111-1111-111111111111", tenantId: "t1", accountType: "SS-GTM",
      status: "有效", scope: "Server 容器 GTM-WP7H3CBN 全量事件转发", updatedAt: "2026-09-28T14:20:00+08:00" },
    { id: "22222222-2222-2222-2222-222222222222", tenantId: "t1", accountType: "Meta",
      status: "即将过期", scope: "Meta CAPI & 像素回传（像素 ID 1029…）", updatedAt: "2026-07-12T09:05:00+08:00" },
    { id: "33333333-3333-3333-3333-333333333333", tenantId: "t1", accountType: "Ryze MCP",
      status: "需重验", scope: "MCP 数据源只读 <script>alert(1)</script>", updatedAt: "2026-06-30T18:42:00+08:00" },
  ];
}

const res = (obj, code) => ({
  ok: (code || 200) < 400, status: code || 200,
  headers: { get: () => "application/json" },
  json: async () => obj, text: async () => JSON.stringify(obj),
});

/**
 * 启动一次真实的 settings.js。
 * @param {object} o
 * @param {object|null} o.accounts  初始账户列表；null = 空
 * @param {number}      o.getStatus GET 的 HTTP 状态码（默认 200）
 * @param {object|null} o.getReply  直接覆盖 GET 的返回体
 * @param {number}      o.delStatus DELETE 的 HTTP 状态码（默认 200）
 * @param {boolean}     o.getThrows GET 是否直接网络异常
 */
async function boot(o = {}) {
  const dom = makeDomStub();
  const db = {
    accounts: o.accounts === null ? [] : (o.accounts || seedAccounts()),
    calls: [],
    redirects: [],
    getStatus: o.getStatus || 200,
    getReply: o.getReply || null,
    delStatus: o.delStatus || 200,
    getThrows: !!o.getThrows,
  };

  const fetchStub = async (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || "GET";
    db.calls.push({ url: u, method });

    if (u === "/api/auth/me") return res({ user: { username: "u", email: "u@x.com" }, tenant: { name: "t" } });
    if (u === "/api/auth/key") return res({ ok: true, key: null });

    if (u === "/api/auth-accounts" && method === "GET") {
      if (db.getThrows) throw new Error("网络错误");
      if (db.getReply) return res(db.getReply, db.getStatus);
      return res({ ok: true, accounts: db.accounts }, db.getStatus);
    }
    const del = u.match(/^\/api\/auth-accounts\/(.+)$/);
    if (del && method === "DELETE") {
      const id = decodeURIComponent(del[1]);
      if (db.delStatus !== 200) return res({ ok: false, error: "删除失败" }, db.delStatus);
      const before = db.accounts.length;
      db.accounts = db.accounts.filter((a) => a.id !== id);
      // 后端 DELETE 找不到/跨租户返回 404，这里同步模拟：没删掉任何一条就是 404
      if (db.accounts.length === before) return res({ ok: false, error: "未找到该授权账户" }, 404);
      return res({ ok: true, deleted: id });
    }
    return res({ ok: true });
  };

  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    ...dom,
    window: { addEventListener() {}, ICONS: {} },
    location: { href: "/settings", search: "", replace: (u) => db.redirects.push(String(u)) },
    fetch: fetchStub,
    setTimeout, clearTimeout, TextDecoder, URLSearchParams, AbortController,
    MutationObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(src, ctx, { filename: "settings.js" });
  await flush();

  return {
    db, ctx,
    list: dom.el("acctList"),
    status: dom.el("acctStatus"),
    modal: dom.el("revokeModal"),
    body: dom.el("revokeBody"),
    cancel: dom.el("revokeCancel"),
    confirm: dom.el("revokeConfirm"),
    /** 模拟点某条账户的「解除」按钮 */
    clickRevoke(id) {
      this.list.dispatch("click", { target: { closest: () => ({ getAttribute: () => id }) } });
    },
  };
}

/** 列表里渲染出来的条目数（以 class="acct-item" 计数）。 */
const itemCount = (app) => (app.list.innerHTML.match(/acct-item/g) || []).length;

/* ==================================================================
 * [1] 页面结构的静态事实（这一层跟接口无关，本来就该在 HTML/JS 里保证）
 * ================================================================== */
console.log("\n[1] 页面结构");
{
  ok("页面确实有「广告与数据源授权」这一节", /id="sourcesHeading"/.test(html));
  ok("GA property 连接入口没有跟着复活", !/gaPropertyId|id="gaConnect"/.test(html));
  ok("三态徽标用的是 PRD 的三种语义",
    /\.acct-badge\.ok[\s\S]*\.acct-badge\.warn[\s\S]*\.acct-badge\.danger/.test(html)
    || /"有效":\s*"ok"[\s\S]*"即将过期":\s*"warn"[\s\S]*"需重验":\s*"danger"/.test(src));
  ok("前端已经切到真实接口（不再用 mock 数据）", /USE_MOCK_AUTH_ACCOUNTS\s*=\s*false/.test(src));
}

/* ==================================================================
 * [2] 真实接口：加载与渲染
 * ================================================================== */
console.log("\n[2] 真实接口加载与清单渲染");
{
  const app = await boot();
  const { db } = app;

  ok("启动时真的去调了 GET /api/auth-accounts",
    db.calls.some((c) => c.url === "/api/auth-accounts" && c.method === "GET"),
    JSON.stringify(db.calls.map((c) => c.method + " " + c.url)));

  const rendered = app.list.innerHTML || "";
  ok("清单渲染出来了", rendered.length > 0, "innerHTML 为空");
  ok("渲染出 3 条（后端返回几条就几条）", itemCount(app) === 3, String(itemCount(app)));
  ok("含 SS-GTM 数据源", /SS-GTM/.test(rendered));
  ok("含 Meta 数据源", /Meta/.test(rendered));
  ok("含 MCP 数据源", /MCP/.test(rendered));

  // 真实数据不能再标「示例数据」—— 那是 mock 阶段的免责声明，
  // 接口上线后还挂着会让运营以为线上授权是假的
  ok("状态行写的是真实条数", /共 3 个数据源授权/.test(app.status.textContent), app.status.textContent);
  ok("状态行不再谎称是示例数据", !/示例数据/.test(app.status.textContent), app.status.textContent);

  ok("每条都带授权范围 scope", (rendered.match(/acct-scope/g) || []).length === 3,
    String((rendered.match(/acct-scope/g) || []).length));
  ok("每条都带最后更新时间", (rendered.match(/acct-updated/g) || []).length === 3);
  ok("有效 → 绿 ok", /acct-badge ok/.test(rendered));
  ok("即将过期 → 琥珀 warn", /acct-badge warn/.test(rendered));
  ok("需重验 → 红 danger", /acct-badge danger/.test(rendered));
  ok("每条都带「解除」按钮", (rendered.match(/acct-revoke/g) || []).length === 3);
  ok("data-id 用的是后端返回的 UUID",
    /data-id="11111111-1111-1111-1111-111111111111"/.test(rendered), "后端 id 必须原样落到 DOM 上，DELETE 要用");
}

/* ==================================================================
 * [3] XSS：后端返回什么都要转义（真实接口的 scope 是用户可控内容）
 * ================================================================== */
console.log("\n[3] XSS 转义");
{
  const app = await boot();
  const rendered = app.list.innerHTML || "";
  ok("& 被转义成 &amp;", /&amp;/.test(rendered) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(rendered),
    "渲染内容里出现未转义的 &");
  ok("<script> 被转义（没有原样落进 innerHTML）", !/<script/i.test(rendered), "出现了未转义的 <script");
  ok("转义用的是 &lt;", /&lt;script&gt;/.test(rendered));
}

/* ==================================================================
 * [4] 解除流程：影响提醒 + 真的打到 DELETE + 删完重新拉列表
 * ================================================================== */
console.log("\n[4] 解除流程");
{
  const app = await boot();
  const { db } = app;
  const metaId = "22222222-2222-2222-2222-222222222222";

  app.clickRevoke(metaId);
  await flush();

  ok("点「解除」弹出确认框", app.modal.style.display === "flex", String(app.modal.style.display));
  ok("询问里点名了要解除的账户", /Meta/.test(app.body.textContent), String(app.body.textContent).slice(0, 60));
  ok("含「解除影响」提醒", /解除影响/.test(app.body.textContent));
  ok("影响提醒写清了停止回传", /停止回传|不再归集/.test(app.body.textContent));
  ok("影响提醒写清了已生成结果不受影响", /已生成的归因结果不受影响/.test(app.body.textContent));
  ok("影响提醒给出了恢复路径", /重新授权/.test(app.body.textContent));
  ok("弹框期间还没发 DELETE（等用户确认）",
    !db.calls.some((c) => c.method === "DELETE"), JSON.stringify(db.calls.map((c) => c.method)));

  /* ---- 取消：不能误删 ---- */
  const before = itemCount(app);
  app.cancel.dispatch("click");
  await flush();
  ok("点取消关闭弹框", app.modal.style.display === "none", String(app.modal.style.display));
  ok("点取消不删除任何一条", itemCount(app) === before, String(itemCount(app)));
  ok("点取消不会发 DELETE", !db.calls.some((c) => c.method === "DELETE"));

  /* ---- 确认：真的发 DELETE 并刷新 ---- */
  app.clickRevoke(metaId);
  await flush();
  app.confirm.dispatch("click");
  await flush();

  ok("确认后弹框关闭", app.modal.style.display === "none", String(app.modal.style.display));
  const delCall = db.calls.find((c) => c.method === "DELETE");
  ok("发出了 DELETE 请求", !!delCall, JSON.stringify(db.calls.map((c) => c.method + " " + c.url)));
  ok("DELETE 打的是 /api/auth-accounts/<id>", !!delCall && delCall.url === "/api/auth-accounts/" + metaId,
    delCall && delCall.url);
  ok("删除后重新拉了一次列表（不靠前端本地过滤）",
    db.calls.filter((c) => c.url === "/api/auth-accounts" && c.method === "GET").length === 2,
    String(db.calls.filter((c) => c.url === "/api/auth-accounts" && c.method === "GET").length));
  ok("列表刷新后剩 2 条", itemCount(app) === 2, String(itemCount(app)));
  ok("被解除的那条不再出现", !/22222222-2222-2222-2222-222222222222/.test(app.list.innerHTML));

  /* ---- 点遮罩关闭（不解除） ---- */
  app.clickRevoke("33333333-3333-3333-3333-333333333333");
  await flush();
  app.modal.dispatch("click", { target: app.modal });
  await flush();
  ok("点遮罩关闭弹框", app.modal.style.display === "none", String(app.modal.style.display));
  ok("点遮罩不误删", itemCount(app) === 2, String(itemCount(app)));
}

/* ==================================================================
 * [5] 异常兜底：空列表 / 后端报错 / 未登录 / 删除失败
 * ================================================================== */
console.log("\n[5] 异常兜底");
{
  // 5a 空列表：业务线还没接入
  const empty = await boot({ accounts: null });
  ok("空列表时给出「暂无已授权账户」而不是空白",
    /暂无已授权账户/.test(empty.status.textContent), empty.status.textContent);
  ok("空列表时不渲染任何条目", itemCount(empty) === 0);

  // 5b 后端 500：必须说「读取失败」，不能伪装成「暂无账户」——
  //    否则后端挂了，运营看到的是「你还没授权」，会去重复授权
  const broken = await boot({ getStatus: 500, getReply: { ok: false, error: "数据库异常" } });
  ok("后端 500 时明确说读取失败", /失败/.test(broken.status.textContent), broken.status.textContent);
  ok("后端 500 时不假装是「暂无账户」", !/暂无已授权账户/.test(broken.status.textContent), broken.status.textContent);
  ok("后端 500 时列表清空（不残留上一版数据）", itemCount(broken) === 0);

  // 5c 后端返回 ok:false（非 2xx 之外的情况）
  const notOk = await boot({ getReply: { ok: false, error: "租户未开通" } });
  ok("后端 ok:false 时也不当成「暂无」", !/暂无已授权账户/.test(notOk.status.textContent), notOk.status.textContent);

  // 5d 未登录 401 → 跳登录，而不是显示空列表
  const anon = await boot({ getStatus: 401, getReply: { ok: false, error: "请先登录" } });
  ok("401 时跳转登录页", anon.db.redirects.some((u) => /\/login/.test(u)), JSON.stringify(anon.db.redirects));
  ok("401 时不渲染清单", itemCount(anon) === 0);

  // 5e 网络异常（fetch 直接 reject）
  const offline = await boot({ getThrows: true });
  ok("网络异常时说明读取失败", /失败/.test(offline.status.textContent), offline.status.textContent);

  // 5f 删除失败（404：跨租户或已被别人删掉）
  const gone = await boot({ delStatus: 404 });
  gone.clickRevoke("22222222-2222-2222-2222-222222222222");
  await flush();
  gone.confirm.dispatch("click");
  await flush();
  ok("删除失败时列表不消失（等后端说了算）", itemCount(gone) === 3, String(itemCount(gone)));
  ok("删除失败时状态行给出原因", /解除失败|失败/.test(gone.status.textContent), gone.status.textContent);
}

/* ==================================================================
 * [6] 与后端契约对齐（读真实路由源码，防止前后端各改各的）
 * ================================================================== */
console.log("\n[6] 前后端契约对齐");
{
  let routes = "";
  try { routes = readFileSync(ROUTES, "utf8"); } catch (e) { routes = ""; }
  if (!routes) {
    console.log("  skip 找不到 shell/auth-accounts-routes.cjs，跳过契约比对");
  } else {
    ok("后端 GET 返回的是 { ok, accounts }", /ok: true, accounts: result\.rows\.map\(toAccount\)/.test(routes));
    ok("后端按 tenant_id 过滤（租户隔离）", /WHERE tenant_id = \$1/.test(routes));
    ok("后端 DELETE 也带 tenant_id（防跨租户删）", /DELETE FROM auth_accounts WHERE id = \$1 AND tenant_id = \$2/.test(routes));
    ok("后端对 id 做 UUID 校验", /UUID_RE\.test\(id\)/.test(routes));

    // 前端渲染的字段名要和后端 toAccount() 一一对应，改任一边都会红
    for (const f of ["accountType", "status", "scope", "updatedAt"]) {
      ok("前端渲染的字段 " + f + " 后端确实返回", new RegExp("\\b" + f + ":").test(routes) || new RegExp(f).test(routes));
    }
    ok("前端读的是 accounts 字段（不是裸数组）", /j\.accounts/.test(src));
  }
}

console.log("\n账户授权（非 GA）回归：" + pass + " 通过，" + failures.length + " 失败");
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
