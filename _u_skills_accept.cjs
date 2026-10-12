/**
 * 技能页面改版 —— 验收测试
 *
 * 关键点：本脚本不另写一份「替身实现」，而是从 app.js 真实源码里
 * 截取 SKILL_DETAIL_BEGIN/END 之间的代码原样执行（顺带带上 QUICK_QUESTIONS
 * 区块，好让 pickQuickQuestion 也是线上那份），测的就是线上要跑的逻辑。
 *
 * 用法： node _u_skills_accept.cjs
 * 结果：终端打印 + 写入 __u_skills_accept_result.txt
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "shell", "public", "app.js");

/* ---------- 1. 从 app.js 抽出被测代码 ---------- */
const src = fs.readFileSync(APP_JS, "utf8");
function slice(beginMark, endMark) {
  const b = src.indexOf(beginMark), e = src.indexOf(endMark);
  if (b < 0 || e < 0) {
    console.error("FAIL: 在 app.js 里找不到标记 " + beginMark);
    process.exit(1);
  }
  return src.slice(b + beginMark.length, e);
}
const quickBlock = slice("/* QUICK_QUESTIONS_BEGIN */", "/* QUICK_QUESTIONS_END */");
const detailBlock = slice("/* SKILL_DETAIL_BEGIN */", "/* SKILL_DETAIL_END */");

/* ---------- 2. 极简 DOM 垫片 ---------- */
function makeNode(tag) {
  const n = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    listeners: {},
    className: "",
    style: {},
    _text: "",
    hidden: false,
    type: "",
    title: "",
    value: "",
    placeholder: "",
    disabled: false,
    tabIndex: 0,
    focusCount: 0,
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() { this.focusCount++; },
    click() { return Promise.all((this.listeners.click || []).map((f) => f())); },
    keydown(key) {
      return Promise.all((this.listeners.keydown || []).map((f) => f({ key, preventDefault() {} })));
    },
  };
  return n;
}

/* ---------- 3. 沙箱：注入 app.js 里位于标记之外的少量依赖 ---------- */
const viewCalls = [];
const redirectCalls = [];
const store = {};
const sandbox = {
  document: { createElement: makeNode },
  window: {},
  console,
  sessionStorage: {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => { delete store[k]; }); },
  },
  // 以下 5 个是 app.js 顶部/别处的既有实现，非本次被测逻辑，给最小版本即可
  fmtTime: (ts) => (ts ? String(ts) : ""),
  switchView: (v) => { viewCalls.push(v); },
  ta: { value: "", style: {}, focus() {} },
  state: { activeId: "conv-1", list: [] },
  openConversation: async () => {},
  newConversation: async () => {},
  $: () => null,
  location: { assign: (u) => { redirectCalls.push(u); }, replace: (u) => { redirectCalls.push(u); } },
  fetch: () => Promise.reject(new Error("no network in test")),
};
vm.createContext(sandbox);
vm.runInContext(quickBlock + "\n" + detailBlock, sandbox);
const api = vm.runInContext(
  "({ skillUseDecision, renderConnectorBlock, renderSkillDetail, loadSkills, gotoChatWithQuestion," +
  " savePendingUse, resumePendingUse, mkNode });",
  sandbox
);
const { skillUseDecision, renderConnectorBlock, renderSkillDetail, loadSkills, resumePendingUse } = api;

/* ---------- 4. 真实数据：基座 server.cjs 当前下发的 3 个技能 ---------- */
const REAL = [
  {
    id: "attribution.query", title: "归因查询",
    desc: "工具原始描述", description: "查询广告归因漏斗与素材投放表现，回答转化、渠道、素材效果等问题。",
    sampleQuestion: "最近7天各渠道素材表现如何？", requiresConnector: false,
  },
  {
    id: "media.route", title: "媒体生成",
    desc: "工具原始描述", description: "根据文字描述或参考图生成图片/视频，支持文生图、图生图、文生视频、图生视频。",
    sampleQuestion: "帮我生成一张产品宣传图：画面是一杯咖啡放在木桌上，暖色灯光，简约高级风格。", requiresConnector: false,
  },
  {
    id: "ga.query", title: "GA 数据查询",
    desc: "工具原始描述", description: "授权你自己的 Google Analytics 账户后，可以直接在对话里问真实网站数据。",
    sampleQuestion: "这周我的GA网站访问量多少？", requiresConnector: true,
  },
];
const GA = REAL[2], ATTR = REAL[0], MEDIA = REAL[1];

/* ---------- 5. 假的 GaConnect（记录调用，行为按用例配） ---------- */
function makeGa(o) {
  const opt = o || {};
  const ga = {
    calls: { connect: [], disconnect: 0, status: 0 },
    PROPERTY_ID_HINT: "请输入纯数字的 GA4 property ID，例如 123456789；不是 G- 开头的衡量 ID。",
    PROPERTY_ID_TIP: "property ID 是 GA4 后台里那串纯数字，不是 G- 开头的衡量 ID。",
    validatePropertyId: (v) => /^\d+$/.test(String(v == null ? "" : v).trim()),
    loadStatus: async () => {
      ga.calls.status++;
      if (opt.statusFails) return null;
      return { ok: true, connected: !!opt.connected, propertyId: opt.propertyId || "123456789", updatedAt: opt.updatedAt || "2026-10-09T10:00:00Z" };
    },
    disconnect: async () => { ga.calls.disconnect++; return opt.disconnectOk !== false; },
    authorizeUrl: (pid) => "/api/business/ga-connector/oauth/authorize?propertyId=" + encodeURIComponent(pid),
    connect: (arg) => { ga.calls.connect.push(arg); return { cancel() {} }; },
  };
  return ga;
}

/* ---------- 6. DOM 查找工具 ---------- */
function flat(n) {
  let out = [n];
  (n.children || []).forEach((c) => { out = out.concat(flat(c)); });
  return out;
}
function byText(n, t) { return flat(n).find((x) => x._text === t) || null; }
function byClass(n, c) {
  return flat(n).filter((x) => typeof x.className === "string" && x.className.split(" ").indexOf(c) >= 0);
}
function hasClass(n, c) {
  return typeof n.className === "string" && n.className.split(" ").indexOf(c) >= 0;
}

/* ---------- 7. 断言 ---------- */
let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push("PASS  " + name); }
  else { fail++; lines.push("FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function eq(name, got, want) {
  ok(name, got === want, "got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
}

/* ---------- 8. 用例 ---------- */
(async function run() {
  /* A. 「去使用」三种走向的判定 */
  eq("A1 归因查询（不需要连接）→ go-chat", skillUseDecision(ATTR, false), "go-chat");
  eq("A2 媒体生成（不需要连接）→ go-chat", skillUseDecision(MEDIA, false), "go-chat");
  eq("A3 GA 已连接 → go-chat", skillUseDecision(GA, true), "go-chat");
  eq("A4 GA 未连接 → need-connector", skillUseDecision(GA, false), "need-connector");
  eq("A5 GA 状态未知(null) → need-connector", skillUseDecision(GA, null), "need-connector");
  eq("A6 缺 requiresConnector 字段 → go-chat", skillUseDecision({ id: "x" }, false), "go-chat");
  eq("A7 skill 为 null 不崩 → go-chat", skillUseDecision(null, false), "go-chat");

  /* B. 详情渲染 */
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    const d = await renderSkillDetail(GA, box, { ga });
    ok("B1 详情容器展开", box.hidden === false);
    ok("B2 显示 description 说明文字", !!byText(box, GA.description));
    ok("B3 有「去使用」按钮", !!byText(box, "去使用"));
    ok("B4 需要连接的技能带连接区块", byClass(box, "sd-connector").length === 1);
    ok("B5 首次渲染就读了一次真实连接状态", ga.calls.status === 1);
    ok("B6 返回按钮可收起详情", (() => { byText(box, "← 返回技能列表").click(); return box.hidden === true; })());
  }
  {
    const box = makeNode("div");
    const s = Object.assign({}, MEDIA, { description: "" });
    await renderSkillDetail(s, box, { ga: makeGa() });
    ok("B7 description 缺失时用 desc 兜底", !!byText(box, "工具原始描述"));
  }
  {
    const box = makeNode("div");
    await renderSkillDetail(ATTR, box, { ga: makeGa() });
    ok("B8 不需要连接的技能不挂连接区块", byClass(box, "sd-connector").length === 0);
  }
  {
    const box = makeNode("div");
    const evil = Object.assign({}, ATTR, { title: "<img src=x onerror=alert(1)>", description: "<script>alert(2)</script>" });
    await renderSkillDetail(evil, box, { ga: makeGa() });
    const texts = flat(box).map((x) => x._text).join("|");
    ok("B9 标题走 textContent 不拼 HTML", texts.indexOf("<img src=x onerror=alert(1)>") >= 0);
    ok("B10 说明走 textContent 不拼 HTML", texts.indexOf("<script>alert(2)</script>") >= 0);
  }

  /* C. 点「去使用」的真实行为 */
  {
    const used = [];
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(ATTR, box, { ga, onUse: (q) => used.push(q) });
    await byText(box, "去使用").click();
    eq("C1 归因查询点去使用 → 带示例问题去对话", used[0], ATTR.sampleQuestion);
    eq("C2 归因查询点去使用 → 不弹授权引导", ga.calls.connect.length, 0);
  }
  {
    const used = [];
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(MEDIA, box, { ga, onUse: (q) => used.push(q) });
    await byText(box, "去使用").click();
    eq("C3 媒体生成点去使用 → 带示例问题去对话", used[0], MEDIA.sampleQuestion);
    eq("C4 媒体生成点去使用 → 不弹授权引导", ga.calls.connect.length, 0);
  }
  {
    const used = [];
    const box = makeNode("div");
    const ga = makeGa({ connected: true });
    await renderSkillDetail(GA, box, { ga, onUse: (q) => used.push(q) });
    await byText(box, "去使用").click();
    eq("C5 GA 已连接点去使用 → 直接去对话", used[0], GA.sampleQuestion);
    eq("C6 GA 已连接点去使用 → 不再发起连接", ga.calls.connect.length, 0);
  }
  {
    const used = [];
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(GA, box, { ga, onUse: (q) => used.push(q) });
    await byText(box, "去使用").click();
    eq("C7 GA 未连接点去使用 → 不跳对话", used.length, 0);
    eq("C8 GA 未连接且没填 ID → 不发起授权", ga.calls.connect.length, 0);
    const err = byClass(box, "sd-err")[0];
    ok("C9 GA 未连接且没填 ID → 给出明确提示", err && err.hidden === false && /property ID/.test(err._text));
  }
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(GA, box, { ga, onUse: () => {} });
    const input = byClass(box, "sd-prop")[0];
    input.value = "G-ABC123";
    await byText(box, "去使用").click();
    eq("C10 填了非法 ID（G- 开头）→ 不发起授权", ga.calls.connect.length, 0);
    const err = byClass(box, "sd-err")[0];
    ok("C11 非法 ID → 提示纯数字规则", err && /纯数字/.test(err._text));
  }
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(GA, box, { ga, onUse: () => {} });
    const input = byClass(box, "sd-prop")[0];
    input.value = "123456789";
    await byText(box, "去使用").click();
    eq("C12 填了合法 ID 点去使用 → 发起真实授权", ga.calls.connect.length, 1);
    eq("C13 授权带上的 property ID 正确", ga.calls.connect[0] && ga.calls.connect[0].propertyId, "123456789");
  }
  {
    const used = [];
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(GA, box, { ga, onUse: (q) => used.push(q) });
    byClass(box, "sd-prop")[0].value = "987654321";
    await byText(box, "去使用").click();
    const arg = ga.calls.connect[0];
    await arg.onDone({ ok: true, connected: true, propertyId: "987654321", updatedAt: "2026-10-10T09:00:00Z" });
    eq("C14 授权成功后自动继续到对话", used.length, 1);
    eq("C15 继续到对话带的是示例问题", used[0], GA.sampleQuestion);
    ok("C16 连接成功后详情显示新 property", !!byText(box, "987654321"));
  }
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    await renderSkillDetail(GA, box, { ga, onUse: () => {} });
    byClass(box, "sd-prop")[0].value = "123456789";
    await byText(box, "去使用").click();
    ga.calls.connect[0].onFail("授权窗口已关闭，未检测到连接。");
    ok("C17 授权失败 → 显示失败原因，不静默", !!byText(box, "授权窗口已关闭，未检测到连接。"));
  }

  /* D. 已连接区块：property 信息 + 解除 / 更换 两个独立按钮 */
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: true, propertyId: "321654987", updatedAt: "2026-10-09T10:00:00Z" });
    const changes = [];
    const inner = makeNode("div");
    renderConnectorBlock(inner, { ga, status: { connected: true, propertyId: "321654987", updatedAt: "2026-10-09T10:00:00Z" }, onChanged: (s) => changes.push(s) });
    ok("D1 已连接显示 property ID", !!byText(inner, "321654987"));
    ok("D2 已连接显示连接时间", !!byText(inner, "2026-10-09T10:00:00Z"));
    ok("D3 已连接显示「已连接」徽标", !!byText(inner, "已连接"));
    ok("D4 有独立的「解除连接」按钮", !!byText(inner, "解除连接"));
    ok("D5 有独立的「更换 Property」按钮", !!byText(inner, "更换 Property"));
    ok("D6 已连接时不再显示「连接 Google 账户」按钮", !byText(inner, "连接 Google 账户"));
    ok("D7 已连接时不显示 property 输入框", byClass(inner, "sd-prop").length === 0);
    eq("D8 解除/更换是两个不同按钮（不是同一个身兼两职）", byText(inner, "解除连接") === byText(inner, "更换 Property"), false);
  }
  {
    const inner = makeNode("div");
    const ga = makeGa({ connected: true });
    const changes = [];
    renderConnectorBlock(inner, { ga, status: { connected: true, propertyId: "123", updatedAt: "t" }, onChanged: (s) => changes.push(s), confirm: () => true });
    await byText(inner, "解除连接").click();
    eq("D9 点解除连接 → 调了一次 DELETE", ga.calls.disconnect, 1);
    eq("D10 解除后回调刷新状态", changes.length, 1);
    eq("D11 解除后变为未连接", changes[0] && changes[0].connected, false);
  }
  {
    const inner = makeNode("div");
    const ga = makeGa({ connected: true, disconnectOk: false });
    renderConnectorBlock(inner, { ga, status: { connected: true, propertyId: "123" }, onChanged: () => {}, confirm: () => true });
    await byText(inner, "解除连接").click();
    ok("D12 解除失败 → 给出错误提示", !!byText(inner, "解除失败，请稍后重试。"));
    ok("D13 解除失败 → 仍停在已连接视图", !!byText(inner, "已连接"));
  }
  {
    const inner = makeNode("div");
    const ga = makeGa({ connected: true, disconnectOk: false });
    renderConnectorBlock(inner, { ga, status: { connected: true, propertyId: "123" }, onChanged: () => {}, confirm: () => false });
    await byText(inner, "解除连接").click();
    eq("D14 二次确认点取消 → 不调 DELETE", ga.calls.disconnect, 0);
  }
  {
    const inner = makeNode("div");
    const ga = makeGa({ connected: true });
    renderConnectorBlock(inner, { ga, status: { connected: true, propertyId: "123", updatedAt: "t" }, onChanged: () => {} });
    await byText(inner, "更换 Property").click();
    ok("D15 点更换 Property → 出现新 property 输入框", byClass(inner, "sd-prop").length === 1);
    ok("D16 更换表单里有连接按钮", !!byText(inner, "连接 Google 账户"));
    ok("D17 更换表单里有取消按钮", !!byText(inner, "取消"));
    eq("D18 更换 Property 不会顺手解绑", ga.calls.disconnect, 0);
  }
  {
    const inner = makeNode("div");
    const ga = makeGa();
    renderConnectorBlock(inner, { ga: null, status: { connected: true } });
    ok("D19 连接组件缺失时不崩并给出提示", !!byText(inner, "连接组件未加载，刷新页面后重试。"));
  }

  /* E. 技能列表：3 张可点击卡片 */
  {
    const grid = makeNode("div"), detail = makeNode("div");
    detail.hidden = true;
    sandbox.$ = (s) => (s === "#skillGrid" ? grid : s === "#skillDetail" ? detail : makeNode("span"));
    sandbox.fetch = async () => ({ json: async () => ({ ok: true, skills: REAL }) });
    await loadSkills();
    const cards = grid.children;
    eq("E1 渲染出 3 张技能卡片", cards.length, 3);
    ok("E2 卡片可点击（clickable）", cards.every((c) => hasClass(c, "clickable")));
    ok("E3 卡片可键盘聚焦（tabIndex=0）", cards.every((c) => c.tabIndex === 0));
    await cards[2].click();
    ok("E4 点 GA 卡片 → 展开详情", detail.hidden === false && detail.children.length === 1);
    ok("E5 详情里有说明文字", !!byText(detail, GA.description));
  }
  {
    const grid = makeNode("div"), detail = makeNode("div");
    sandbox.$ = (s) => (s === "#skillGrid" ? grid : s === "#skillDetail" ? detail : makeNode("span"));
    sandbox.fetch = async () => ({ json: async () => ({ ok: true, skills: [] }) });
    await loadSkills();
    ok("E6 技能为空 → 显示「没有技能」", !!byText(grid, "没有技能"));
  }
  {
    const grid = makeNode("div"), detail = makeNode("div");
    sandbox.$ = (s) => (s === "#skillGrid" ? grid : s === "#skillDetail" ? detail : makeNode("span"));
    sandbox.fetch = async () => { throw new Error("boom"); };
    await loadSkills();
    ok("E7 接口异常 → 不崩，提示读不到", !!byText(grid, "读不到技能列表"));
  }

  /* F. 弹窗被拦截的降级路径：授权后回到工作区要补上「去使用」 */
  {
    const box = makeNode("div");
    const ga = makeGa({ connected: false });
    ga.connect = (arg) => { ga.calls.connect.push(arg); if (arg && arg.onRedirect) arg.onRedirect(); return null; };
    sandbox.sessionStorage.clear();
    await renderSkillDetail(GA, box, { ga, onUse: () => {} });
    byClass(box, "sd-prop")[0].value = "123456789";
    await byText(box, "连接 Google 账户").click();
    const raw = sandbox.sessionStorage.getItem("ptSkillUseAfterGaConnect");
    ok("F1 弹窗被拦截 → 记下待续的示例问题", !!raw && JSON.parse(raw).q === GA.sampleQuestion, raw);
    ok("F1b 降级时跳的是真实 authorize 地址", /oauth\/authorize\?propertyId=123456789$/.test(String(redirectCalls[0])), redirectCalls[0]);
  }
  {
    sandbox.sessionStorage.clear();
    sandbox.sessionStorage.setItem("ptSkillUseAfterGaConnect", JSON.stringify({ q: GA.sampleQuestion }));
    sandbox.window.GaConnect = makeGa({ connected: true });
    viewCalls.length = 0; sandbox.ta.value = "";
    await resumePendingUse();
    eq("F2 回到工作区且已连接 → 自动进对话", viewCalls[0], "chat");
    eq("F3 对话里预填的还是原示例问题", sandbox.ta.value, GA.sampleQuestion);
    eq("F4 续接一次即清除，不会反复跳", sandbox.sessionStorage.getItem("ptSkillUseAfterGaConnect"), null);
  }
  {
    sandbox.sessionStorage.clear();
    sandbox.sessionStorage.setItem("ptSkillUseAfterGaConnect", JSON.stringify({ q: GA.sampleQuestion }));
    sandbox.window.GaConnect = makeGa({ connected: false });
    viewCalls.length = 0;
    await resumePendingUse();
    eq("F5 授权没成功 → 不打扰用户", viewCalls.length, 0);
  }
  {
    sandbox.sessionStorage.clear();
    sandbox.window.GaConnect = makeGa({ connected: true });
    viewCalls.length = 0;
    await resumePendingUse();
    eq("F6 没有待续记录 → 不做任何跳转", viewCalls.length, 0);
  }

  /* ---------- 9. 输出 ---------- */
  const head = "技能页面改版验收：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）";
  const out = [head, ""].concat(lines).join("\n");
  console.log(out);
  fs.writeFileSync(path.join(__dirname, "__u_skills_accept_result.txt"), out + "\n", "utf8");
  process.exit(fail ? 1 : 0);
})();
