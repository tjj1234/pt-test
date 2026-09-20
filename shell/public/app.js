const $ = s => document.querySelector(s);
const chat = $("#chat"), ta = $("#ta"), send = $("#send"), stopBtn = $("#stop"), cm = $("#cm");
const convListEl = $("#convList"), newBtn = $("#newConv");
let dashLoaded = false;
const state = { list: [], activeId: null, busy: false };

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
const TITLES = { chat: "对话", dash: "归因看板", skills: "技能", status: "运行状态", memory: "长期记忆" };
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => {
  const v = b.dataset.v;
  document.querySelectorAll(".nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach(x => x.classList.toggle("on", x.id === "v-" + v));
  $("#title").textContent = TITLES[v];
  if (v === "dash" && !dashLoaded) { $("#dashFrame").src = "/dashboard/"; dashLoaded = true; }
  if (v === "skills") loadSkills();
  if (v === "status") loadStatus();
  if (v === "memory") loadMemory();
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
  el.innerHTML = '<div class="av">北</div><div class="box"><div class="bub"><span class="typing"><i></i><i></i><i></i></span> 正在查数据、跑技能…<span class="elapsed"></span></div></div>';
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
  btn.textContent = ok ? "已复制" : "复制失败";
  setTimeout(() => { btn.textContent = "复制"; }, 1500);
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
  const btxt = document.createElement("span"); btxt.className = "bubtext"; btxt.textContent = m.text == null ? "" : m.text;
  bub.appendChild(btxt);
  box.appendChild(bub);

  const meta = document.createElement("div"); meta.className = "meta";
  if (m.ts) {
    const ts = document.createElement("span"); ts.className = "ts"; ts.textContent = fmtTime(m.ts);
    meta.appendChild(ts);
  }
  if (m.text) {
    const copy = document.createElement("button"); copy.className = "msgbtn"; copy.textContent = "复制";
    copy.addEventListener("click", () => copyText(m.text, copy));
    meta.appendChild(copy);
  }
  if (opts && opts.branchable && m.role === "assistant") {
    const br = document.createElement("button"); br.className = "msgbtn"; br.textContent = "分岔";
    br.title = "以这条回复之前的上下文重新生成";
    br.addEventListener("click", () => branch(opts.index));
    meta.appendChild(br);
  }
  if (opts && opts.regeneratable) {
    const regen = document.createElement("button"); regen.className = "msgbtn"; regen.textContent = "重新生成";
    regen.addEventListener("click", () => regenerate());
    meta.appendChild(regen);
  }
  box.appendChild(meta);
  el.appendChild(av); el.appendChild(box);
  chat.appendChild(el);
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
  const btn = document.createElement("button"); btn.className = "msgbtn"; btn.textContent = "重新生成";
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

    const menu = document.createElement("button"); menu.className = "conv-menu"; menu.textContent = "⋯";
    menu.title = "更多操作";
    menu.addEventListener("click", (e) => { e.stopPropagation(); openMenu(c, menu); });
    item.appendChild(menu);

    item.addEventListener("click", () => { if (state.activeId !== c.id) openConversation(c.id); });
    return item;
  };

  const section = (label, items) => {
    const h = document.createElement("div"); h.className = "conv-sec"; h.textContent = label;
    convListEl.appendChild(h);
    if (!items.length) {
      const e = document.createElement("div"); e.className = "conv-empty"; e.textContent = "（空）";
      convListEl.appendChild(e);
      return;
    }
    for (const c of items) convListEl.appendChild(mkItem(c));
  };

  section("进行中", active);
  section("已归档", archived);
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

async function openConversation(id) {
  state.activeId = id;
  renderList();
  try {
    const r = await fetch("/api/conversations/" + encodeURIComponent(id), { credentials: "same-origin" });
    if (!r.ok) { renderChat([]); return; }
    const j = await r.json().catch(() => null);
    renderChat(j && j.conversation ? j.conversation.messages : []);
  } catch (e) { renderChat([]); }
}

async function newConversation() {
  try {
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
  return null;
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
function setBusy(b) {
  state.busy = b;
  send.disabled = b;
  ta.disabled = b;
  stopBtn.hidden = !b;
  if (!b) ta.focus();
}

async function runChat(payload) {
  if (state.busy) return;
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
          if (obj.delta) { acc += obj.delta; streamInto(t, acc); }
          if (obj.done) {
            gotDone = true;
            clearInterval(tick); t.remove();
            if (obj.stopped) { renderChat(obj.messages); showStoppedBar(); cm.textContent = "已停止"; }
            else if (obj.ok) { renderChat(obj.messages); cm.textContent = "第 " + obj.turns + " 轮 · 上下文由业务壳维护（headless 不续接会话）"; }
            else { if (Array.isArray(obj.messages)) renderChat(obj.messages); else bubbleSys("执行失败：" + (obj.error || "")); cm.textContent = ""; }
            await refreshList();
          }
        }
      }
      // 保险：流异常结束却没收到 done
      if (!gotDone) { clearInterval(tick); t.remove(); if (acc) renderMessage({ role: "assistant", text: acc, ts: Date.now() }); }
    } else {
      // 非流式（预检错误 / needKey / busy 等 JSON）
      const j = await r.json().catch(() => null);
      clearInterval(tick); t.remove();
      if (!r.ok && r.status === 409 && j && j.needKey) {
        needKeyBubble(); cm.textContent = "";
      } else if (!r.ok && r.status === 409 && j && j.busy) {
        bubbleSys(j.error || "上一个还在跑，请先停止或等它结束"); cm.textContent = "";
      } else if (j && j.stopped) {
        renderChat(j.messages); showStoppedBar(); cm.textContent = "已停止";
      } else if (j && j.ok) {
        renderChat(j.messages);
        cm.textContent = "第 " + j.turns + " 轮 · 上下文由业务壳维护（headless 不续接会话）";
      } else {
        const err = (j && j.error) ? j.error : ("HTTP " + r.status);
        if (j && Array.isArray(j.messages)) renderChat(j.messages);
        else bubbleSys("执行失败：" + err);
        cm.textContent = "";
      }
      await refreshList();
    }
  } catch (x) {
    clearInterval(tick); t.remove(); bubbleSys("请求出错：" + x.message); cm.textContent = "";
  } finally {
    setBusy(false);
  }
}

async function ask(msg) {
  if (state.busy || !msg.trim()) return;
  if (!state.activeId) {
    const id = await newConversation();
    if (!id) return;
  }
  ta.value = ""; ta.style.height = "auto";
  const payload = { conversationId: state.activeId, message: msg };
  if (pendingImage) payload.image = pendingImage;
  // 立即渲染用户消息（乐观更新），AI 回复回来后再用服务器完整列表覆盖
  renderMessage({ role: "user", text: msg, ts: Date.now(), image: pendingImage || undefined });
  chat.scrollTop = chat.scrollHeight;
  clearPendingImage();
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

/* ---- ⑧ 导出（Content-Disposition 触发下载） ---- */
function exportConversation(c, fmt) {
  const a = document.createElement("a");
  a.href = "/api/conversations/" + encodeURIComponent(c.id) + "/export?fmt=" + (fmt || "md");
  document.body.appendChild(a); a.click(); a.remove();
}

send.addEventListener("click", () => ask(ta.value));
newBtn.addEventListener("click", () => newConversation());
stopBtn.addEventListener("click", async () => {
  if (!state.busy) return;
  try { await fetch("/api/chat/stop", { method: "POST", credentials: "same-origin" }); } catch (e) { /* 静默 */ }
});
ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(ta.value); } });
ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 170) + "px"; });
document.querySelectorAll(".quick button").forEach(b => b.addEventListener("click", () => ask(b.textContent)));

/* ---- 技能 ---- *//* ---- ⑨ 图片上传 ---- */
const imgInput = $("#imgInput"), imgBtn = $("#imgBtn"), imgPreview = $("#imgPreview"), imgThumb = $("#imgThumb"), imgClear = $("#imgClear");
let pendingImage = null;
function setPendingImage(url) { pendingImage = url; imgThumb.src = url; imgPreview.hidden = false; }
function clearPendingImage() { pendingImage = null; imgThumb.removeAttribute("src"); imgPreview.hidden = true; if (imgInput) imgInput.value = ""; }
if (imgBtn) imgBtn.addEventListener("click", () => imgInput.click());
if (imgClear) imgClear.addEventListener("click", clearPendingImage);
if (imgInput) imgInput.addEventListener("change", async () => {
  const f = imgInput.files && imgInput.files[0];
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) { alert("图片太大（≤15MB）"); imgInput.value = ""; return; }
  let b64;
  try {
    b64 = await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => reject(new Error("读取失败"));
      rd.readAsDataURL(f);
    });
  } catch (e) { alert("读取失败：" + e.message); return; }
  try {
    const r = await fetch("/api/upload", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: b64 }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok && j.url) setPendingImage(j.url);
    else alert((j && j.error) || "上传失败");
  } catch (e) { alert("上传失败：" + e.message); }
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
  } catch (e) { /* 静默 */ }
}
if (modelSelect) modelSelect.addEventListener("change", async () => {
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

/* ---- 技能 ---- */
async function loadSkills() {
  const g = $("#skillGrid"); g.innerHTML = '<div class="card"><p>读取中…</p></div>';
  try {
    const j = await (await fetch("/api/skills")).json();
    $("#pSkills").textContent = "技能 " + j.skills.length;
    $("#pSkills").className = "pill ok";
    g.innerHTML = j.skills.map(s =>
      '<div class="card"><h4>' + s.title + '</h4><p>' + (s.desc || "（无描述）") + '</p><span class="tag">' + s.id + '</span></div>'
    ).join("") || '<div class="card"><p>没有技能</p></div>';
  } catch (x) { g.innerHTML = '<div class="card"><p>读不到：' + x.message + '</p></div>'; }
}

/* ---- 状态 ---- */
async function loadStatus() {
  try {
    const j = await (await fetch("/api/status")).json();
    $("#pDash").textContent = "看板 " + (j.dashboardOk ? "在线" : "离线");
    $("#pDash").className = "pill " + (j.dashboardOk ? "ok" : "bad");
    $("#statusKv").innerHTML = [
      ["产品 DSH_HOME（隔离边界）", j.dshHome],
      ["产品工作区", j.workspace],
      ["产品技能数", j.skills + " 个"],
      ["看板后端 127.0.0.1:" + j.dashboard, j.dashboardOk ? "✅ 在线" : "❌ 离线（先启动北极星后端）"],
      ["DSH 对外端口", "无（headless 不开端口）"],
      ["用户与 DSH 的关系", "用户只跟业务壳说话，永远碰不到 DSH"],
    ].map(r => '<div class="row"><div class="k">' + r[0] + '</div><div class="v">' + r[1] + '</div></div>').join("");
  } catch (x) { $("#statusKv").innerHTML = '<div class="row"><div class="v">读不到：' + x.message + '</div></div>'; }
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
    const dot = $("#keyDot"), last4 = $("#keyLast4"), banner = $("#keyBanner");
    if (dot) dot.hidden = bound;
    if (last4) { last4.hidden = !bound; if (bound) last4.textContent = "····" + j.key.key_last4; }
    if (banner) banner.hidden = bound;
  } catch (x) { /* 静默 */ }
}

/* ---- 启动：拉状态 + 拉对话列表（自动选中最近一个；没有则空状态引导）---- */
(async () => {
  try { const j = await (await fetch("/api/skills")).json(); $("#pSkills").textContent = "技能 " + j.skills.length; $("#pSkills").className = "pill ok"; } catch (e) {}
  try { const j = await (await fetch("/api/status")).json(); $("#pDash").textContent = "看板 " + (j.dashboardOk ? "在线" : "离线"); $("#pDash").className = "pill " + (j.dashboardOk ? "ok" : "bad"); } catch (e) {}
  loadKeyState();
  loadModels();
  await refreshList();
  if (state.list.length) await openConversation(state.list[0].id);
  else renderChat([]);
  ta.focus();
})();
