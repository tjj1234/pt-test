const $ = s => document.querySelector(s);
const chat = $("#chat"), ta = $("#ta"), send = $("#send"), stopBtn = $("#stop"), cm = $("#cm");
const convListEl = $("#convList"), newBtn = $("#newConv");
let dashLoaded = false;
const state = { list: [], activeId: null, loadedId: null, busy: false, unread: {} };

/**
 * 某条对话的结果回来了，但界面已经不在它上面 —— 只能在列表里做「有新回复」标记，
 * 绝不把内容渲染进用户正在看的另一个对话（那会整屏覆盖掉对方的内容）。
 */
function markUnread(id) {
  if (!id || id === state.activeId) return;
  state.unread[id] = true;
  renderList();
}
/** 界面当前显示的还是不是这条对话（切到别的对话 / 别的页面都不算）。 */
function isViewing(id) { return !!id && state.activeId === id; }

/** 这条对话是不是已归档 —— 以列表为准；列表里还没有它时保守按「未归档」处理。 */
function convIsArchived(id) {
  const c = (state.list || []).find((x) => x.id === id);
  return !!(c && c.archived);
}

/* ---- 时间格式化 ---- */
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { hour12: false });
}
function fmtShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " 小时前";
  return d.toLocaleDateString("zh-CN");
}

/* ---- 视图切换 ---- */
const TITLES = { home: "首页", flows: "业务流库", schedule: "调度与执行", dash: "归因看板", import: "广告数据导入", history: "对话历史", chat: "对话", skills: "技能", status: "运行状态", memory: "长期记忆", members: "成员与权限", usage: "用量与日志" };
// M2：可 @ 引用的数据面板（顺序即弹窗展示顺序）；currentPanel 记录最近所在/引用的面板
const DATA_PANELS = ["dash", "flows", "import", "schedule"];
let currentPanel = null;
function switchView(v) {
  document.querySelectorAll(".nav button").forEach(x => x.classList.toggle("on", x.dataset.v === v));
  document.querySelectorAll(".view").forEach(x => x.classList.toggle("on", x.id === "v-" + v));
  $("#title").textContent = TITLES[v];
  if (DATA_PANELS.indexOf(v) >= 0) currentPanel = v;
  if (v === "dash" && !dashLoaded) { $("#dashFrame").src = "/dashboard/"; dashLoaded = true; }
  if (v === "skills") loadSkills();
  if (v === "status") loadStatus();
  if (v === "memory") loadMemory();
  if (v === "import") impOnEnter();
  if (v === "flows") bizLoadFlows();
  if (v === "usage") bizLoadUsage();
  if (v === "schedule") bizLoadSchedule();
  state.view = v;
  syncArchBanner();   // 归档提示条只在对话视图露脸，切到别的页就不该还挂着
  saveRoute();        // 刷新后能回到这里（会话级）
}

/* ---- 刷新记住当前位置（会话级：关掉标签页才丢）----
 * 以前注释写着「自动选中最近一个」，实际永远 switchView("home") —— 刷新就回首页，
 * 注释和实现是反的。现在按 PENDING_USE_KEY 那套 sessionStorage 老办法记住 view + 对话 id。
 */
const ROUTE_KEY = "ptShellRoute";
const RESTORABLE_VIEWS = Object.keys(TITLES);
function saveRoute() {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ v: state.view, id: state.activeId })); }
  catch (e) { /* 隐私模式下忽略 */ }
}
function readRoute() {
  try {
    const o = JSON.parse(sessionStorage.getItem(ROUTE_KEY) || "null") || {};
    const v = typeof o.v === "string" ? o.v : "";
    if (!v || RESTORABLE_VIEWS.indexOf(v) < 0) return null;   // 不认识的视图不猜，直接作废
    return { v, id: typeof o.id === "string" ? o.id : null };
  } catch (e) { return null; }
}
/** 按记住的位置恢复。失败返回 false，由调用方兜底回首页 —— 宁可回首页，也不留白屏。 */
async function restoreRoute(rt) {
  try {
    if (rt.v === "chat" && rt.id) {
      // 只尝试恢复「列表里还在」的对话：被删了 / 不属于你，列表里就不会有它
      if (!state.list.some((c) => c.id === rt.id)) return false;
      await openConversation(rt.id);
      // 列表里还在、但实际 GET 404（竞态被删）时 loadedId 落不下来 —— 这也算恢复失败
      return state.loadedId === rt.id;
    }
    if (rt.v !== "chat") { switchView(rt.v); return true; }
  } catch (e) { /* 落到 return false */ }
  return false;
}
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => switchView(b.dataset.v)));

/* ---- U0：首页品牌点击返回 + 三张引导卡片 ---- */
const brandHome = $("#brandHome");
if (brandHome) {
  brandHome.addEventListener("click", () => switchView("home"));
  brandHome.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView("home"); } });
}
document.querySelectorAll(".gbtn[data-card]").forEach(b => b.addEventListener("click", () => {
  const c = b.dataset.card;
  if (c === "flow") switchView("flows");
  else if (c === "trial") switchView("skills");           // 试用单点能力 → 技能面板
  else if (c === "chat") {                                  // 开始对话 → 进入对话
    if (state.activeId) switchView("chat");
    else if (state.list.length) openConversation(state.list[0].id);
    else newConversation();
  }
}));

/* ---- 气泡 ---- */
function bubbleSys(text) {
  const el = document.createElement("div");
  el.className = "sysline";
  el.textContent = text;
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
  return el;
}
function thinking() {
  const el = document.createElement("div");
  el.className = "msg a";
  el.innerHTML = '<div class="av">北</div><div class="box"><div class="bub"><span class="typing"><i></i><i></i><i></i></span> 思考中…<span class="elapsed"></span></div><div class="steps-live"></div></div>';
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
  return el;
}

/* 流式：把 thinking 气泡转成逐字增长的回复气泡 */
function streamInto(el, text) {
  const bub = el.querySelector(".bub");
  if (bub) bub.textContent = text;
  chat.scrollTop = chat.scrollHeight;
}
/* P0-3：未绑 key 的友好提示 + 「去绑定」按钮（不是「执行失败」） */
function needKeyBubble() {
  const el = document.createElement("div");
  el.className = "msg a";
  const av = document.createElement("div"); av.className = "av"; av.textContent = "北";
  const box = document.createElement("div"); box.className = "box";
  const bub = document.createElement("div"); bub.className = "bub";
  bub.textContent = "你还没绑定 PT key，绑定后我才能替你查数据、跑技能。";
  const btn = document.createElement("button");
  btn.className = "keygo"; btn.textContent = "🔑 去绑定";
  btn.addEventListener("click", () => { if (window.openKeyDrawer) window.openKeyDrawer(); else location.href = "/settings"; });
  box.appendChild(bub); box.appendChild(btn);
  el.appendChild(av); el.appendChild(box); chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

/* ---- 复制（带「已复制」反馈 + 降级方案） ---- */
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e) {
    try {
      const t2 = document.createElement("textarea");
      t2.value = text; t2.style.position = "fixed"; t2.style.opacity = "0";
      document.body.appendChild(t2); t2.select();
      ok = document.execCommand("copy");
      document.body.removeChild(t2);
    } catch (e2) { ok = false; }
  }
  btn.innerHTML = ok ? window.ICONS.check : window.ICONS.close;
  btn.title = ok ? "已复制" : "复制失败";
  btn.classList.add("icon-only");
  setTimeout(() => { btn.innerHTML = window.ICONS.clipboard; btn.title = "复制"; btn.classList.remove("icon-only"); }, 1500);
}

/* ---- 渲染一条消息（带时间戳 + 复制；可选「重新生成」） ---- */
function renderMessage(m, opts) {
  const el = document.createElement("div");
  el.className = "msg " + (m.role === "user" ? "u" : "a");
  const av = document.createElement("div"); av.className = "av"; av.textContent = m.role === "user" ? "我" : "北";
  const box = document.createElement("div"); box.className = "box";
  const bub = document.createElement("div"); bub.className = "bub";
  if (m.image) {
    const img = document.createElement("img");
    img.className = "bubimg"; img.src = m.image; img.alt = "上传图片"; img.loading = "lazy";
    bub.appendChild(img);
  }
  // 随这条消息一起提交的文本文档。服务端只持久化 URL（不含原始文件名），
  // 所以这里统一显示数量，乐观渲染和历史回放保持一致。
  if (Array.isArray(m.documents) && m.documents.length) {
    const dl = document.createElement("div");
    dl.className = "bubdocs";
    dl.textContent = "附带 " + m.documents.length + " 个文档（正文已作为回答的参考上下文）";
    bub.appendChild(dl);
  }
  // 输出侧：渲染 assistant 返回的媒体（图片/视频 URL）——字段形状与基座 media.route 对齐
  // （当前按 { type:"image"|"video", url } 约定；字段名待基座确认，集中在 chat-media.js 提取）
  if (m.media && window.renderMediaInto) window.renderMediaInto(bub, m.media);
  // 输出侧：report 结果（outputType:"report"）自动弹抽屉——镜像 media 字段的自动呈现
  if (m.report && window.openReportDrawer) window.openReportDrawer(m.report);
  const btxt = document.createElement("span"); btxt.className = "bubtext"; btxt.textContent = m.text == null ? "" : m.text;
  bub.appendChild(btxt);
  box.appendChild(bub);

  // 轨迹：展示 agent 调了哪些工具（可折叠）
  if (Array.isArray(m.steps) && m.steps.length) {
    const sb = document.createElement("details"); sb.className = "steps";
    const sum = document.createElement("summary"); sum.className = "steps-sum";
    sum.textContent = "🛠️ 过程 · " + m.steps.length + " 步";
    sb.appendChild(sum);
    const ol = document.createElement("div"); ol.className = "step-list";
    for (const s of m.steps) {
      const d = document.createElement("div"); d.className = "step" + (s.isError ? " err" : "");
      const nm = document.createElement("div"); nm.className = "step-name";
      nm.textContent = (s.isError ? "⚠️ " : "🔧 ") + (s.name || "工具");
      if (s.args) { const sp = document.createElement("span"); sp.className = "step-args"; sp.textContent = " " + s.args; nm.appendChild(sp); }
      d.appendChild(nm);
      if (s.result) { const rs = document.createElement("div"); rs.className = "step-result"; rs.textContent = s.result; d.appendChild(rs); }
      ol.appendChild(d);
    }
    sb.appendChild(ol);
    box.appendChild(sb);
  }

  const meta = document.createElement("div"); meta.className = "meta";
  if (m.ts) {
    const ts = document.createElement("span"); ts.className = "ts"; ts.textContent = fmtTime(m.ts);
    meta.appendChild(ts);
  }
  if (m.text) {
    const copy = document.createElement("button"); copy.className = "msgbtn"; copy.title = "复制";
    copy.innerHTML = '<span class="ico" data-ico="clipboard"></span>';
    copy.addEventListener("click", () => copyText(m.text, copy));
    meta.appendChild(copy);
  }
  if (opts && opts.branchable && m.role === "assistant") {
    const br = document.createElement("button"); br.className = "msgbtn"; br.title = "分岔（以这条回复之前的上下文重新生成）";
    br.innerHTML = '<span class="ico" data-ico="fork"></span>';
    br.addEventListener("click", () => branch(opts.index));
    meta.appendChild(br);
  }
  if (opts && opts.regeneratable) {
    const regen = document.createElement("button"); regen.className = "msgbtn"; regen.title = "重新生成";
    regen.innerHTML = '<span class="ico" data-ico="refresh"></span>';
    regen.addEventListener("click", () => regenerate());
    meta.appendChild(regen);
  }
  box.appendChild(meta);
  el.appendChild(av); el.appendChild(box);
  chat.appendChild(el);
  if (window.initIcons) window.initIcons();  // ← 把新加的 data-ico 占位符替换成 SVG
  chat.scrollTop = chat.scrollHeight;
  return el;
}

/* ---- 渲染整个对话 ---- */
function renderChat(messages) {
  chat.innerHTML = "";
  const msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length) {
    chat.innerHTML = '<div class="empty" id="hello"><h3>问点什么</h3>' +
      '<p>北极大盘为什么涨了？· 哪个素材在烧钱？· 埋点质量怎么样？</p>' +
      '<p class="empty-hint">还没有对话？点左侧「＋ 新建对话」开始，或直接在下面提问。</p></div>';
    return;
  }
  msgs.forEach((m, i) => {
    const lastAssistant = i === msgs.length - 1 && m.role === "assistant";
    renderMessage(m, { branchable: true, index: i, regeneratable: lastAssistant });
  });
}

function showStoppedBar() {
  const bar = document.createElement("div");
  bar.className = "stopped-bar";
  const label = document.createElement("span"); label.textContent = "已停止（你的问题已保存，回答已丢弃）";
  const btn = document.createElement("button"); btn.className = "msgbtn"; btn.title = "重新生成";
  btn.innerHTML = '<span class="ico" data-ico="refresh"></span>';
  btn.addEventListener("click", () => regenerate());
  bar.appendChild(label); bar.appendChild(btn);
  chat.appendChild(bar);
  chat.scrollTop = chat.scrollHeight;
}

/* ---- 对话列表 ---- */
let currentMenu = null;
function closeMenu() { if (currentMenu) { currentMenu.remove(); currentMenu = null; } }
document.addEventListener("click", closeMenu);

function renderList() {
  convListEl.innerHTML = "";
  if (!state.list.length) {
    convListEl.innerHTML = '<div class="conv-empty">还没有对话，点「＋ 新建对话」开始</div>';
    return;
  }
  const active = state.list.filter((c) => !c.archived);
  const archived = state.list.filter((c) => c.archived);

  const mkItem = (c) => {
    const item = document.createElement("div");
    item.className = "conv-item" + (c.id === state.activeId ? " on" : "");
    const title = document.createElement("div"); title.className = "conv-title"; title.textContent = c.title || "新对话";
    const sub = document.createElement("div"); sub.className = "conv-sub";
    sub.textContent = (c.preview || "（空对话）") + " · " + fmtShort(c.updated_at);
    item.appendChild(title); item.appendChild(sub);
    // 这条对话在后台跑完了，但用户当时正在看别的对话 —— 挂个圆点提示「有新回复」
    if (c.id !== state.activeId && state.unread[c.id]) {
      const dot = document.createElement("span");
      dot.className = "conv-dot";
      dot.title = "有新回复";
      item.appendChild(dot);
    }

    const menu = document.createElement("button"); menu.className = "conv-menu"; menu.textContent = "⋯";
    menu.title = "更多操作";
    menu.addEventListener("click", (e) => { e.stopPropagation(); openMenu(c, menu); });
    item.appendChild(menu);

    // 不再用「activeId 已经是它就跳过」来省一次请求 —— 那样从别的页面点回同一条会整个不响应。
    // 是否重新拉内容交给 openConversation 自己判断（已渲染过就只切视图）。
    item.addEventListener("click", () => openConversation(c.id));
    return item;
  };

  const chevSvg = (window.ICONS && window.ICONS.chevron) ? window.ICONS.chevron : "";

  const section = (label, items, key) => {
    const collapsed = localStorage.getItem("pt_conv_collapse_" + key) === "1";

    const det = document.createElement("details");
    det.className = "conv-group";
    det.open = !collapsed;

    const sec = document.createElement("summary");
    sec.className = "conv-sec";
    sec.innerHTML = '<span class="sec-arrow">' + chevSvg + '</span>' + label;
    sec.addEventListener("click", () => {
      // details 会 toggle open，之后持久化
      setTimeout(() => {
        localStorage.setItem("pt_conv_collapse_" + key, det.open ? "0" : "1");
      }, 0);
    });
    det.appendChild(sec);

    if (!items.length) {
      const e = document.createElement("div"); e.className = "conv-empty"; e.textContent = "（空）";
      det.appendChild(e);
    } else {
      for (const c of items) det.appendChild(mkItem(c));
    }
    convListEl.appendChild(det);
  };

  section("进行中", active, "active");
  section("已归档", archived, "archived");
}

function openMenu(c, anchor) {
  closeMenu();
  const pop = document.createElement("div"); pop.className = "conv-menu-pop";
  const ren = document.createElement("button"); ren.textContent = "重命名";
  ren.addEventListener("click", () => { closeMenu(); renameConversation(c); });
  const arc = document.createElement("button"); arc.textContent = c.archived ? "恢复" : "归档";
  arc.addEventListener("click", () => { closeMenu(); toggleArchive(c); });
  const expM = document.createElement("button"); expM.textContent = "导出 Markdown";
  expM.addEventListener("click", () => { closeMenu(); exportConversation(c, "md"); });
  const expJ = document.createElement("button"); expJ.textContent = "导出 JSON";
  expJ.addEventListener("click", () => { closeMenu(); exportConversation(c, "json"); });
  const del = document.createElement("button"); del.className = "danger"; del.textContent = "删除";
  del.addEventListener("click", () => { closeMenu(); deleteConversation(c); });
  pop.appendChild(ren); pop.appendChild(arc); pop.appendChild(expM); pop.appendChild(expJ); pop.appendChild(del);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.left = Math.min(r.left, window.innerWidth - 140) + "px";
  currentMenu = pop;
}

/* ---- 数据操作 ---- */
async function refreshList() {
  try {
    const r = await fetch("/api/conversations", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.conversations)) state.list = j.conversations;
    renderList();
  } catch (e) { /* 静默 */ }
}

async function openConversation(id, opts) {
  const force = !!(opts && opts.force);
  state.activeId = id;
  delete state.unread[id];   // 点进来了，未读标记就没用了
  // 不管这条对话之前是不是已激活，都必须切回对话视图：
  // 否则「开 A → 切到别的页 → 再点 A」时 activeId 还是 A，旧代码会整个跳过 openConversation，
  // 结果停在原来的页面，右侧看起来就像内容没同步。
  switchView("chat");
  renderList();
  // 归档对话只读：这条一打开就把输入框锁上（详见 setComposerLocked）
  setComposerLocked(convIsArchived(id));
  saveRoute();
  // 右侧已经渲染着这个对话 → 只切视图，不重复拉取（避免闪烁和滚动跳动）
  if (!force && state.loadedId === id) return;
  try {
    const r = await fetch("/api/conversations/" + encodeURIComponent(id), { credentials: "same-origin" });
    if (!r.ok) { renderChat([]); state.loadedId = null; return; }
    const j = await r.json().catch(() => null);
    const conv = (j && j.conversation) ? j.conversation : null;
    renderChat(conv && conv.messages ? conv.messages : []);
    state.loadedId = id;
    // 详情带 archived 就以它为准 —— 列表可能是上一版缓存（刚归档完刷新列表的间隙）
    if (conv && typeof conv.archived === "boolean") setComposerLocked(conv.archived);
  } catch (e) { renderChat([]); state.loadedId = null; }
}

/** 一条消息都还没有的空对话（用来复用，避免堆出一串空记录）。 */
function convIsEmpty(c) {
  if (!c || !c.id || c.archived) return false;
  if (typeof c.msgCount === "number") return c.msgCount === 0;
  return !c.preview;   // 后端没给 msgCount 时退化用 preview 判断
}
function findEmptyConversation() {
  const list = Array.isArray(state.list) ? state.list : [];
  for (const c of list) if (convIsEmpty(c)) return c;
  return null;
}

/** 互斥锁：同一时刻只允许一个创建请求在飞。 */
let creatingConv = null;

async function newConversation() {
  // 连点 / 并发场景（新建按钮、ask 里没有 activeId、gotoChatWithQuestion、技能跳转）
  // 共用同一个在飞请求，保证快速连点 N 次最多只产生 1 条空对话。
  if (creatingConv) return creatingConv;
  creatingConv = (async () => {
    try {
      // 已经存在一条没发过消息的空对话 → 直接复用，不再新建
      const empty = findEmptyConversation();
      if (empty) { await openConversation(empty.id); return empty.id; }
      const r = await fetch("/api/conversations", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok && j.id) {
        await refreshList();
        await openConversation(j.id);
        return j.id;
      }
    } catch (e) { /* 静默 */ }
    finally { creatingConv = null; }
    return null;
  })();
  return creatingConv;
}

async function renameConversation(c) {
  const t = prompt("重命名对话：", c.title || "");
  if (t == null) return;
  const title = (t || "").trim();
  if (!title) return;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(c.id), {
      method: "PATCH", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    await refreshList();
  } catch (e) { /* 静默 */ }
}

async function deleteConversation(c) {
  if (!confirm("确定删除对话「" + (c.title || "新对话") + "」？此操作不可恢复。")) return;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(c.id), {
      method: "DELETE", credentials: "same-origin",
    });
    if (state.activeId === c.id) state.activeId = null;
    await refreshList();
    if (state.list.length) await openConversation(state.list[0].id); // 删完自动跳到最近一个
    else renderChat([]);
  } catch (e) { /* 静默 */ }
}

/* ---- 发消息 / 重新生成 / 停止 ---- */
/**
 * 输入框可用状态 = 「正在生成」or「对话已归档」。
 * 两个开关各自会来回切（生成结束要解锁、恢复归档也要解锁），所以统一在这里算 ——
 * 否则任何一个先恢复都会把另一个的锁抹掉（常见的是生成完一解锁，归档就又能打字了）。
 */
function applyComposerState() {
  const locked = state.busy || state.composerLocked;
  ta.disabled = locked;
  send.disabled = locked;
  send.hidden = locked;
  stopBtn.hidden = !state.busy;
}
function setBusy(b) {
  state.busy = b;
  applyComposerState();
  if (!b && !state.composerLocked) ta.focus();
}
/** 归档对话只读：锁输入框 / 发送按钮，并亮起顶部提示条。 */
function setComposerLocked(locked) {
  state.composerLocked = !!locked;
  applyComposerState();
  syncArchBanner();
  if (!locked && !state.busy) ta.focus();
}
function syncArchBanner() {
  const b = $("#archBanner");
  if (b) b.hidden = !(state.composerLocked && state.view === "chat");
}

async function runChat(payload) {
  if (state.busy) return;
  // 这条请求是替哪个对话发的 —— 结果回来时必须跟「界面现在显示的是谁」比对。
  // 用户在 A 生成期间切到 B：A 的回复只做列表未读标记，绝不渲染进 B（会整屏覆盖 B 的内容）。
  const targetId = payload.conversationId || state.activeId;
  const viewing = () => isViewing(targetId);
  setBusy(true);
  const t = thinking();
  const t0 = Date.now();
  const tick = setInterval(() => { const e = t.querySelector(".elapsed"); if (e) e.textContent = "（已等待 " + Math.round((Date.now() - t0) / 1000) + " 秒）"; }, 1000);
  try {
    const r = await fetch("/api/chat", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const ct = (r.headers.get("content-type") || "");

    if (ct.indexOf("text/event-stream") >= 0) {
      // 流式：逐段消费 SSE，边到边打字机渲染
      const reader = r.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "", acc = "", gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.indexOf("data: ") === 0);
          if (!line) continue;
          let obj; try { obj = JSON.parse(line.slice(6)); } catch (e) { continue; }
          // 打字机和工具步骤只画在「用户当前正在看的那条对话」上
          if (obj.delta && viewing()) { acc += obj.delta; streamInto(t, acc); }
          if (obj.step && viewing()) {
            const live = t.querySelector(".steps-live");
            if (live) {
              const d = document.createElement("div"); d.className = "step-live" + (obj.step.isError ? " err" : "");
              d.textContent = (obj.step.isError ? "⚠️ " : "🔧 ") + (obj.step.name || "工具") + (obj.step.args ? " " + obj.step.args : "");
              live.appendChild(d);
              chat.scrollTop = chat.scrollHeight;
            }
          }
          if (obj.done) {
            gotDone = true;
            clearInterval(tick); t.remove();
            // 界面已经不在目标对话上了：只标未读 + 刷列表，一个字都不写进当前视图
            if (!viewing()) { markUnread(targetId); await refreshList(); return; }
            if (obj.stopped) { renderChat(obj.messages); showStoppedBar(); cm.textContent = "已停止"; }
            else if (obj.ok) { renderChat(obj.messages); cm.textContent = "第 " + obj.turns + " 轮 · 常驻 agent 会话续接"; }
            else { if (Array.isArray(obj.messages)) renderChat(obj.messages); else bubbleSys("执行失败：" + (obj.error || "")); cm.textContent = ""; }
            await refreshList();
          }
        }
      }
      // 保险：流异常结束却没收到 done
      if (!gotDone) {
        clearInterval(tick); t.remove();
        if (!viewing()) { markUnread(targetId); await refreshList(); return; }
        if (acc) renderMessage({ role: "assistant", text: acc, ts: Date.now() });
        await refreshList();
      }
    } else {
      // 非流式（预检错误 / needKey / busy 等 JSON）
      const j = await r.json().catch(() => null);
      clearInterval(tick); t.remove();
      // 界面已切走：结果也好、报错也好，都只标未读，不往别的对话里插气泡
      if (!viewing()) { markUnread(targetId); await refreshList(); return; }
      if (!r.ok && r.status === 409 && j && j.needKey) {
        needKeyBubble(); cm.textContent = "";
      } else if (!r.ok && r.status === 409 && j && j.busy) {
        bubbleSys(j.error || "上一个还在跑，请先停止或等它结束"); cm.textContent = "";
      } else if (j && j.stopped) {
        renderChat(j.messages); showStoppedBar(); cm.textContent = "已停止";
      } else if (j && j.ok) {
        renderChat(j.messages);
        cm.textContent = "第 " + j.turns + " 轮 · 常驻 agent 会话续接";
      } else {
        const err = (j && j.error) ? j.error : ("HTTP " + r.status);
        if (j && Array.isArray(j.messages)) renderChat(j.messages);
        else bubbleSys("执行失败：" + err);
        cm.textContent = "";
      }
      await refreshList();
    }
  } catch (x) {
    clearInterval(tick); t.remove();
    if (!viewing()) { await refreshList(); return; }
    bubbleSys("请求出错：" + x.message); cm.textContent = "";
  } finally {
    setBusy(false);
  }
}

async function ask(msg) {
  // composerLocked 这里再兜一道：输入框 disabled 挡得住手点，挡不住脚本/回车以外的路径
  if (state.busy || state.composerLocked || !msg.trim()) return;
  // 只有「图生*」才必须有参考图；「文生*」和「自动」都不强制用户先传图
  const genCfg = genTypeCfg(state.genType);
  if (genCfg.needsRef && !pendingImage) {
    alert("「" + genCfg.label + "」需要一张参考图，请先点输入框左下角的 + 上传图片。");
    return;
  }
  // 还有媒体在传就别发：传一半的项 url 是空的，发出去等于附件丢了还不自知
  if (mediaUploading()) {
    composerNotice("还有文件正在上传，请等传完再发送", "err");
    return;
  }
  if (!state.activeId) {
    const id = await newConversation();
    if (!id) return;
  }
  ta.value = ""; ta.style.height = "auto";
  const payload = { conversationId: state.activeId, message: msg };
  // M2：把当前/引用面板作为上下文传给后端，让 LLM 理解「这个面板」等指代
  if (currentPanel) payload.context = { panel: currentPanel, panelLabel: TITLES[currentPanel] || currentPanel };
  if (pendingImage) payload.image = pendingImage;
  // 文本文档：只传后端返回的 url 列表（/uploads/<租户>/<随机名>.<ext>），
  // 正文由服务端读出来注入上下文，URL 本身不下发给模型。
  if (pendingDocs.length) payload.documents = pendingDocs.map(d => d.url);
  // 音视频：提交 [{ type:"video"|"audio", url }]，气泡里由 chat-media.js 渲成播放器。
  // 只传 url 不传文件本体 —— 落盘和租户隔离都在基座 /api/upload-media 那边做完了。
  // 只挑传完的（有 url 且 uploading 为 false）：正在传的那条 url 还是空的。
  const readyMedia = pendingMedia.filter(m => m && m.url && !m.uploading);
  let optimisticMedia = null;
  if (readyMedia.length) {
    // 发给后端：严格 { type, url } 两个字段
    payload.media = readyMedia.map(m => ({ type: m.type, url: m.url }));
    // 乐观渲染那份额外带封面（视频首帧），气泡里不至于先黑一块再出画面
    optimisticMedia = readyMedia.map(m => ({ type: m.type, url: m.url, poster: m.poster || undefined }));
  }
  // 素材生成类型：text2image / image2image / text2video / image2video。
  // 选「自动」时不传，交给 Agent 自己判断，免得普通问答被带偏成素材生成。
  if (genCfg.taskType) payload.taskType = genCfg.taskType;
  // 立即渲染用户消息（乐观更新），AI 回复回来后再用服务器完整列表覆盖
  // media 也要带进乐观渲染，否则发出去要等服务器往返回来才看到播放器，像没发成功。
  renderMessage({
    role: "user", text: msg, ts: Date.now(),
    image: pendingImage || undefined, documents: payload.documents,
    media: optimisticMedia || payload.media,
  });
  chat.scrollTop = chat.scrollHeight;
  clearPendingImage();
  clearPendingDocs();
  clearPendingMedia();
  await runChat(payload);
}

async function regenerate() {
  if (state.busy || !state.activeId) return;
  await runChat({ conversationId: state.activeId, regenerate: true });
}

/* ---- ⑤ 分岔：以某条 assistant 之前的上下文重新生成 ---- */
async function branch(index) {
  if (state.busy || !state.activeId) return;
  await runChat({ conversationId: state.activeId, branchFrom: index });
}

/* ---- ⑥ 归档 / 恢复 ---- */
async function toggleArchive(c) {
  try {
    await fetch("/api/conversations/" + encodeURIComponent(c.id) + (c.archived ? "/unarchive" : "/archive"), {
      method: "POST", credentials: "same-origin",
    });
    await refreshList();
  } catch (e) { /* 静默 */ }
}

/* 顶部「该对话已归档 · 只读」提示条上的「恢复」按钮。
 * 不新建接口 —— 直接复用上面 toggleArchive 里已有的那条 /unarchive 请求。 */
const archRestoreBtn = $("#archRestore");
if (archRestoreBtn) archRestoreBtn.addEventListener("click", async () => {
  const id = state.activeId;
  const c = (state.list || []).find((x) => x.id === id);
  if (!c || !c.archived || state.busy) return;
  archRestoreBtn.disabled = true; archRestoreBtn.textContent = "恢复中…";
  try { await toggleArchive(c); } catch (e) { /* toggleArchive 内部已静默 */ }
  archRestoreBtn.disabled = false; archRestoreBtn.textContent = "恢复";
  // 恢复了才解锁：请求失败时列表里它还是 archived，这里会重新锁上，不骗用户说好了
  setComposerLocked(convIsArchived(id));
});

/* ---- ⑧ 导出（Content-Disposition 触发下载） ---- */
function exportConversation(c, fmt) {
  const a = document.createElement("a");
  a.href = "/api/conversations/" + encodeURIComponent(c.id) + "/export?fmt=" + (fmt || "md");
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---- M2：@ 引用数据面板（弹出面板列表，选中后随消息传给后端） ---- */
const mentionMenu = document.createElement("div");
mentionMenu.className = "mention-menu";
mentionMenu.hidden = true;
document.body.appendChild(mentionMenu);
let mentionStart = -1;

function closeMentionMenu() { mentionMenu.hidden = true; mentionStart = -1; }

function renderMentionItems() {
  mentionMenu.replaceChildren();
  DATA_PANELS.forEach(p => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-item";
    item.innerHTML = '<span class="mi-ico">▦</span><span class="mi-label">' + (TITLES[p] || p) + "</span>";
    item.addEventListener("mousedown", e => e.preventDefault()); // 抢在 textarea blur 前
    item.addEventListener("click", () => {
      const label = TITLES[p] || p;
      const before = mentionStart >= 0 ? ta.value.slice(0, mentionStart) : ta.value;
      ta.value = before + "@" + label + " ";
      currentPanel = p;
      closeMentionMenu();
      ta.focus();
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    mentionMenu.appendChild(item);
  });
}

function openMentionMenu(start) {
  mentionStart = start;
  renderMentionItems();
  mentionMenu.hidden = false;
  const rect = ta.getBoundingClientRect();
  const menuH = mentionMenu.offsetHeight;
  mentionMenu.style.left = rect.left + "px";
  mentionMenu.style.top = Math.max(4, rect.top - menuH - 6) + "px";
}

// 光标前紧邻 @ 时弹出面板列表
ta.addEventListener("input", () => {
  if (mentionMenu.hidden) {
    const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    if (pos >= 1 && ta.value[pos - 1] === "@") openMentionMenu(pos - 1);
  }
});
document.addEventListener("click", e => {
  if (!mentionMenu.hidden && !e.target.closest(".mention-menu")) closeMentionMenu();
});
ta.addEventListener("keydown", e => { if (e.key === "Escape") closeMentionMenu(); });

send.addEventListener("click", () => ask(ta.value));
newBtn.addEventListener("click", () => newConversation());
stopBtn.addEventListener("click", async () => {
  if (!state.busy) return;
  try { await fetch("/api/chat/stop", { method: "POST", credentials: "same-origin" }); } catch (e) { /* 静默 */ }
});
ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(ta.value); } });
ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 170) + "px"; });
/* ---- 快捷问题：读 /api/skills 动态渲染，有几个技能显示几个 ---- */
/* QUICK_QUESTIONS_BEGIN */
// 取一个技能「点击即可问」的例句。优先基座给的 sampleQuestion；
// 基座没给例句时，用技能标题兜底拼一句，保证按钮数量始终 = 技能数量。
function pickQuickQuestion(s) {
  if (!s || typeof s !== "object") return "";
  let q = "";
  if (typeof s.sampleQuestion === "string") q = s.sampleQuestion.trim();
  else if (typeof s.sample_question === "string") q = s.sample_question.trim();
  if (q) return q;
  const t = (typeof s.title === "string" ? s.title.trim() : "")
    || (typeof s.id === "string" ? s.id.trim() : "");
  return t ? t + " 可以帮我做什么？" : "";
}

// 把技能列表渲染成按钮。P1-3：一律 textContent 赋值，杜绝 innerHTML 注入。
// box / onPick 可注入（自动化测试用），默认写 #quickRow、点击走真实提问 ask()。
function renderQuickRow(skills, box, onPick) {
  const target = box || $("#quickRow");
  if (!target) return 0;
  target.textContent = "";
  const list = Array.isArray(skills) ? skills : [];
  let n = 0;
  for (const s of list) {
    const q = pickQuickQuestion(s);
    if (!q) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    if (s && s.id) b.dataset.skillId = String(s.id);
    if (s && s.title) b.title = "技能：" + s.title;
    b.addEventListener("click", () => (onPick || ask)(q));
    target.appendChild(b);
    n++;
  }
  target.hidden = n === 0;  // 没有可用例句时整块收起，不留空 margin
  return n;
}

async function loadQuickQuestions() {
  try {
    const r = await fetch("/api/skills", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    renderQuickRow(j && Array.isArray(j.skills) ? j.skills : []);
  } catch (e) { /* 静默：拿不到技能列表就保持收起，不影响主流程 */ }
}
/* QUICK_QUESTIONS_END */

/* ---- 用户菜单（底部头像点击弹出） ---- */
const userEntry = $("#userEntry"), userMenu = $("#userMenu");
function closeUserMenu() {
  userEntry.classList.remove("open");
  userMenu.hidden = true;
}
function openUserMenu() {
  userEntry.classList.add("open");
  userMenu.hidden = false;
}
if (userEntry && userMenu) {
  userEntry.addEventListener("click", e => {
    e.stopPropagation();
    if (userMenu.hidden) openUserMenu(); else closeUserMenu();
  });
  document.addEventListener("click", e => {
    if (!userMenu.hidden && !userMenu.contains(e.target) && !userEntry.contains(e.target)) {
      closeUserMenu();
    }
  });
  // 点菜单项（非链接）后自动关闭并跳转对应视图
  userMenu.querySelectorAll(".um-item[data-goto]").forEach(it => {
    it.addEventListener("click", () => { closeUserMenu(); switchView(it.dataset.goto); });
  });
}

/* ---- 技能 ---- *//* ---- ⑨ 素材上传：图片 / 视频生成（选择类型 + Ctrl+V 粘贴 + 拖拽） ---- */
const imgInput = $("#imgInput"), imgBtn = $("#imgBtn"), imgPreview = $("#imgPreview"), imgThumb = $("#imgThumb"), imgClear = $("#imgClear");
const genTypeEl = $("#genType"), genHintEl = $("#genHint"), emptyInputEl = $("#emptyInput");
const docInput = $("#docInput"), docBtn = $("#docBtn"), docListEl = $("#docList"), composerNoticeEl = $("#composerNotice");
const mediaInput = $("#mediaInput"), mediaBtn = $("#mediaBtn"), mediaListEl = $("#mediaList");
let pendingImage = null;

/* 素材生成类型：与 media.route 的 taskType 一一对应。
 * needsRef = 是否必须有一张参考图（「图生*」需要；「文生*」不需要，不强制用户先传图）。
 * accept   = 该类型允许的参考素材。目前 media.route 没有 video2video、/api/upload 也只收图片，
 *            所以参考素材统一是 image/*；将来后端放开视频参考素材，只改这一张表即可。
 * auto     = 不指定，交给 Agent 自己判断（默认，避免普通问答被带偏成素材生成）。 */
const GEN_TYPES = {
  auto:        { label: "自动",     taskType: null,           needsRef: false, accept: "image/*" },
  text2image:  { label: "文生图",   taskType: "text2image",   needsRef: false, accept: "image/*" },
  image2image: { label: "图生图",   taskType: "image2image",  needsRef: true,  accept: "image/*" },
  text2video:  { label: "文生视频", taskType: "text2video",   needsRef: false, accept: "image/*" },
  image2video: { label: "图生视频", taskType: "image2video",  needsRef: true,  accept: "image/*" },
};
const DEFAULT_GEN_TYPE = "auto";
state.genType = DEFAULT_GEN_TYPE;

function genTypeCfg(t) { return GEN_TYPES[t] || GEN_TYPES[DEFAULT_GEN_TYPE]; }

function setGenType(t) {
  if (!GEN_TYPES[t]) t = DEFAULT_GEN_TYPE;
  state.genType = t;
  const cfg = genTypeCfg(t);
  if (genTypeEl) genTypeEl.querySelectorAll(".gt-btn").forEach(b => b.classList.toggle("on", b.dataset.type === t));
  if (imgInput) imgInput.accept = cfg.accept;          // accept 随类型动态写入，不再写死 image/*
  if (genHintEl) genHintEl.textContent = cfg.needsRef ? "需要一张参考图" : "不需要参考图，可直接描述";
  if (imgBtn) imgBtn.title = cfg.needsRef ? "添加参考图（这个类型需要）" : "添加参考图（可选）";
}

if (genTypeEl) {
  genTypeEl.querySelectorAll(".gt-btn").forEach(b => {
    b.addEventListener("click", () => setGenType(b.dataset.type));
  });
}
setGenType(DEFAULT_GEN_TYPE);

function setPendingImage(url) { pendingImage = url; imgThumb.src = url; imgPreview.hidden = false; }
function clearPendingImage() { pendingImage = null; imgThumb.removeAttribute("src"); imgPreview.hidden = true; if (imgInput) imgInput.value = ""; }

/** 通用拖拽投放区：dragenter / dragover / dragleave / drop 这套逻辑只写一次，
 *  导入面板（#impDrop）和聊天输入区（#emptyInput）都复用它，不各写一遍。 */
function attachDropZone(zone, onFile, overClass) {
  if (!zone) return;
  const cls = overClass || "over";
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add(cls); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove(cls); }));
  zone.addEventListener("drop", e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && onFile) onFile(f);
  });
}

/** 读文件 → dataURL（base64）。 */
function readFileAsDataUrl(f) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result));
    rd.onerror = () => reject(new Error("读取失败"));
    rd.readAsDataURL(f);
  });
}

/** 上传一张图片（dataURL）→ setPendingImage。 */
async function uploadImageDataUrl(b64) {
  try {
    const r = await fetch("/api/upload", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: b64 }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok && j.url) { setPendingImage(j.url); return true; }
    composerNotice((j && j.error) || "上传失败", "err");
    return false;
  } catch (e) { composerNotice("上传失败：" + e.message, "err"); return false; }
}

/* ---- 文本文档上传（.txt / .md / .csv，单文件 ≤5MB）----
 * 走基座已合并的 POST /api/upload-doc，只把返回的 url 存下来，
 * 发消息时作为 documents 数组提交；正文由后端读出来注入上下文（URL 本身不给模型）。
 * 下面的扩展名 / 体积校验只是「早点给提示」，后端还会按内容再判一次纯文本，两道都在。 */
const DOC_EXT_WHITELIST = new Set(["txt", "md", "csv"]);
const DOC_MAX_BYTES = 5 * 1024 * 1024;
let pendingDocs = [];   // [{ url, name, size, chars }]

function docExtOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "").trim());
  return m ? m[1].toLowerCase() : "";
}
function isDocFile(f) { return !!f && DOC_EXT_WHITELIST.has(docExtOf(f.name)); }
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

/** 输入区提示条：上传成功/失败都说清楚，不用 alert 打断正在打的字。 */
let noticeTimer = null;
function composerNotice(msg, kind) {
  msg = String(msg == null ? "" : msg);
  if (!composerNoticeEl) { if (typeof alert === "function") alert(msg); return; }
  composerNoticeEl.hidden = false;
  composerNoticeEl.className = "composer-notice" + (kind === "ok" ? " ok" : "");
  composerNoticeEl.innerHTML =
    '<span class="ico" data-ico="' + (kind === "ok" ? "checkCircle" : "warn") + '"></span><span class="cn-text"></span>';
  const slot = composerNoticeEl.querySelector(".cn-text");
  if (slot) slot.textContent = msg;
  if (window.initIcons) window.initIcons();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { composerNoticeEl.hidden = true; }, kind === "ok" ? 3000 : 6000);
}

/** 已附加文档的胶囊列表（可逐个移除）。 */
function renderDocList() {
  if (!docListEl) return;
  docListEl.hidden = !pendingDocs.length;
  docListEl.innerHTML = "";
  pendingDocs.forEach((d, i) => {
    const chip = document.createElement("div");
    chip.className = "doc-chip";
    chip.innerHTML = '<span class="ico" data-ico="fileText"></span>';
    const nm = document.createElement("span");
    nm.className = "doc-name"; nm.textContent = d.name || "文档"; nm.title = d.name || "";
    const sz = document.createElement("span");
    sz.className = "doc-size"; sz.textContent = fmtSize(d.size);
    const del = document.createElement("button");
    del.type = "button"; del.className = "doc-del"; del.title = "移除这个文档"; del.textContent = "×";
    del.addEventListener("click", () => { pendingDocs.splice(i, 1); renderDocList(); });
    chip.appendChild(nm); chip.appendChild(sz); chip.appendChild(del);
    docListEl.appendChild(chip);
  });
  if (window.initIcons) window.initIcons();
}
function clearPendingDocs() { pendingDocs = []; renderDocList(); if (docInput) docInput.value = ""; }

/** 上传一个文本文档 → 加入 pendingDocs。任何一步失败都给出具体原因。 */
async function uploadDocFile(f) {
  if (!f) return false;
  const name = f.name || "未命名文件";
  if (!DOC_EXT_WHITELIST.has(docExtOf(name))) {
    composerNotice("只支持 .txt / .md / .csv 纯文本文档，「" + name + "」不是", "err");
    return false;
  }
  if (!f.size) { composerNotice("「" + name + "」是空文件，没有可读取的内容", "err"); return false; }
  if (f.size > DOC_MAX_BYTES) {
    composerNotice("文档太大：单文件上限 5MB，「" + name + "」是 " + fmtSize(f.size), "err");
    return false;
  }
  let b64;
  try { b64 = await readFileAsDataUrl(f); }
  catch (e) { composerNotice("读取失败：" + e.message, "err"); return false; }
  try {
    const r = await fetch("/api/upload-doc", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, data: b64 }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok && j.url) {
      pendingDocs.push({ url: j.url, name: name, size: j.size || f.size, chars: j.chars || 0 });
      renderDocList();
      composerNotice("已附加「" + name + "」（" + fmtSize(j.size || f.size) + "）", "ok");
      return true;
    }
    // 后端拒绝（非文本 / 超限 / 配额满 / 非本租户）都把原因原样说清楚
    composerNotice((j && j.error) || ("上传失败（HTTP " + r.status + "）"), "err");
    return false;
  } catch (e) {
    composerNotice("上传失败：" + (e && e.message ? e.message : "网络错误"), "err");
    return false;
  }
}

/* ---- 音视频上传（video/* 与 audio/*，单文件 ≤50MB）----
 * 走基座新增的 POST /api/upload-media，只把返回的 url 存下来，
 * 发消息时作为 media 数组提交（[{ type:"video"|"audio", url }]），
 * 气泡里由 chat-media.js 渲成 <video> / <audio> 播放器（那条路 renderMessage 已接好）。
 *
 * 请求体：{ name, data, kind } —— 与 /api/upload-doc 同一个形状。kind 是前端按 MIME/扩展名判出来的，
 *         基座可以忽略它、按文件魔数自己判（server.cjs 的 detectMediaType）；
 *         气泡里最终用什么标签也以**响应里的 type/kind** 为准，响应没给时才退回前端判的 kind
 *         （后端现在返回的是 kind 字段，normMediaType 两种都认，也能挡住非 video/audio 的脏值）。
 * 响应体：{ ok:true, url, size, kind, ext }
 *
 * 下面的类型 / 体积校验只是「早点给提示」，后端还会按魔数再判一次，两道都在。
 * 50MB 上限与后端 MEDIA_UPLOAD_MAX_BYTES（PT_MEDIA_UPLOAD_MB 默认 50）保持一致。 */
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** MIME 为空时（.mkv/.mov 这类浏览器经常给不出 MIME）按扩展名兜底。
 *  与基座 detectMediaType 的魔数白名单**一一对应** —— 后端按内容只认这 6 种，
 *  前端收窄到同一份，用户传 .mkv/.flac 这类后端不认的格式时能立刻提示，
 *  不用等传完几十 MB 才被后端退回来。改后端魔数白名单时记得同步这里。 */
const MEDIA_EXT_KIND = {
  mp4: "video", webm: "video", mov: "video",     // 视频
  mp3: "audio", wav: "audio", m4a: "audio",      // 音频
};
let pendingMedia = [];   // [{ type:"video"|"audio", url, name, size }]

/** 只认 "video" / "audio" 两个值，其它（含空、大小写混写）一律返回空串由调用方兜底。 */
function normMediaType(t) {
  const s = String(t == null ? "" : t).toLowerCase().trim();
  return (s === "video" || s === "audio") ? s : "";
}

/** 判文件是视频还是音频：先看 MIME（浏览器给的准），MIME 为空（.mkv/.mov 常见）再看扩展名。 */
function mediaKindOf(f) {
  const mime = String((f && f.type) || "").toLowerCase().trim();
  if (/^video\//.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  return MEDIA_EXT_KIND[docExtOf(f && f.name)] || "";
}

function mediaKindLabel(kind) { return kind === "audio" ? "音频" : "视频"; }

/* ---- 上传耗时的说法 ---- */
/** 秒数说成人话：8 秒 / 1 分 20 秒 / 3 分钟。 */
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return sec + " 秒";
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? (m + " 分 " + s + " 秒") : (m + " 分钟");
}

/* 大文件预告用的保守估算（3MB/s）。真实速度要等传起来才知道，
 * 所以这里只负责「传之前先给个心理预期」，传起来后进度条上会按实测速度刷新。 */
const MEDIA_ESTIMATE_BPS = 3 * 1024 * 1024;
const MEDIA_NOTICE_ABOVE = 8 * 1024 * 1024;   // 超过 8MB 才预告，小文件不至于啰嗦

/** 带上传进度的 JSON POST。
 *  用 XHR 而不是 fetch —— fetch 到现在都没有上传进度回调，几十 MB 的文件
 *  传起来用户只能盯着空白干等。onStart 把 xhr 交出去，好让「取消」能 abort。 */
function postJsonWithProgress(url, body, onProgress, onStart) {
  return new Promise((resolve, reject) => {
    let xhr;
    try { xhr = new XMLHttpRequest(); }
    catch (e) { reject(new Error("当前浏览器不支持上传")); return; }
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.withCredentials = true;
    if (xhr.upload && onProgress) {
      xhr.upload.addEventListener("progress", (e) => {
        if (e && e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.addEventListener("load", () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, json: j });
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误")));
    xhr.addEventListener("timeout", () => reject(new Error("上传超时")));
    xhr.addEventListener("abort", () => reject(new Error("已取消上传")));
    if (onStart) onStart(xhr);
    xhr.send(JSON.stringify(body));
  });
}

/* ---- 预览信息：视频首帧 / 音频波形 / 时长 ----
 * 三件事都要解码媒体文件，慢且可能失败（编码不支持、跨域、浏览器不给解）。
 * 所以统一做成「尽力而为」：拿不到就当没这个功能，绝不影响媒体已经附加成功这件事。 */

/** 秒 → 1:23 / 0:05。 */
function fmtClock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

/** 读时长（秒）。拿不到返回 0。 */
function readMediaDuration(url, kind) {
  return new Promise((resolve) => {
    try {
      const el = document.createElement(kind === "audio" ? "audio" : "video");
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v || 0); } };
      el.preload = "metadata";
      el.addEventListener("loadedmetadata", () => done(el.duration));
      el.addEventListener("error", () => done(0));
      setTimeout(() => done(0), 8000);   // 兜底：别让一个坏文件把预览永久挂住
      el.src = url;
    } catch (e) { resolve(0); }
  });
}

/** 截视频首帧当封面：跳到第 1 秒（或时长中点，视频更短时）画到 canvas 上导出 dataURL。 */
function captureVideoPoster(url) {
  return new Promise((resolve) => {
    try {
      const v = document.createElement("video");
      let settled = false;
      const done = (u) => { if (!settled) { settled = true; resolve(u || null); } };
      v.preload = "metadata"; v.muted = true;
      try { v.crossOrigin = "anonymous"; } catch (e) { /* 跨域就放弃截图，canvas 会被污染 */ }
      v.addEventListener("loadeddata", () => {
        try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { done(null); }
      });
      v.addEventListener("seeked", () => {
        try {
          const c = document.createElement("canvas");
          c.width = 160; c.height = 90;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          done(c.toDataURL("image/jpeg", 0.7));
        } catch (e) { done(null); }
      });
      v.addEventListener("error", () => done(null));
      setTimeout(() => done(null), 8000);
      v.src = url;
    } catch (e) { resolve(null); }
  });
}

/** 音频波形：解码后取 40 个区间的峰值（0~1），画成静态柱状图。
 *  大文件解码慢，所以只对 ≤20MB 的算，超了就只显示时长。 */
const WAVE_MAX_BYTES = 20 * 1024 * 1024;
const WAVE_BARS = 40;
function computeAudioWaveform(url, size) {
  return new Promise((resolve) => {
    const AC = (window.AudioContext || window.webkitAudioContext);
    if (!AC || (size && size > WAVE_MAX_BYTES)) return resolve(null);
    fetch(url, { credentials: "same-origin" })
      .then((r) => r.arrayBuffer())
      .then((buf) => new Promise((ok2, no2) => {
        const ac = new AC();
        ac.decodeAudioData(buf, ok2, no2);
      }))
      .then((ab) => {
        try {
          const ch = ab.getChannelData(0);
          const step = Math.max(1, Math.floor(ch.length / WAVE_BARS));
          const peaks = [];
          let max = 0;
          for (let i = 0; i < WAVE_BARS; i++) {
            let p = 0;
            for (let j = 0; j < step; j++) {
              const v = Math.abs(ch[i * step + j] || 0);
              if (v > p) p = v;
            }
            peaks.push(p); if (p > max) max = p;
          }
          // 归一化，不然小声的音频画出来是一条平线
          resolve(max > 0 ? peaks.map((p) => p / max) : null);
          try { if (ac && ac.close) ac.close(); } catch (e) {}
        } catch (e) { resolve(null); }
      })
      .catch(() => resolve(null));
  });
}

/** 传完之后补预览。异步且不重要，所以每一步都先确认这条还在列表里（用户可能已经点了 ×）。 */
async function enrichMediaPreview(item) {
  const alive = () => pendingMedia.indexOf(item) >= 0;
  if (!alive() || !item.url) return;
  const dur = await readMediaDuration(item.url, item.type);
  if (!alive()) return;
  if (dur > 0) item.duration = dur;
  if (item.type === "video") item.poster = await captureVideoPoster(item.url);
  else if (item.type === "audio") item.peaks = await computeAudioWaveform(item.url, item.size);
  if (!alive()) return;
  item._previewDone = true;   // 收工标记：外面靠它判断预览补完了
  renderMediaList();   // 补完再刷一次，把缩略图 / 波形 / 时长显示出来
}

/** 刷新某一条的进度。onprogress 是高频回调，这里只改 fill 宽度和文案，不重绘整个列表。 */
function updateMediaProgress(item, loaded, total) {
  if (!item) return;
  item.loaded = loaded || 0;
  item.total = total || 0;
  const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  if (item._fill) item._fill.style.width = pct + "%";
  if (!item._txt) return;
  let s = pct + "%";
  // 头 1 秒拿到的速度没有参考价值（还在建连接），别瞎猜剩余时间
  const elapsed = (Date.now() - (item.startedAt || Date.now())) / 1000;
  if (elapsed > 1 && loaded > 0 && total) {
    const bps = loaded / elapsed;
    const remain = Math.max(0, (total - loaded) / Math.max(bps, 1));
    if (remain > 0.5) s += " · 还剩约 " + fmtDuration(remain);
  }
  item._txt.textContent = s;
}

/** 移除一条待发媒体；还在传就顺便 abort，不留一个永远转圈的胶囊。 */
function removePendingMedia(item) {
  const i = pendingMedia.indexOf(item);
  if (i < 0) return;
  if (item && item.xhr) { try { item.xhr.abort(); } catch (e) { /* 已经传完了 */ } }
  pendingMedia.splice(i, 1);
  renderMediaList();
}

/** 已附加音视频的胶囊列表（可逐个移除；上传中的显示进度条）。 */
function renderMediaList() {
  if (!mediaListEl) return;
  mediaListEl.hidden = !pendingMedia.length;
  mediaListEl.innerHTML = "";
  pendingMedia.forEach((m) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip media-chip" + (m.uploading ? " uploading" : "");
    chip.innerHTML = '<span class="ico" data-ico="' + (m.type === "audio" ? "music" : "play") + '"></span>';
    const nm = document.createElement("span");
    nm.className = "attach-name"; nm.textContent = m.name || "媒体文件"; nm.title = m.name || "";
    const sz = document.createElement("span");
    sz.className = "attach-size"; sz.textContent = fmtSize(m.size);
    chip.appendChild(nm); chip.appendChild(sz);

    if (m.uploading) {
      const bar = document.createElement("div"); bar.className = "mc-prog";
      const fill = document.createElement("div"); fill.className = "mc-prog-fill";
      bar.appendChild(fill);
      const txt = document.createElement("span"); txt.className = "mc-prog-txt";
      txt.textContent = "准备上传…";
      chip.appendChild(bar); chip.appendChild(txt);
      m._fill = fill; m._txt = txt;   // 存引用，onprogress 直接改这两个节点
    }

    // 传完之后补的预览：视频显示首帧缩略图，音频显示波形（都带时长）
    if (!m.uploading) {
      if (m.type === "video" && m.poster) {
        const th = document.createElement("div"); th.className = "mc-thumb";
        const im = document.createElement("img"); im.src = m.poster; im.alt = "";
        th.appendChild(im);
        if (m.duration) {
          const d = document.createElement("span"); d.className = "mc-dur";
          d.textContent = fmtClock(m.duration); th.appendChild(d);
        }
        chip.appendChild(th);
      } else if (m.type === "audio" && m.peaks && m.peaks.length) {
        const w = document.createElement("div"); w.className = "mc-wave";
        for (const p of m.peaks) {
          const bar = document.createElement("i");
          bar.style.height = Math.max(2, Math.round(p * 20)) + "px";
          w.appendChild(bar);
        }
        chip.appendChild(w);
      }
      // 视频没截到帧、音频没算出波形时，时长也要单独显示出来
      if (m.duration && !(m.type === "video" && m.poster)) {
        const dt = document.createElement("span");
        dt.className = "mc-durtext"; dt.textContent = fmtClock(m.duration);
        chip.appendChild(dt);
      }
    }

    const del = document.createElement("button");
    del.type = "button"; del.className = "attach-del";
    del.title = m.uploading ? "取消上传" : ("移除这个" + mediaKindLabel(m.type));
    del.textContent = "×";
    del.addEventListener("click", () => removePendingMedia(m));
    chip.appendChild(del);
    mediaListEl.appendChild(chip);
  });
  if (window.initIcons) window.initIcons();
}
function clearPendingMedia() {
  for (const m of pendingMedia) { if (m && m.xhr) { try { m.xhr.abort(); } catch (e) {} } }
  pendingMedia = []; renderMediaList(); if (mediaInput) mediaInput.value = "";
}
/** 还有东西在传就别发消息 —— 传一半的 url 是空的，发出去会丢附件。 */
function mediaUploading() { return pendingMedia.some((m) => m && m.uploading); }

/** 上传一个音视频 → 加入 pendingMedia。任何一步失败都给出具体原因。 */
async function uploadMediaFile(f) {
  if (!f) return false;
  const name = f.name || "未命名文件";
  const kind = mediaKindOf(f);
  if (!kind) {
    composerNotice("只支持视频或音频文件，「" + name + "」不是", "err");
    return false;
  }
  if (!f.size) { composerNotice("「" + name + "」是空文件，没有可播放的内容", "err"); return false; }
  if (f.size > MEDIA_MAX_BYTES) {
    composerNotice("媒体太大：单文件上限 50MB，「" + name + "」是 " + fmtSize(f.size), "err");
    return false;
  }
  // 大文件先给个心理预期：读文件 + 传几十 MB 要一会儿，别让用户以为卡住了
  if (f.size > MEDIA_NOTICE_ABOVE) {
    composerNotice("「" + name + "」" + fmtSize(f.size) + "，大约需要 "
      + fmtDuration(f.size / MEDIA_ESTIMATE_BPS) + "，请保持页面打开", "ok");
  }
  let b64;
  try { b64 = await readFileAsDataUrl(f); }
  catch (e) { composerNotice("读取失败：" + e.message, "err"); return false; }

  // 先插一条「上传中」的占位：文件读完了还得传好几秒，
  // 胶囊立刻出现，用户知道东西已经接住了（而不是以为按钮没反应）。
  const item = {
    type: kind, url: "", name: name, size: f.size,
    uploading: true, loaded: 0, total: 0, startedAt: 0, xhr: null, _fill: null, _txt: null,
  };
  pendingMedia.push(item);
  renderMediaList();

  try {
    const r = await postJsonWithProgress(
      "/api/upload-media",
      { name: name, data: b64, kind: kind },
      (loaded, total) => updateMediaProgress(item, loaded, total),
      (xhr) => { item.xhr = xhr; item.startedAt = Date.now(); },
    );
    const j = r.json;
    if (r.ok && j && j.ok && j.url) {
      const type = normMediaType(j.type != null ? j.type : j.kind) || kind;
      item.type = type; item.url = j.url; item.size = j.size || f.size;
      item.uploading = false; item.xhr = null; item._fill = null; item._txt = null;
      renderMediaList();
      composerNotice("已附加" + mediaKindLabel(type) + "「" + name + "」（" + fmtSize(item.size) + "）", "ok");
      // 缩略图 / 波形 / 时长要解码，慢 —— 放在「已附加」回执之后再补，别让它拖慢反馈
      enrichMediaPreview(item);
      return true;
    }
    // 后端拒绝（类型不支持 / 超限 / 配额满 / 非本租户）都把原因原样说清楚
    removePendingMedia(item);   // 失败就把占位撤掉，不留一个永远转圈的胶囊
    composerNotice((j && j.error) || ("上传失败（HTTP " + r.status + "）"), "err");
    return false;
  } catch (e) {
    removePendingMedia(item);
    composerNotice("上传失败：" + (e && e.message ? e.message : "网络错误"), "err");
    return false;
  }
}

/** 聊天框收到一个文件 —— 点「+」/「文档」/「音视频」选择、拖进来、Ctrl+V 粘贴，几条路都走这里。 */
async function handleComposerFile(f) {
  if (!f) return;
  if (isDocFile(f)) { await uploadDocFile(f); return; }          // 文档 → /api/upload-doc
  if (mediaKindOf(f)) { await uploadMediaFile(f); return; }      // 音视频 → /api/upload-media
  if (!/^image\//.test(f.type || "")) {
    composerNotice("只支持图片（参考素材）、音视频，或 .txt / .md / .csv 文档，「" + (f.name || "未命名文件") + "」都不是", "err");
    return;
  }
  if (f.size > 15 * 1024 * 1024) { composerNotice("素材太大（≤15MB）", "err"); return; }
  try { await uploadImageDataUrl(await readFileAsDataUrl(f)); }
  catch (e) { composerNotice("读取失败：" + e.message, "err"); }
}

if (imgBtn) imgBtn.addEventListener("click", () => imgInput.click());
if (docBtn) docBtn.addEventListener("click", () => { if (docInput) docInput.click(); });
if (mediaBtn) mediaBtn.addEventListener("click", () => { if (mediaInput) mediaInput.click(); });
if (mediaInput) mediaInput.addEventListener("change", async () => {
  const files = Array.prototype.slice.call(mediaInput.files || []);
  for (const f of files) await uploadMediaFile(f);
  mediaInput.value = "";   // 清空，同一个文件可以再选一次
});
if (docInput) docInput.addEventListener("change", async () => {
  const files = Array.prototype.slice.call(docInput.files || []);
  for (const f of files) await uploadDocFile(f);
  docInput.value = "";   // 清空，同一个文件可以再选一次
});
if (imgClear) imgClear.addEventListener("click", clearPendingImage);
if (imgInput) imgInput.addEventListener("change", async () => {
  const f = imgInput.files && imgInput.files[0];
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) { composerNotice("素材太大（≤15MB）", "err"); imgInput.value = ""; return; }
  await handleComposerFile(f);
});

// 把素材直接拖进聊天输入区：复用 impDrop 那套 drop 逻辑（attachDropZone）
attachDropZone(emptyInputEl, handleComposerFile);

// NEW-1：Ctrl+V / 右键粘贴图片（读剪贴板 image/* 项，自动上传并预览）
if (ta) ta.addEventListener("paste", async (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let imgItem = null;
  for (const it of items) {
    if (it && it.kind === "file" && /^image\//.test(it.type || "")) { imgItem = it; break; }
  }
  if (!imgItem) return; // 剪贴板没有图片：走默认文本粘贴
  e.preventDefault(); // 拦截，避免图片以 base64 文本污染输入框
  const f = imgItem.getAsFile();
  if (!f) return;
  await handleComposerFile(f);
});

/* ---- ⑦ 搜索 ---- */
const search = $("#search"), searchResults = $("#searchResults");
let searchTimer = null;
if (search) search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = search.value.trim();
  if (!q) { searchResults.hidden = true; searchResults.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/conversations/search?q=" + encodeURIComponent(q), { credentials: "same-origin" });
      const j = await r.json().catch(() => null);
      const list = (j && Array.isArray(j.conversations)) ? j.conversations : [];
      searchResults.innerHTML = "";
      if (!list.length) {
        const e = document.createElement("div"); e.className = "sr-empty"; e.textContent = "没有匹配的对话";
        searchResults.appendChild(e);
      } else {
        for (const c of list) {
          const it = document.createElement("div"); it.className = "sr-item";
          const t = document.createElement("div"); t.className = "sr-title"; t.textContent = c.title || "新对话";
          const sub = document.createElement("div"); sub.className = "sr-sub";
          sub.textContent = (c.preview || "") + " · " + fmtShort(c.updated_at);
          it.appendChild(t); it.appendChild(sub);
          it.addEventListener("click", () => { searchResults.hidden = true; searchResults.innerHTML = ""; search.value = ""; openConversation(c.id); });
          searchResults.appendChild(it);
        }
      }
      searchResults.hidden = false;
    } catch (e) { /* 静默 */ }
  }, 220);
});
if (searchResults) document.addEventListener("click", (e) => {
  if (search && searchResults && !search.contains(e.target) && !searchResults.contains(e.target)) searchResults.hidden = true;
});

/* ---- ⑩ 模型切换 ---- */
const modelSelect = $("#modelSelect");
async function loadModels() {
  if (!modelSelect) return;
  try {
    const r = await fetch("/api/models", { credentials: "same-origin" });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !Array.isArray(j.models)) return;
    modelSelect.innerHTML = "";
    for (const m of j.models) {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.name || m.id;
      if (m.id === j.current) o.selected = true;
      modelSelect.appendChild(o);
    }
    syncModelCapsule();
  } catch (e) { /* 静默 */ }
}
function syncModelCapsule() {
  const sel = $("#msBtnName");
  if (!sel || !modelSelect) return;
  const opt = modelSelect.options[modelSelect.selectedIndex];
  sel.textContent = opt ? opt.textContent : "—";
}
function buildModelMenu() {
  const menu = $("#modelMenu"); if (!menu || !modelSelect) return;
  menu.innerHTML = "";

  // 搜索框
  const search = document.createElement("div"); search.className = "model-search";
  const si = document.createElement("input"); si.type = "text"; si.placeholder = "搜索模型名、ID…"; si.autocomplete = "off";
  const clearBtn = document.createElement("button"); clearBtn.type = "button"; clearBtn.className = "ms-clear"; clearBtn.textContent = "×"; clearBtn.hidden = true;
  search.appendChild(si); search.appendChild(clearBtn);
  menu.appendChild(search);

  // 列表容器（独立滚动，搜索框固定在 menu 顶部）
  const list = document.createElement("div"); list.className = "model-list";
  menu.appendChild(list);

  const allOptions = Array.from(modelSelect.options);
  const renderList = (keyword) => {
    list.innerHTML = "";
    const kw = (keyword || "").trim().toLowerCase();
    const filtered = kw ? allOptions.filter(o => (o.textContent || "").toLowerCase().includes(kw) || (o.value || "").toLowerCase().includes(kw)) : allOptions;
    if (!filtered.length) {
      const e = document.createElement("div"); e.className = "model-menu-empty"; e.textContent = "无匹配模型"; list.appendChild(e); return;
    }
    for (const o of filtered) {
      const item = document.createElement("div");
      item.className = "model-menu-item" + (o.selected ? " active" : "");
      item.innerHTML = '<span class="mi-check">' + (o.selected ? "✓" : "") + '</span><span class="mi-label">' + o.textContent + '</span>';
      item.addEventListener("click", () => {
        modelSelect.value = o.value;
        modelSelect.dispatchEvent(new Event("change"));
        closeModelMenu();
      });
      list.appendChild(item);
    }
  };
  renderList("");

  si.addEventListener("input", () => { clearBtn.hidden = !si.value; renderList(si.value); });
  clearBtn.addEventListener("click", () => { si.value = ""; clearBtn.hidden = true; renderList(""); si.focus(); });

  // 聚焦搜索框
  setTimeout(() => si.focus(), 0);
}
function openModelMenu() { buildModelMenu(); $("#modelMenu").hidden = false; $("#msBtn").classList.add("open"); }
function closeModelMenu() { $("#modelMenu").hidden = true; $("#msBtn").classList.remove("open"); }
const msBtn = $("#msBtn");
if (msBtn) {
  msBtn.addEventListener("click", (e) => { e.stopPropagation(); const m = $("#modelMenu"); if (m.hidden) openModelMenu(); else closeModelMenu(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".model-switcher")) closeModelMenu(); });
}
if (modelSelect) modelSelect.addEventListener("change", async () => {
  syncModelCapsule();
  const model = modelSelect.value;
  if (!model) return;
  try {
    const r = await fetch("/api/models/select", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
    });
    const j = await r.json().catch(() => null);
    if (!(j && j.ok)) alert((j && j.error) || "切换失败");
  } catch (e) { alert("切换失败：" + e.message); }
});

/* ---- ⑪ 长期记忆面板 ---- */
async function loadMemory() {
  const list = $("#memList");
  if (!list) return;
  list.innerHTML = '<div class="mem-empty">读取中…</div>';
  try {
    const j = await (await fetch("/api/memory", { credentials: "same-origin" })).json();
    const items = (j && Array.isArray(j.memories)) ? j.memories : [];
    list.innerHTML = "";
    if (!items.length) { list.innerHTML = '<div class="mem-empty">还没有长期记忆。添加后，会注入到每次对话的上下文开头。</div>'; return; }
    for (const m of items) {
      const row = document.createElement("div"); row.className = "mem-row";
      const k = document.createElement("div"); k.className = "mem-key"; k.textContent = m.key;
      const v = document.createElement("div"); v.className = "mem-val"; v.textContent = m.value;
      const del = document.createElement("button"); del.className = "mem-del"; del.textContent = "删除";
      del.addEventListener("click", async () => {
        await fetch("/api/memory?key=" + encodeURIComponent(m.key), { method: "DELETE", credentials: "same-origin" });
        loadMemory();
      });
      row.appendChild(k); row.appendChild(v); row.appendChild(del);
      list.appendChild(row);
    }
  } catch (e) { list.innerHTML = '<div class="mem-empty">读取失败：' + e.message + '</div>'; }
}
const memAdd = $("#memAdd");
if (memAdd) memAdd.addEventListener("click", async () => {
  const key = $("#memKey").value.trim(), val = $("#memVal").value.trim();
  if (!key || !val) { alert("记忆名和内容都要填"); return; }
  const r = await fetch("/api/memory", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value: val }),
  });
  const j = await r.json().catch(() => null);
  if (j && j.ok) { $("#memKey").value = ""; $("#memVal").value = ""; loadMemory(); }
  else alert((j && j.error) || "保存失败");
});

/* ---- 技能：卡片 → 详情（说明 + 去使用 + 按需连接账户引导） ---- */
/* SKILL_DETAIL_BEGIN */
function mkNode(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 「去使用」三种走向的唯一判定入口（纯函数，验收脚本直接测它）：
//   不需要连接账户 → go-chat
//   需要且已连接   → go-chat
//   需要但没连过   → need-connector（先引导走真实授权）
function skillUseDecision(skill, connected) {
  if (!skill || skill.requiresConnector !== true) return "go-chat";
  return connected === true ? "go-chat" : "need-connector";
}

// 弹窗被拦截时的续接：授权完成后后端会落在 /settings，回到工作区时把这一步补上
const PENDING_USE_KEY = "ptSkillUseAfterGaConnect";
function savePendingUse(q) {
  try { sessionStorage.setItem(PENDING_USE_KEY, JSON.stringify({ q: q || "" })); } catch (e) { /* 隐私模式下忽略 */ }
}
async function resumePendingUse() {
  let q = "";
  try {
    const raw = sessionStorage.getItem(PENDING_USE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_USE_KEY);
    q = (JSON.parse(raw) || {}).q || "";
  } catch (e) { return; }
  const ga = (typeof window !== "undefined" ? window.GaConnect : null);
  if (!ga) return;
  let st = null;
  try { st = await ga.loadStatus(); } catch (x) { st = null; }   // 没连上就不打扰用户
  if (st && st.connected) gotoChatWithQuestion(q);
}

// 跳到一个**新开的**对话并把示例问题预填进输入框（不自动发送，用户确认后再发）
// 以前只要 state.activeId 非空就复用当前对话，结果技能「去使用」几乎永远不会真的开新对话，
// 问题被默默塞进一个可能完全无关的旧对话里。现在总是新开：
// newConversation 内部会先复用一条「一条消息都没发过」的空对话，不会堆出一串空记录。
async function gotoChatWithQuestion(q) {
  const id = await newConversation();
  if (!id) { bubbleSys("无法新建对话，请稍后重试"); return; }
  switchView("chat");
  if (q) ta.value = q;
  ta.focus();
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 170) + "px";
}

/* 连接区块：
 *   已连接 → property ID + 连接时间，配「解除连接」「更换 Property」两个独立按钮
 *            （一个只解绑、一个只换绑，不身兼两职；已连接时不再出现「连接」按钮）
 *   未连接 → property ID 输入 +「连接 Google 账户」按钮，走 GaConnect 的真实授权
 * 所有动作都调 GaConnect（= settings.js 那套逻辑搬出来的共享模块），不在此重写。
 */
function renderConnectorBlock(box, opts) {
  const o = opts || {};
  const ga = o.ga || (typeof window !== "undefined" ? window.GaConnect : null) || null;
  const status = o.status || null;
  const connected = !!(status && status.connected);
  const fmt = o.fmt || fmtTime;
  box.textContent = "";

  const err = mkNode("div", "sd-err", "");
  err.hidden = true;
  const setErr = (m) => { err.textContent = m || ""; err.hidden = !m; };

  if (!ga) {
    box.appendChild(mkNode("p", "sd-conn-tip", "连接组件未加载，刷新页面后重试。"));
    return { error: err, input: null, go: null };
  }

  if (connected && o.mode !== "form") {
    const line = mkNode("div", "sd-conn-line");
    line.appendChild(mkNode("span", "sd-badge ok", "已连接"));
    line.appendChild(mkNode("span", "sd-conn-tip", "Google Analytics 4 · 只读查询"));

    const kv = mkNode("div", "sd-conn-kv");
    kv.appendChild(mkNode("span", "sd-conn-k", "Property ID"));
    kv.appendChild(mkNode("span", "sd-conn-v", String(status.propertyId || "—")));
    if (status.updatedAt) {
      kv.appendChild(mkNode("span", "sd-conn-k", "连接时间"));
      kv.appendChild(mkNode("span", "sd-conn-v", fmt(status.updatedAt) || "—"));
    }

    const btns = mkNode("div", "sd-conn-btns");
    const dis = mkNode("button", "sd-btn danger", "解除连接"); dis.type = "button";
    const chg = mkNode("button", "sd-btn", "更换 Property"); chg.type = "button";
    dis.addEventListener("click", async () => {
      const sure = typeof o.confirm === "function"
        ? o.confirm("确定要解除 Google Analytics 连接吗？解除后需要重新授权才能使用「GA 数据查询」。")
        : true;
      if (!sure) return;
      dis.disabled = true; dis.textContent = "解除中…"; setErr("");
      let ok = false;
      try { ok = await ga.disconnect(); } catch (x) { ok = false; }
      dis.disabled = false; dis.textContent = "解除连接";
      if (!ok) { setErr("解除失败，请稍后重试。"); return; }
      if (typeof o.onChanged === "function") o.onChanged({ connected: false });
    });
    chg.addEventListener("click", () => {
      renderConnectorBlock(box, Object.assign({}, o, { mode: "form" }));
    });
    btns.appendChild(dis); btns.appendChild(chg);

    box.appendChild(line); box.appendChild(kv); box.appendChild(btns); box.appendChild(err);
    return { error: err, input: null, go: null };
  }

  // 未连接 / 换绑：填 property ID → 真实授权
  const tip = o.mode === "form"
    ? "填写新的 property ID，重新授权后会替换当前绑定。"
    : "这个技能要先连接你的 Google Analytics 账户：填 property ID → 点连接 → 在 Google 页面完成授权，授权后会自动继续。";
  const row = mkNode("div", "sd-conn-row");
  const input = mkNode("input", "sd-prop");
  input.type = "text";
  input.placeholder = "GA4 property ID，例如 123456789";
  // 刻意不预填：未连接时后端 propertyId 本就是 null，换绑时也不该替用户填旧值
  // （否则会出现「看着像填过了、一点就发起授权」的误操作）
  const btn = mkNode("button", "sd-btn primary", "连接 Google 账户"); btn.type = "button";
  row.appendChild(input); row.appendChild(btn);

  const go = () => {
    const pid = String(input.value == null ? "" : input.value).trim();
    if (!ga.validatePropertyId(pid)) {
      setErr(ga.PROPERTY_ID_HINT || "请输入纯数字的 GA4 property ID。");
      if (typeof input.focus === "function") input.focus();
      return;
    }
    setErr("");
    btn.disabled = true; btn.textContent = "等待授权…";
    ga.connect({
      propertyId: pid,
      onDone: (st) => { btn.disabled = false; btn.textContent = "连接 Google 账户"; if (typeof o.onChanged === "function") o.onChanged(st); },
      onFail: (m) => { btn.disabled = false; btn.textContent = "连接 Google 账户"; setErr(m); },
      onInvalid: (m) => { btn.disabled = false; btn.textContent = "连接 Google 账户"; setErr(m); },
      // 弹窗被浏览器拦截时只能整页跳走（授权完成后后端固定回 /settings），
      // 记一笔待办，等回到工作区时自动补上「去使用」那一步。
      onRedirect: () => { savePendingUse(o.pendingQuestion || ""); location.assign(ga.authorizeUrl ? ga.authorizeUrl(pid) : "/"); },
    });
  };
  btn.addEventListener("click", go);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });

  box.appendChild(mkNode("p", "sd-conn-tip", tip));
  box.appendChild(row);
  if (ga.PROPERTY_ID_TIP) box.appendChild(mkNode("p", "sd-conn-sub", ga.PROPERTY_ID_TIP));
  if (o.mode === "form") {
    const cancel = mkNode("button", "sd-btn", "取消"); cancel.type = "button";
    cancel.addEventListener("click", () => { if (typeof o.onChanged === "function") o.onChanged(status); });
    box.appendChild(cancel);
  }
  box.appendChild(err);
  return { error: err, input: input, go: go };
}

// 技能详情：标题 + 说明 + 去使用；需要连接账户的额外挂「连接状态/引导」区块
async function renderSkillDetail(skill, box, hooks) {
  const h = hooks || {};
  const target = box || $("#skillDetail");
  if (!target || !skill) return null;
  const ga = h.ga || (typeof window !== "undefined" ? window.GaConnect : null) || null;
  const onUse = h.onUse || gotoChatWithQuestion;
  const needs = skill.requiresConnector === true;

  target.textContent = "";
  target.hidden = false;

  const card = mkNode("div", "sd-card");
  const head = mkNode("div", "sd-head");
  head.appendChild(mkNode("h3", "", skill.title || "（无标题）"));
  const back = mkNode("button", "sd-back", "← 返回技能列表"); back.type = "button";
  back.addEventListener("click", () => { target.hidden = true; target.textContent = ""; });
  head.appendChild(back);

  const desc = mkNode("p", "sd-desc", skill.description || skill.desc || "这个技能暂时没有说明。");

  const connBox = mkNode("div", "sd-connector");
  const actions = mkNode("div", "sd-actions");
  const useBtn = mkNode("button", "sd-use", "去使用"); useBtn.type = "button";
  actions.appendChild(useBtn);

  card.appendChild(head);
  card.appendChild(desc);
  if (needs) card.appendChild(connBox);
  card.appendChild(actions);
  target.appendChild(card);

  let status = null;
  let connRef = null;
  let useAfterConnect = false;   // 「去使用」触发的引导：连上后自动继续到对话

  const paintConnector = (st, mode) => {
    if (!needs) return;
    status = st || null;
    connRef = renderConnectorBlock(connBox, {
      ga: ga, status: status, mode: mode, fmt: h.fmt, confirm: h.confirm,
      pendingQuestion: pickQuickQuestion(skill),
      onChanged: (s) => {
        const next = s && s.connected ? s : { connected: false };
        paintConnector(next);
        if (next.connected && useAfterConnect) { useAfterConnect = false; onUse(pickQuickQuestion(skill)); }
      },
    });
  };

  if (needs && ga) {
    let st = null;
    try { st = await ga.loadStatus(); } catch (x) { st = null; }
    paintConnector(st);
  }

  useBtn.addEventListener("click", () => {
    const q = pickQuickQuestion(skill);
    if (!needs) { onUse(q); return; }                       // ① 不需要连接账户：直接去对话
    // ② 已连接：直接去对话。这里刻意不再 await —— 授权弹窗必须在点击的同步栈里打开，
    //    否则浏览器会当成非用户操作拦掉，退化成整页跳走、丢掉「去使用」的连续性。
    if (skillUseDecision(skill, status && status.connected) === "go-chat") { onUse(q); return; }
    // ③ 需要连接但没连过：先引导。引导框里已填好 property ID 就直接发起授权，
    //    没填就提示并聚焦，绝不静默失败、也不跳过授权。
    useAfterConnect = true;
    if (!ga) return;
    const input = connRef && connRef.input;
    const pid = input ? String(input.value == null ? "" : input.value).trim() : "";
    if (pid && ga.validatePropertyId(pid)) {
      if (connRef && typeof connRef.go === "function") connRef.go();
      return;
    }
    if (connRef && connRef.error) {
      connRef.error.textContent = ga.PROPERTY_ID_HINT || "请先填写 GA4 property ID，再点连接。";
      connRef.error.hidden = false;
    }
    if (input && typeof input.focus === "function") input.focus();
  });

  return { card: card, useBtn: useBtn, connector: connBox };
}

async function loadSkills() {
  const g = $("#skillGrid");
  const detail = $("#skillDetail");
  if (detail) { detail.hidden = true; detail.textContent = ""; }
  g.textContent = "";
  const loading = mkNode("div", "card");
  loading.appendChild(mkNode("p", "", "读取中…"));
  g.appendChild(loading);
  try {
    const j = await (await fetch("/api/skills")).json();
    const list = Array.isArray(j && j.skills) ? j.skills : [];
    $("#pSkills").textContent = "技能 " + list.length;
    $("#pSkills").className = "pill ok";
    g.textContent = "";
    if (!list.length) {
      const c = mkNode("div", "card");
      c.appendChild(mkNode("p", "", "没有技能"));
      g.appendChild(c);
      return;
    }
    // P1-3：用 textContent 构建 DOM，杜绝 innerHTML 注入（技能标题/描述/ID 都可能含用户内容）
    for (const s of list) {
      const card = mkNode("div", "card clickable");
      card.tabIndex = 0;                                   // 键盘也能打开详情
      card.appendChild(mkNode("h4", "", s.title || "（无标题）"));
      card.appendChild(mkNode("p", "", s.desc || s.description || "（无描述）"));
      card.appendChild(mkNode("span", "tag", s.id || ""));
      const open = () => renderSkillDetail(s, detail);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
      });
      g.appendChild(card);
    }
  } catch (x) {
    g.textContent = "";
    const c = mkNode("div", "card");
    c.appendChild(mkNode("p", "", "读不到技能列表"));
    g.appendChild(c);
  }
}
/* SKILL_DETAIL_END */

/* ---- 状态 ---- */
async function loadStatus() {
  const kv = $("#statusKv");
  try {
    const j = await (await fetch("/api/status")).json();
    $("#pDash").textContent = "看板 " + (j.dashboardOk ? "在线" : "离线");
    $("#pDash").className = "pill " + (j.dashboardOk ? "ok" : "bad");
    // P1-3：用 textContent 构建 DOM，杜绝 innerHTML 注入（路径等都可能含特殊字符）
    const rows = [
      ["产品 DSH_HOME（隔离边界）", j.dshHome],
      ["产品工作区", j.workspace],
      ["产品技能数", (j.skills == null ? 0 : j.skills) + " 个"],
      ["看板后端 127.0.0.1:" + j.dashboard, j.dashboardOk ? "✅ 在线" : "❌ 离线（先启动后端服务）"],
      ["DSH 对外端口", "无（headless 不开端口）"],
      ["用户与 DSH 的关系", "用户只跟业务壳说话，永远碰不到 DSH"],
    ];
    kv.textContent = "";
    for (const r of rows) {
      const row = document.createElement("div"); row.className = "row";
      const k = document.createElement("div"); k.className = "k"; k.textContent = r[0];
      const v = document.createElement("div"); v.className = "v"; v.textContent = r[1];
      row.appendChild(k); row.appendChild(v); kv.appendChild(row);
    }
  } catch (x) {
    kv.textContent = "";
    const row = document.createElement("div"); row.className = "row";
    const v = document.createElement("div"); v.className = "v"; v.textContent = "读不到状态";
    row.appendChild(v); kv.appendChild(row);
  }
}

$("#out").addEventListener("click", async e => {
  e.preventDefault();
  await fetch("/api/logout", { method: "POST" }); location.href = "/login";
});

/* ---- P0-2：我的 Key 状态（红点 / 末4位 / 提示条）---- */
async function loadKeyState() {
  try {
    const r = await fetch("/api/auth/key", { credentials: "same-origin" });
    if (r.status === 401) return;
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) return;
    const bound = !!(j.key && j.key.key_last4);
    const banner = $("#keyBanner"); if (banner) banner.hidden = bound;
  } catch (x) { /* 静默 */ }
}

/* P0-2：拉当前登录用户，填充侧边栏用户名 / 用户菜单 / 头像首字母（只接 session，不新增功能） */
async function loadMe() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !j.user) return;
    const u = j.user;
    const name = u.username || u.email || "账户";
    const handle = "@" + (u.username || (u.email || "").split("@")[0] || "user");
    const ueName = $(".ue-name"); if (ueName) ueName.textContent = name;
    const umName = $("#umName"); if (umName) umName.textContent = name;
    const umHandle = $("#umHandle"); if (umHandle) umHandle.textContent = handle;
    const initial = (name[0] || "U").toUpperCase();
    document.querySelectorAll(".ue-avatar").forEach(a => { a.textContent = initial; });
  } catch (e) { /* 静默 */ }
}

/* ---- 面板分享（只读 + 整面板）---- */
function showModal(id) { const el = $("#" + id); if (el) el.hidden = false; }
function hideModal(id) { const el = $("#" + id); if (el) el.hidden = true; }
document.querySelectorAll(".modal-x").forEach((b) => b.addEventListener("click", () => hideModal(b.dataset.close)));
document.querySelectorAll(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) hideModal(m.id); }));

async function openShareModal() {
  const body = $("#shareModalBody");
  body.innerHTML =
    '<div class="share-form">' +
      '<label>有效期' +
        '<select id="shareExpiry">' +
          '<option value="">永久</option>' +
          '<option value="24">24 小时</option>' +
          '<option value="168">7 天</option>' +
          '<option value="720">30 天</option>' +
        '</select>' +
      '</label>' +
      '<button class="btn" id="shareCreateBtn" type="button">生成分享链接</button>' +
    '</div>' +
    '<div id="shareResult"></div>';
  showModal("shareModal");
  $("#shareCreateBtn").addEventListener("click", createShare);
}

async function createShare() {
  const exp = ($("#shareExpiry") && $("#shareExpiry").value) || "";
  const payload = exp ? { expiresInHours: Number(exp) } : {};
  const result = $("#shareResult");
  result.innerHTML = '<div class="share-loading">生成中…</div>';
  try {
    const r = await fetch("/api/panel/shares", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) { result.innerHTML = '<div class="share-err">' + ((j && j.error) || ("HTTP " + r.status)) + '</div>'; return; }
    const full = location.origin + j.url;
    result.innerHTML =
      '<div class="share-link-row">' +
        '<input id="shareLink" readonly value="' + full + '">' +
        '<button class="btn" id="shareCopyBtn" type="button">复制</button>' +
      '</div>' +
      '<div class="share-meta">有效期：' + (j.expires_at ? fmtTime(j.expires_at) : "永久") + ' · 只读 · 打开即可查看（无需登录）</div>';
    $("#shareCopyBtn").addEventListener("click", () => copyText(full, $("#shareCopyBtn")));
  } catch (e) {
    result.innerHTML = '<div class="share-err">创建失败：' + e.message + '</div>';
  }
}

async function openMyShares() {
  showModal("mySharesModal");
  const body = $("#mySharesBody");
  body.innerHTML = '<div class="share-loading">读取中…</div>';
  try {
    const r = await fetch("/api/panel/shares", { credentials: "same-origin" });
    const j = await r.json().catch(() => null);
    const shares = (j && Array.isArray(j.shares)) ? j.shares : [];
    body.innerHTML = "";
    if (!shares.length) { body.innerHTML = '<div class="share-empty">还没有分享。点「分享面板」创建一个。</div>'; return; }
    for (const s2 of shares) {
      const row = document.createElement("div");
      row.className = "shares-row" + (s2.active ? "" : " off");
      const info = document.createElement("div"); info.className = "shares-info";
      const link = document.createElement("div"); link.className = "shares-link"; link.textContent = location.origin + s2.url;
      const meta = document.createElement("div"); meta.className = "shares-meta";
      const status = s2.revoked ? "已撤销" : (s2.expired ? "已过期" : "✅ 有效");
      meta.textContent = "创建于 " + fmtTime(s2.created_at)
        + (s2.expires_at ? " · 到期 " + fmtTime(s2.expires_at) : " · 永久")
        + (s2.last_accessed_at ? " · 最近访问 " + fmtTime(s2.last_accessed_at) : " · 从未访问")
        + " · " + status;
      info.appendChild(link); info.appendChild(meta);
      row.appendChild(info);
      if (s2.active) {
        const rev = document.createElement("button"); rev.className = "shares-revoke"; rev.textContent = "撤销";
        rev.addEventListener("click", async () => {
          await fetch("/api/panel/shares/" + encodeURIComponent(s2.id), { method: "DELETE", credentials: "same-origin" });
          openMyShares();
        });
        row.appendChild(rev);
      }
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = '<div class="share-err">读取失败：' + e.message + '</div>';
  }
}

const sharePanelBtn = $("#sharePanelBtn"), mySharesBtn = $("#mySharesBtn");
if (sharePanelBtn) sharePanelBtn.addEventListener("click", openShareModal);
if (mySharesBtn) mySharesBtn.addEventListener("click", openMyShares);

/* ============================================================================
 * U1 · 广告数据导入（选平台 → 上传 → 看状态 → 二次确认入库）
 *
 * 鉴权：抄「归因看板」的模式 —— 前端**不持有** token，请求打同源相对路径，
 *       由 shell 服务端反代注入 Authorization: Bearer <分析token>。
 *       （见 server.cjs 的 /api/analytics 反代；/api/business 反代待补，见 U1-API-GAPS.md）
 *
 * 两阶段（A18 设计）：POST /jobs 只做**结构校验** → ready；
 *                     POST /jobs/:id/confirm 才**真正入库**，会再刷掉一批行。
 *                     两步行数不同是设计如此，文案必须讲清楚。
 * ========================================================================== */

const IMP_API = "/api/business/attribution/import";
const IMP_MAX_BYTES = 20 * 1024 * 1024;   // 与 service.js 的 20MB 上限一致

/** 状态枚举 → 中文友好文案（绝不把英文枚举直接甩给用户） */
const IMP_STATUS = {
  pending:        { zh: "排队中",             tone: "wait" },
  validating:     { zh: "结构校验中",         tone: "wait" },
  ready:          { zh: "结构校验通过 · 待确认", tone: "ready" },
  importing:      { zh: "正在入库",           tone: "wait" },
  completed:      { zh: "导入完成",           tone: "ok" },
  partial_failed: { zh: "部分行失败",         tone: "warn" },
  failed:         { zh: "导入失败",           tone: "bad" },
  cancelled:      { zh: "已取消",             tone: "muted" },
};
const IMP_TONE_ICO = { ok: "checkCircle", warn: "warn", bad: "xCircle", ready: "circleAmber", wait: "clock", muted: "dot" };

/** 后端错误码 → 人话 */
const IMP_ERR_ZH = {
  UNAUTHORIZED: "登录状态没传过去（服务端未注入分析 token）",
  FORBIDDEN: "分析 token 无效或已过期",
  NO_WORKSPACE: "当前租户还没有绑定工作区",
  NOT_FOUND: "找不到这个导入任务",
  BAD_PROVIDER: "平台参数非法（需为 google / meta / x）",
  EMPTY_FILE: "文件是空的",
  TOO_LARGE: "文件超过 20MB 上限",
  CLIENT_TENANT_REJECTED: "请求里不该带 tenantId（租户只认登录身份）",
  CONTEXT_REQUIRED: "缺少租户上下文",
  BAD_STATUS: "当前状态不允许确认导入",
  POOL_REQUIRED: "后端数据库连接不可用",
};

const impState = { provider: "google", file: null, jobId: null, job: null, busy: false, loaded: false };

function impEl(id) { return document.getElementById(id); }

function impFmtBytes(n) {
  if (n == null || isNaN(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function impStatusChip(status) {
  const s = IMP_STATUS[status] || { zh: status || "未知", tone: "muted" };
  const ico = IMP_TONE_ICO[s.tone] || "dot";
  return '<span class="imp-chip imp-chip-' + s.tone + '"><span class="ico" data-ico="' + ico + '"></span>' + s.zh + "</span>";
}

/** 统一请求：同源相对路径 + same-origin 凭据，token 由服务端注入 */
async function impFetch(path, opts) {
  const o = Object.assign({ credentials: "same-origin" }, opts || {});
  if (o.body && !o.headers) o.headers = { "Content-Type": "application/json" };
  let res;
  try {
    res = await fetch(IMP_API + path, o);
  } catch (e) {
    throw Object.assign(new Error("网络请求失败：" + e.message), { impKind: "network" });
  }
  // 413：Fastify bodyLimit 挡在业务逻辑之前，响应体是 Fastify 默认格式
  if (res.status === 413) {
    throw Object.assign(new Error("请求体超过服务端上限（当前 1MB）。文件本身没超 20MB，是服务端 bodyLimit 配置偏小 —— 已记为缺口。"), { impKind: "413" });
  }
  if (res.status === 404) {
    throw Object.assign(new Error("接口不存在（404）。shell 还没有把 /api/business/ 反代到归因服务 —— 已记为缺口。"), { impKind: "404" });
  }
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const code = j && j.error && j.error.code;
    const msg = (j && j.error && j.error.message) || (j && j.message) || ("HTTP " + res.status);
    const zh = code && IMP_ERR_ZH[code] ? IMP_ERR_ZH[code] : null;
    throw Object.assign(new Error(zh ? zh + "（" + code + "）" : msg), { impKind: "http", status: res.status, code: code });
  }
  return j;
}

function impFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

function impBusy(on, text) {
  impState.busy = on;
  const b = impEl("impBusy"), up = impEl("impUpload");
  if (b) { b.hidden = !on; if (text) b.innerHTML = '<span class="ico spin" data-ico="spinner"></span> ' + text; }
  if (up) up.disabled = on || !impState.file;
  if (window.initIcons) window.initIcons();
}

/* ---- 错误详情：逐行展示，精确到行号 + 字段 + 原因 ---- */
function impRenderErrors(details, extra) {
  if (!details || !details.length) return "";
  const rows = details.slice(0, 200).map(d => {
    const rn = d.sourceRowNumber != null ? d.sourceRowNumber : "—";
    const fd = d.field ? d.field : null;
    const reason = d.reason || d.message || "未知原因";
    return '<tr><td class="imp-err-row">第 ' + rn + ' 行</td>'
      + '<td class="imp-err-field">' + (fd ? fd : "—") + "</td>"
      + '<td class="imp-err-reason"></td></tr>';
  }).join("");
  const more = details.length > 200 ? '<p class="imp-more">另有 ' + (details.length - 200) + " 条未显示</p>" : "";
  return '<div class="imp-errbox">'
    + '<div class="imp-errbox-h"><span class="ico" data-ico="warn"></span> 有 ' + details.length + " 行没通过" + (extra ? " · " + extra : "") + "</div>"
    + '<table class="imp-errtab"><thead><tr><th>源文件行号</th><th>字段</th><th>问题</th></tr></thead><tbody>' + rows + "</tbody></table>"
    + more + "</div>";
}

/** 把 reason 文本安全填进单元格（避免 innerHTML 注入） */
function impFillReasons(container, details) {
  if (!container) return;
  const cells = container.querySelectorAll(".imp-err-reason");
  const list = (details || []).slice(0, 200);
  cells.forEach((c, i) => { c.textContent = (list[i] && (list[i].reason || list[i].message)) || "未知原因"; });
}

/* ---- 渲染单个 job 的完整结果 ---- */
function impRenderJob(job, phase) {
  impState.job = job;
  impState.jobId = job.importId;
  const card = impEl("impResultCard"), box = impEl("impResult"), idEl = impEl("impJobId");
  if (!card || !box) return;
  card.hidden = false;
  if (idEl) idEl.textContent = "任务 " + String(job.importId || "").slice(0, 8);

  const st = job.status;
  const isReady = st === "ready";
  const isTerminal = ["completed", "partial_failed", "failed", "cancelled"].indexOf(st) >= 0;

  // 数字区：结构校验阶段 vs 最终入库阶段，分开显示，避免用户误以为掉行是 bug
  let nums = "";
  const hasStruct = job.rowCount != null;
  const hasFinal = job.successRows != null || job.persistedRows != null;
  if (hasStruct || hasFinal) {
    nums = '<div class="imp-nums">';
    if (hasStruct) {
      nums += '<div class="imp-num"><span class="imp-num-k">读到行数</span><span class="imp-num-v">' + job.rowCount + "</span></div>";
    }
    if (isReady) {
      nums += '<div class="imp-num"><span class="imp-num-k">结构校验</span><span class="imp-num-v imp-v-ready">通过</span></div>';
    }
    if (hasFinal) {
      nums += '<div class="imp-num"><span class="imp-num-k">最终入库</span><span class="imp-num-v imp-v-ok">' + (job.successRows != null ? job.successRows : (job.persistedRows || 0)) + "</span></div>";
      if (job.failedRows) {
        nums += '<div class="imp-num"><span class="imp-num-k">被刷掉</span><span class="imp-num-v imp-v-bad">' + job.failedRows + "</span></div>";
      }
    }
    nums += "</div>";
  }

  // ready 阶段：明确告诉用户「这只是结构校验，还没入库」
  let readyHint = "";
  if (isReady) {
    readyHint = '<div class="imp-ready-hint"><span class="ico" data-ico="bulb"></span>'
      + "<div><b>结构校验通过，但数据还没入库。</b>"
      + "下面这一步才会真正写入，并再做一次语义校验（比如事件名不在映射表里）——"
      + "<b>最终成功行数可能比现在少，这是正常的</b>，不是丢数据。</div></div>";
  }

  // 终态：如果 ready 阶段的行数和最终不一致，主动解释
  let diffNote = "";
  if (isTerminal && phase === "confirm" && job.rowCount != null && job.successRows != null && job.successRows < job.rowCount) {
    diffNote = '<div class="imp-diffnote"><span class="ico" data-ico="checkCircle"></span>'
      + "<div>读到 " + job.rowCount + " 行，最终入库 " + job.successRows + " 行，"
      + (job.failedRows ? "有 " + job.failedRows + " 行在语义校验或落库阶段被刷掉" : "差额来自语义校验")
      + "。两步口径不同是 A18 两阶段校验的设计，不是 bug。</div></div>";
  }

  // 元信息
  const meta = [];
  if (job.provider) meta.push("平台 " + job.provider);
  if (job.originalName) meta.push(job.originalName);
  if (job.dateRange && job.dateRange.from) meta.push("数据区间 " + job.dateRange.from + " ~ " + job.dateRange.to);
  if (job.currencySeen && job.currencySeen.length) meta.push("币种 " + job.currencySeen.join("/"));
  if (job.updatedAt) meta.push("更新于 " + fmtTime(job.updatedAt));

  // 样例行预览
  let sample = "";
  if (job.sampleRows && job.sampleRows.length) {
    const cols = ["date", "campaignId", "adGroupId", "country", "spend", "creativeName"];
    const zh = { date: "日期", campaignId: "系列 ID", adGroupId: "组 ID", country: "国家", spend: "花费", creativeName: "素材名" };
    sample = '<div class="imp-sample"><div class="imp-sample-h">前 ' + job.sampleRows.length + ' 行预览</div><table class="imp-errtab"><thead><tr>'
      + cols.map(c => "<th>" + zh[c] + "</th>").join("") + "</tr></thead><tbody>"
      + job.sampleRows.map(r => "<tr>" + cols.map(c => "<td>" + (r[c] != null && r[c] !== "" ? String(r[c]) : "—") + "</td>").join("") + "</tr>").join("")
      + "</tbody></table></div>";
  }

  // 映射不完整的情况（MAPPING_INCOMPLETE 也会落到 ready，但 rowCount=0）
  let mapHint = "";
  if (isReady && job.rowCount === 0 && job.errorMessage) {
    mapHint = '<div class="imp-mapwarn"><span class="ico" data-ico="warn"></span><div><b>必填列没映射上</b>：'
      + job.errorMessage + "。需要补 mapping 后再确认导入。</div></div>";
  }

  const errHtml = impRenderErrors(job.errorDetails, isReady ? "结构校验阶段" : "最终入库阶段");

  // 操作按钮
  let actions = "";
  if (isReady) {
    actions = '<div class="imp-actions"><button type="button" class="gbtn primary" id="impConfirm">'
      + '<span class="ico" data-ico="check"></span> 确认导入（真正写入）</button>'
      + '<span class="imp-busy" id="impConfirmBusy" hidden><span class="ico spin" data-ico="spinner"></span> 正在入库…</span></div>';
  } else if (isTerminal) {
    actions = '<div class="imp-actions"><button type="button" class="gbtn" id="impAgain">'
      + '<span class="ico" data-ico="refresh"></span> 再传一个文件</button></div>';
  }

  box.innerHTML = '<div class="imp-jobhead">' + impStatusChip(st)
    + (job.errorMessage ? '<span class="imp-jobmsg"></span>' : "")
    + "</div>"
    + (meta.length ? '<div class="imp-meta">' + meta.join(" · ") + "</div>" : "")
    + nums + readyHint + mapHint + diffNote + sample + errHtml + actions;

  // 文本类内容用 textContent 填，避免注入
  const msgEl = box.querySelector(".imp-jobmsg");
  if (msgEl && job.errorMessage) msgEl.textContent = job.errorMessage;
  impFillReasons(box, job.errorDetails);

  const cf = impEl("impConfirm");
  if (cf) cf.addEventListener("click", impDoConfirm);
  const ag = impEl("impAgain");
  if (ag) ag.addEventListener("click", impReset);

  if (window.initIcons) window.initIcons();
  impMarkSteps(isReady ? 2 : (isTerminal ? 2 : 1));
}

/** 高亮两步进度条 */
function impMarkSteps(active) {
  const s1 = impEl("impStep1"), s2 = impEl("impStep2");
  if (s1) s1.classList.toggle("on", active >= 1);
  if (s2) s2.classList.toggle("on", active >= 2);
}

function impShowError(e) {
  const card = impEl("impResultCard"), box = impEl("impResult");
  if (!card || !box) return;
  card.hidden = false;
  const kind = e && e.impKind;
  const hint = kind === "404" || kind === "413" || kind === "network"
    ? '<div class="imp-gapnote"><span class="ico" data-ico="wrench"></span><div><b>这是环境缺口，不是你操作错了。</b><span class="imp-gapdetail"></span></div></div>'
    : "";
  box.innerHTML = '<div class="imp-jobhead">' + impStatusChip("failed") + '<span class="imp-jobmsg"></span></div>' + hint;
  const m = box.querySelector(".imp-jobmsg");
  if (m) m.textContent = e && e.message ? e.message : String(e);
  const d = box.querySelector(".imp-gapdetail");
  if (d) d.textContent = " 详见 shell/public/U1-API-GAPS.md，需要后端补上后才能联调。";
  if (window.initIcons) window.initIcons();
}

function impReset() {
  impState.file = null; impState.jobId = null; impState.job = null;
  const fi = impEl("impFile"); if (fi) fi.value = "";
  const on = impEl("impFileOn"), inn = impEl("impDropIn");
  if (on) on.hidden = true;
  if (inn) inn.hidden = false;
  const card = impEl("impResultCard"); if (card) card.hidden = true;
  const up = impEl("impUpload"); if (up) up.disabled = true;
  impMarkSteps(0);
}

function impSetFile(f) {
  if (!f) return;
  if (f.size > IMP_MAX_BYTES) {
    impShowError(Object.assign(new Error("文件 " + impFmtBytes(f.size) + " 超过 20MB 上限，请拆分后再传。"), { impKind: "local" }));
    return;
  }
  impState.file = f;
  const on = impEl("impFileOn"), inn = impEl("impDropIn");
  if (inn) inn.hidden = true;
  if (on) on.hidden = false;
  const n = impEl("impFileName"), s = impEl("impFileSize");
  if (n) n.textContent = f.name;
  if (s) s.textContent = impFmtBytes(f.size);
  const up = impEl("impUpload");
  if (up) up.disabled = impState.busy;
  const card = impEl("impResultCard"); if (card) card.hidden = true;
}

async function impDoUpload() {
  if (!impState.file || impState.busy) return;
  impBusy(true, "正在上传并结构校验…");
  try {
    const contentBase64 = await impFileToBase64(impState.file);
    const j = await impFetch("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: impState.provider,
        originalName: impState.file.name,
        contentBase64: contentBase64,
      }),
    });
    if (j && j.job) impRenderJob(j.job, "validate");
    else impShowError(new Error("后端没返回 job 对象"));
  } catch (e) {
    impShowError(e);
  } finally {
    impBusy(false);
  }
}

async function impDoConfirm() {
  if (!impState.jobId || impState.busy) return;
  const btn = impEl("impConfirm"), busy = impEl("impConfirmBusy");
  if (btn) btn.disabled = true;
  if (busy) busy.hidden = false;
  impState.busy = true;
  try {
    const j = await impFetch("/jobs/" + encodeURIComponent(impState.jobId) + "/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (j && j.job) impRenderJob(j.job, "confirm");
    else impShowError(new Error("后端没返回 job 对象"));
    impLoadHistory();
  } catch (e) {
    impShowError(e);
  } finally {
    impState.busy = false;
  }
}

/* ---- 历史任务列表 ---- */
function impRenderHistory(jobs) {
  const box = impEl("impHistory");
  if (!box) return;
  if (!jobs || !jobs.length) {
    box.innerHTML = '<div class="imp-empty">还没有导入任务。上面选平台 + 传文件开始第一次导入。</div>';
    return;
  }
  box.innerHTML = '<table class="imp-histab"><thead><tr>'
    + "<th>状态</th><th>平台</th><th>文件</th><th>行数</th><th>入库</th><th>时间</th><th></th>"
    + "</tr></thead><tbody>"
    + jobs.map((j, i) => '<tr data-i="' + i + '">'
      + "<td>" + impStatusChip(j.status) + "</td>"
      + "<td>" + (j.provider || "—") + "</td>"
      + '<td class="imp-hist-name"></td>'
      + "<td>" + (j.rowCount != null ? j.rowCount : "—") + "</td>"
      + "<td>" + (j.successRows != null ? j.successRows : "—") + "</td>"
      + "<td>" + fmtShort(j.createdAt) + "</td>"
      + '<td><button type="button" class="imp-hist-view" data-id="' + j.importId + '">查看</button></td>'
      + "</tr>").join("")
    + "</tbody></table>";
  // 文件名用 textContent 填
  box.querySelectorAll(".imp-hist-name").forEach((c, i) => { c.textContent = jobs[i].originalName || "—"; });
  box.querySelectorAll(".imp-hist-view").forEach(b => {
    b.addEventListener("click", () => impOpenJob(b.dataset.id));
  });
  if (window.initIcons) window.initIcons();
}

async function impLoadHistory() {
  const box = impEl("impHistory");
  if (box) box.innerHTML = '<div class="imp-empty">加载中…</div>';
  try {
    const j = await impFetch("/jobs");
    impRenderHistory(j && j.jobs ? j.jobs : []);
  } catch (e) {
    if (box) {
      box.innerHTML = '<div class="imp-empty imp-empty-err"></div>';
      box.querySelector(".imp-empty-err").textContent = "读取失败：" + (e.message || e);
    }
  }
}

async function impOpenJob(id) {
  if (!id) return;
  try {
    const j = await impFetch("/jobs/" + encodeURIComponent(id));
    if (j && j.job) { impRenderJob(j.job, "view"); impMarkSteps(2); }
  } catch (e) {
    impShowError(e);
  }
}

/** 进入视图时初始化（只绑一次事件，历史每次刷新） */
function impOnEnter() {
  if (!impState.loaded) {
    impState.loaded = true;
    // 平台选择
    const provs = impEl("impProvs");
    if (provs) {
      provs.querySelectorAll(".imp-prov").forEach(b => {
        b.addEventListener("click", () => {
          provs.querySelectorAll(".imp-prov").forEach(x => x.classList.toggle("on", x === b));
          impState.provider = b.dataset.prov;
        });
      });
    }
    // 文件选择 + 拖拽
    const drop = impEl("impDrop"), fi = impEl("impFile");
    if (drop && fi) {
      drop.addEventListener("click", e => { if (e.target.closest("#impFileClear")) return; fi.click(); });
      fi.addEventListener("change", () => impSetFile(fi.files && fi.files[0]));
      // 拖拽逻辑不在这里重复写一遍，和聊天输入区共用 attachDropZone
      attachDropZone(drop, impSetFile);
    }
    const clr = impEl("impFileClear");
    if (clr) clr.addEventListener("click", e => { e.stopPropagation(); impReset(); });
    const up = impEl("impUpload");
    if (up) up.addEventListener("click", impDoUpload);
    const rf = impEl("impRefresh");
    if (rf) rf.addEventListener("click", impLoadHistory);
  }
  impLoadHistory();
}

/* ---- 启动：拉状态 + 拉对话列表（自动选中最近一个；没有则空状态引导）---- */
(async () => {
  try { const j = await (await fetch("/api/skills")).json(); $("#pSkills").textContent = "技能 " + j.skills.length; $("#pSkills").className = "pill ok"; } catch (e) {}
  try { const j = await (await fetch("/api/status")).json(); $("#pDash").textContent = "看板 " + (j.dashboardOk ? "在线" : "离线"); $("#pDash").className = "pill " + (j.dashboardOk ? "ok" : "bad"); } catch (e) {}
  loadKeyState();
  loadMe();
  loadModels();
  loadQuickQuestions();   // 首页快捷问题按技能动态渲染
  resumePendingUse();     // 若上次是从技能页跳出去做 GA 授权，回来补上「去使用」
  await refreshList();   // 预拉对话列表，侧边栏对话历史即时可见

  // 刷新前在哪，就回哪（sessionStorage 记住的 view + 对话 id）。
  // 记不住 / 记录失效（对话被删、404、视图已下线）→ 兜底回首页，不留白屏。
  const rt = readRoute();
  if (rt && await restoreRoute(rt)) return;
  switchView("home");    // 保底落地首页（U0 三卡片 + chip 行）
})();

/* ---- M-UI-B：仅业务流库、用量日志与上传记录。?m-ui-b=mock 显式演示；
 * M1 未上线时仅 404/501 使用标注的示例数据，401/403/故障不会伪装成成功。
 * 启用状态已接真实接口 GET /api/workspaces/enabled-status（见 bizLoadFlowStatus），
 * 不再是写死的示例状态；#v-flows .page[data-onboarding-path] 仍留作外部跳转覆盖。
 * 上传记录沿用 U4 的 import API、字段和状态语义，上传复用现有 impOnEnter。
 */
const bizMock = new URLSearchParams(location.search).get("m-ui-b") === "mock";
const bizToolSamples = [
  { name: "attribution.summary", type: "tool", version: "1.0", description: "汇总广告渠道转化与花费", inputSchema: { type: "object", properties: { range: { type: "string" } } }, outputType: "json", riskLevel: "low" },
  { name: "data.quality", type: "tool", version: "1.0", description: "检查事件与广告数据质量", inputSchema: { type: "object" }, outputType: "json", riskLevel: "low" }
];
function bizNode(tag, text, cls) {
  const n = document.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n;
}
async function bizRead(url, sample) {
  if (bizMock) return { data: sample(), mock: true };
  const r = await fetch(url, { credentials: "same-origin" });
  if ((r.status === 404 || r.status === 501) && sample) return { data: sample(), mock: true };
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error((j && typeof j.error === "string" && j.error) || "读取失败（HTTP " + r.status + "），请刷新重试");
  return { data: j, mock: false };
}
function bizTable(host, headers, rows) {
  host.replaceChildren(); const table = bizNode("table"); table.style.cssText = "width:100%;border-collapse:collapse;text-align:left";
  const head = bizNode("thead"), tr = bizNode("tr");
  headers.forEach(h => { const th = bizNode("th", h); th.style.padding = "12px"; tr.appendChild(th); }); head.appendChild(tr); table.appendChild(head);
  const body = bizNode("tbody"); rows.forEach(cells => { const row = bizNode("tr"); cells.forEach(c => { const td = bizNode("td"); td.style.cssText = "padding:12px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere"; if (c instanceof Node) td.appendChild(c); else td.textContent = c == null ? "—" : String(c); row.appendChild(td); }); body.appendChild(row); });
  table.appendChild(body); host.appendChild(table);
}
let bizFlowsRequest = 0;
async function bizLoadFlows() {
  const seq = ++bizFlowsRequest; $("#toolsStatus").textContent = "读取工具…";
  bizLoadFlowStatus();   // 启用状态走独立接口，与工具列表并行、互不阻塞
  try {
    const result = await bizRead("/api/tools", () => bizToolSamples);
    if (seq !== bizFlowsRequest) return;
    const tools = Array.isArray(result.data) ? result.data : result.data.tools;
    if (!Array.isArray(tools)) throw new Error("工具接口返回格式不正确");
    $("#toolsList").replaceChildren();
    $("#toolsStatus").textContent = (result.mock ? "示例数据 · 工具接口待接入。" : "") + (tools.length ? tools.length + " 项能力" : "当前没有可用工具");
    tools.forEach(t => {
      const card = bizNode("div", null, "card"); card.append(bizNode("h4", t.name), bizNode("p", t.description), bizNode("p", [t.type, t.version, "输出 " + t.outputType, "风险 " + t.riskLevel].join(" · ")));
      const details = bizNode("details"); details.append(bizNode("summary", "输入参数"), bizNode("pre", JSON.stringify(t.inputSchema, null, 2))); card.appendChild(details);
      const run = bizNode("button", "运行", "toolbar-btn"); run.type = "button";
      run.addEventListener("click", async () => {
        run.disabled = true;
        try { if (!state.activeId && !(await newConversation())) { $("#toolsStatus").textContent = "无法创建对话，请重试"; return; } switchView("chat"); ta.value = "@" + t.name + " "; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); }
        finally { run.disabled = false; }
      }); card.appendChild(run); $("#toolsList").appendChild(card);
    });
  } catch (e) { if (seq === bizFlowsRequest) { $("#toolsList").replaceChildren(); $("#toolsStatus").textContent = e.message; } }
}
/* ---- 业务流库的「启用状态」：真实查询，不再写死示例值 ----
 * 权威信号是业务线 A16 落地的 firstConnectedAt（非空 = 真的接入过广告归因数据），
 * 由基座 GET /api/workspaces/enabled-status 归一化成 features.attributionEnabled：
 *   { ok, workspaceId, features: { attributionEnabled: bool }, firstConnectedAt, updatedAt }
 * 故障（502 业务线不可用 / 503 内部密钥没配 / 401 没登录）只说「读不到」，
 * 绝不显示成「未启用」——后者会让用户误以为自己没接入过。 */
let bizFlowStatusRequest = 0;
let bizAttributionEnabled = null;   // true / false / null（还没读到或读失败）
function bizFlowStatusSample() {
  return { ok: true, workspaceId: "mock", features: { attributionEnabled: false }, firstConnectedAt: null };
}
async function bizLoadFlowStatus() {
  const seq = ++bizFlowStatusRequest;
  const statusEl = $("#flowStatus"), hintEl = $("#flowHint"), btn = $("#flowEnable");
  statusEl.textContent = "读取启用状态…";
  bizAttributionEnabled = null;
  if (btn) btn.textContent = "启用";
  try {
    // 只有 ?m-ui-b=mock 才用示例；404/501 不再回落假数据，免得把「接口没交付」说成「未启用」
    const result = bizMock
      ? { data: bizFlowStatusSample(), mock: true }
      : await bizRead("/api/workspaces/enabled-status", null);
    if (seq !== bizFlowStatusRequest) return;
    const features = result.data && result.data.features;
    if (!features || typeof features.attributionEnabled !== "boolean") throw new Error("启用状态接口返回格式不正确");
    bizAttributionEnabled = features.attributionEnabled;
    statusEl.textContent = (result.mock ? "示例状态 · " : "")
      + (bizAttributionEnabled
        ? "已启用 · 首次接入 " + (fmtTime(result.data.firstConnectedAt) || "—")
        : "未启用 · 还没有接入广告归因数据");
    if (btn) btn.textContent = bizAttributionEnabled ? "去归因面板" : "启用";
    hintEl.textContent = "";
  } catch (e) {
    if (seq !== bizFlowStatusRequest) return;
    bizAttributionEnabled = null;
    statusEl.textContent = "启用状态暂时读不到";
    hintEl.textContent = (e && e.message) ? e.message : "读取失败，请刷新重试";
    if (btn) btn.textContent = "启用";
  }
}
$("#flowEnable").addEventListener("click", () => {
  // data-onboarding-path 仍作外部覆盖：填了合法绝对路径就跳过去（将来若挂 U5 向导整页）
  const path = $("#v-flows .page").dataset.onboardingPath;
  if (path && path.startsWith("/") && !path.startsWith("//")) { location.assign(path); return; }
  if (bizAttributionEnabled === null) {
    $("#flowHint").textContent = "启用状态还没读到，先点「刷新」重试，再决定要不要启用。";
    return;
  }
  // 未启用 → 去本应用内建的「广告数据导入」页完成首次接入
  //   （同一套 import API，导入确认后写 firstConnectedAt，启用状态随后自动变「已启用」）
  // 已启用 → 直达归因面板看数据
  switchView(bizAttributionEnabled ? "dash" : "import");
});
$("#toolsRetry").addEventListener("click", bizLoadFlows);
let bizUsageRange = "today", bizUsageRequest = 0;
function bizUsageSample() {
  const now = Date.now(), days = bizUsageRange === "month" ? [0, 2, 12] : bizUsageRange === "week" ? [0, 2] : [0];
  return { ok: true, calls: days.map((d, i) => ({ id: "demo-" + i, timestamp: new Date(now - d * 86400000).toISOString(), toolName: bizToolSamples[i % 2].name, inputSummary: "最近广告数据", outputSummary: "分析已完成", durationMs: 240 + i * 80, tokenCount: 380 + i * 60, status: "success" })) };
}
// 顶部汇总要区分「真的是 0」和「没有数据」：DSH 协议不返回 token 时后端诚实标 null，
// 当成 0 累加会显示「0 Tokens」，看着像测出来零消耗，实际是压根没测。
// 全都没数据 → 「Token数据暂缺」；只要有一条有真实数值就正常求和（null 按 0 计入）。
function bizTokenSummary(calls) {
  const num = (c) => (c && c.tokenCount != null && Number.isFinite(Number(c.tokenCount)) ? Number(c.tokenCount) : null);
  if (!calls.some((c) => num(c) !== null)) return "Token数据暂缺";
  return calls.reduce((n, c) => n + (num(c) || 0), 0) + " Tokens";
}
async function bizLoadUsage() {
  const seq = ++bizUsageRequest; $("#usageStatus").textContent = "读取调用记录…";
  $("#usageRanges").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.range === bizUsageRange)));
  try {
    const result = await bizRead("/api/usage/tool-calls?range=" + bizUsageRange, bizUsageSample);
    if (seq !== bizUsageRequest) return;
    if (!Array.isArray(result.data.calls)) throw new Error("调用日志接口返回格式不正确");
    const calls = result.data.calls;
    $("#usageStatus").textContent = (result.mock ? "示例数据 · 日志接口待接入。" : "") + (calls.length ? calls.length + " 次调用 · " + bizTokenSummary(calls) : "所选时间范围内没有工具调用");
    bizTable($("#usageList"), ["时间", "工具", "输入摘要", "输出摘要", "耗时", "Tokens", "状态"], calls.map(c => [fmtTime(c.timestamp), c.toolName, c.inputSummary, c.outputSummary, c.durationMs == null ? "—" : c.durationMs + " ms", c.tokenCount, ({ success: "成功", completed: "成功", failed: "失败", error: "失败", running: "执行中", started: "执行中", skipped: "未执行", pending: "等待中" })[c.status] || c.status]));
  } catch (e) { if (seq === bizUsageRequest) { $("#usageList").replaceChildren(); $("#usageStatus").textContent = e.message; } }
}
$("#usageRanges").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { bizUsageRange = b.dataset.range; bizLoadUsage(); }));
$("#usageRetry").addEventListener("click", bizLoadUsage);
const bizImportApi = "/api/business/attribution/import";
const bizUploadStatus = { pending: "排队中", validating: "结构校验中", ready: "结构校验通过 · 待确认", importing: "正在入库", completed: "导入完成", partial_failed: "部分行失败", failed: "导入失败", cancelled: "已取消" };
let bizScheduleRequest = 0;
async function bizLoadSchedule() {
  const seq = ++bizScheduleRequest; $("#scheduleStatus").textContent = "读取上传记录…";
  const sampleJob = { importId: "demo-upload", provider: "google", originalName: "广告数据示例.csv", status: "completed", rowCount: 120, successRows: 120, createdAt: new Date().toISOString() };
  try {
    const [jr, wr] = await Promise.all([
      bizRead(bizImportApi + "/jobs", bizMock ? () => ({ jobs: [sampleJob] }) : null),
      bizRead(bizImportApi + "/workspace", bizMock ? () => ({ workspace: { firstConnectedAt: sampleJob.createdAt } }) : null)
    ]);
    if (seq !== bizScheduleRequest) return;
    if (!Array.isArray(jr.data.jobs)) throw new Error("上传记录接口返回格式不正确");
    const jobs = jr.data.jobs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    $("#scheduleConnected").textContent = fmtTime(wr.data.workspace && wr.data.workspace.firstConnectedAt) || "尚未接通（首次成功导入后自动记录）";
    $("#scheduleStatus").textContent = (jr.mock ? "示例上传记录。" : "") + (jobs.length ? "上传时间是文件被上传的时间；数据仅在重新上传时更新。" : "还没有上传记录，点击「新增上传」开始第一次导入。");
    bizTable($("#scheduleHistory"), ["状态", "平台", "文件", "读到行数", "入库", "上传时间", "详情"], jobs.map(j => {
      const detail = bizNode("details"), summary = bizNode("summary", "查看"); detail.appendChild(summary);
      let loaded = false;
      detail.addEventListener("toggle", async () => {
        if (!detail.open || loaded) return; loaded = true; const content = bizNode("p", "读取详情…"); detail.appendChild(content);
        try { const r = await bizRead(bizImportApi + "/jobs/" + encodeURIComponent(j.importId), bizMock ? () => ({ job: j }) : null); const job = r.data.job; if (!job) throw new Error("找不到该任务"); content.textContent = "平台 " + (job.provider || "—") + " · " + (job.originalName || "—") + " · 最终入库 " + (job.successRows == null ? "—" : job.successRows) + " · 失败行 " + (job.failedRows || 0); if (job.errorDetails && job.errorDetails.length) detail.appendChild(bizNode("pre", JSON.stringify(job.errorDetails, null, 2))); }
        catch (e) { content.textContent = e.message; loaded = false; }
      });
      return [bizUploadStatus[j.status] || j.status, j.provider, j.originalName, j.rowCount, j.successRows, fmtTime(j.createdAt), detail];
    }));
  } catch (e) { if (seq === bizScheduleRequest) { $("#scheduleHistory").replaceChildren(); $("#scheduleConnected").textContent = "暂时无法读取首次接通时间"; $("#scheduleStatus").textContent = e.message; } }
}
$("#scheduleUpload").addEventListener("click", () => switchView("import"));
$("#scheduleRetry").addEventListener("click", bizLoadSchedule);
