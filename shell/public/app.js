const $ = s => document.querySelector(s);
const chat = $("#chat"), ta = $("#ta"), send = $("#send"), cm = $("#cm");
let busy = false, dashLoaded = false;

/* ---- 视图切换 ---- */
const TITLES = { chat: "对话", dash: "归因看板", skills: "技能", status: "运行状态" };
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => {
  const v = b.dataset.v;
  document.querySelectorAll(".nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach(x => x.classList.toggle("on", x.id === "v-" + v));
  $("#title").textContent = TITLES[v];
  if (v === "dash" && !dashLoaded) { $("#dashFrame").src = "/dashboard/"; dashLoaded = true; }
  if (v === "skills") loadSkills();
  if (v === "status") loadStatus();
}));

/* ---- 气泡 ---- */
function bubble(role, text, meta) {
  const el = document.createElement("div");
  el.className = "msg " + (role === "user" ? "u" : "a");
  const av = document.createElement("div"); av.className = "av"; av.textContent = role === "user" ? "我" : "北";
  const box = document.createElement("div");
  const bub = document.createElement("div"); bub.className = "bub"; bub.textContent = text;
  box.appendChild(bub);
  if (meta) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta; box.appendChild(m); }
  el.appendChild(av); el.appendChild(box); chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}
function thinking() {
  const el = document.createElement("div");
  el.className = "msg a";
  el.innerHTML = '<div class="av">北</div><div><div class="bub"><span class="typing"><i></i><i></i><i></i></span> 正在查数据、跑技能…</div></div>';
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
  return el;
}
/* P0-3：未绑 key 的友好提示 + 「去绑定」按钮（不是「执行失败」） */
function needKeyBubble() {
  const el = document.createElement("div");
  el.className = "msg a";
  const av = document.createElement("div"); av.className = "av"; av.textContent = "北";
  const box = document.createElement("div");
  const bub = document.createElement("div"); bub.className = "bub";
  bub.textContent = "你还没绑定 PT key，绑定后我才能替你查数据、跑技能。";
  const btn = document.createElement("button");
  btn.className = "keygo"; btn.textContent = "🔑 去绑定";
  btn.addEventListener("click", () => { location.href = "/settings"; });
  box.appendChild(bub); box.appendChild(btn);
  el.appendChild(av); el.appendChild(box); chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

async function ask(msg) {
  if (busy || !msg.trim()) return;
  busy = true; send.disabled = true; ta.disabled = true;
  if ($("#hello")) $("#hello").remove();
  bubble("user", msg);
  ta.value = ""; ta.style.height = "auto";
  const t = thinking();
  const t0 = Date.now();
  const tick = setInterval(() => { cm.textContent = "已等待 " + Math.round((Date.now() - t0) / 1000) + " 秒…"; }, 1000);
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg }) });
    const j = await r.json();
    clearInterval(tick); t.remove();
    if (!r.ok && r.status === 409 && j.needKey === true) {
      // P0-3：未绑 key → 友好提示 + 一键去绑定，绝不落「执行失败」
      needKeyBubble();
      cm.textContent = "";
    } else if (j.ok) {
      bubble("assistant", j.reply, "耗时 " + (j.ms / 1000).toFixed(1) + " 秒 · 第 " + j.turns + " 轮");
      cm.textContent = "第 " + j.turns + " 轮 · 上下文由业务壳维护（headless 不续接会话）";
    } else {
      bubble("assistant", "执行失败了（退出码 " + j.exitCode + "）：\n" + (j.reply || j.error || ""), "退出码 " + j.exitCode);
      cm.textContent = "";
    }
  } catch (x) {
    clearInterval(tick); t.remove(); bubble("assistant", "请求出错：" + x.message); cm.textContent = "";
  }
  busy = false; send.disabled = false; ta.disabled = false; ta.focus();
}

send.addEventListener("click", () => ask(ta.value));
ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(ta.value); } });
ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 170) + "px"; });
document.querySelectorAll(".quick button").forEach(b => b.addEventListener("click", () => ask(b.textContent)));

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
    if (r.status === 401) return;              // 未登录（index 有服务端守卫，理论上到不了）
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) return;
    const bound = !!(j.key && j.key.key_last4);
    const dot = $("#keyDot"), last4 = $("#keyLast4"), banner = $("#keyBanner");
    if (dot) dot.hidden = bound;               // 未绑 → 红点；已绑 → 隐藏
    if (last4) { last4.hidden = !bound; if (bound) last4.textContent = "····" + j.key.key_last4; }
    if (banner) banner.hidden = bound;         // 未绑 → 顶部提示条；已绑 → 不打扰
  } catch (x) { /* 拉不到 key 状态不打扰主界面，静默 */ }
}

/* ---- 登录后读回历史：退出再登录也能看到之前的对话 ---- */
async function loadHistory() {
  try {
    const r = await fetch("/api/chat/history", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.messages)) return;
    for (const m of j.messages) {
      if (!m || !m.text) continue;
      bubble(m.role === "user" ? "user" : "assistant", m.text);
    }
  } catch (x) { /* 读不到历史不打扰主界面，静默 */ }
}

/* ---- 启动时拉一次状态（侧栏徽标 + 我的 Key + 历史）---- */
(async () => {
  try { const j = await (await fetch("/api/skills")).json(); $("#pSkills").textContent = "技能 " + j.skills.length; $("#pSkills").className = "pill ok"; } catch (e) {}
  try { const j = await (await fetch("/api/status")).json(); $("#pDash").textContent = "看板 " + (j.dashboardOk ? "在线" : "离线"); $("#pDash").className = "pill " + (j.dashboardOk ? "ok" : "bad"); } catch (e) {}
  loadKeyState();
  loadHistory();
  ta.focus();
})();
