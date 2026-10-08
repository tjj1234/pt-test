"use strict";
// M-UI-C: isolated member view; no changes to other view controllers.
(function () {
  const view = document.querySelector("#v-members");
  const status = document.querySelector("#membersStatus");
  const list = document.querySelector("#membersList");
  const labels = { owner: "所有者", admin: "管理员", analyst: "分析师", viewer: "访客" };
  const grants = { "tool.use": "运行工具", "tool.register": "注册工具", "tool.manage": "管理工具", "workspace.create": "创建工作区", "workspace.manage": "管理工作区", "workspace.delete": "删除工作区", "system.admin": "系统管理", "attribution:read": "查看归因分析" };
  let request = 0;
  const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); return n; };
  async function api(url, options) {
    const r = await fetch(url, Object.assign({ credentials: "same-origin" }, options));
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || "读取失败（HTTP " + r.status + "）");
    return j;
  }
  async function load() {
    const seq = ++request; status.textContent = "读取成员…"; list.replaceChildren();
    try {
      const [data, defs] = await Promise.all([api("/api/members"), api("/api/roles")]);
      if (seq !== request) return;
      if (!Array.isArray(data.members) || !Array.isArray(defs.roles)) throw new Error("成员接口返回格式不正确");
      status.textContent = data.members.length ? (data.canManage ? "选择角色并保存；不能修改自己的角色。" : "当前角色仅可查看成员，角色修改需由管理员操作。") : "当前团队没有成员";
      const roles = document.querySelector("#membersRoles"); roles.replaceChildren();
      defs.roles.forEach(r => roles.appendChild(node("p", (labels[r.name] || r.name) + "：" + r.permissions.map(p => grants[p] || p).join("、"))));
      const table = node("table"); table.style.cssText = "width:100%;text-align:left;border-collapse:collapse";
      const head = node("thead"), hr = node("tr"); ["成员", "邮箱", "当前角色", "调整角色", "操作"].forEach(t => hr.appendChild(node("th", t))); head.appendChild(hr); table.appendChild(head);
      const body = node("tbody");
      data.members.forEach(m => {
        const row = node("tr"), role = node("td", labels[m.role] || m.role);
        const select = node("select"); select.setAttribute("aria-label", "调整 " + m.username + " 的角色");
        defs.roles.filter(r => data.currentRole === "owner" || r.name !== "owner").forEach(r => { const opt = node("option", labels[r.name] || r.name); opt.value = r.name; select.appendChild(opt); });
        const editable = data.canManage && m.id !== data.currentUserId && (data.currentRole === "owner" || m.role !== "owner");
        if (!Array.from(select.options).some(o => o.value === m.role)) { const opt = node("option", labels[m.role] || m.role); opt.value = m.role; select.appendChild(opt); }
        select.value = m.role; select.disabled = !editable;
        const save = node("button", "保存"); save.type = "button"; save.className = "toolbar-btn"; save.disabled = true;
        select.addEventListener("change", () => { save.disabled = !editable || select.value === m.role; });
        save.addEventListener("click", async () => {
          const previous = m.role; save.disabled = true; select.disabled = true; save.textContent = "保存中…";
          try {
            const j = await api("/api/members/" + encodeURIComponent(m.id) + "/role", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: select.value }) });
            m.role = j.member.role; role.textContent = labels[m.role] || m.role; select.value = m.role; status.textContent = m.username + " 的角色已保存，权限立即生效。";
          } catch (e) { select.value = previous; status.textContent = "保存失败：" + e.message; }
          finally { select.disabled = !editable; save.textContent = "保存"; save.disabled = true; }
        });
        const sc = node("td"), bc = node("td"); sc.appendChild(select); bc.appendChild(save);
        row.append(node("td", m.username + (m.id === data.currentUserId ? "（你）" : "")), node("td", m.email || "—"), role, sc, bc);
        Array.from(row.cells).forEach(c => { c.style.cssText = "padding:12px;border-top:1px solid var(--line);overflow-wrap:anywhere"; }); body.appendChild(row);
      }); table.appendChild(body); list.appendChild(table);
    } catch (e) { if (seq === request) { status.textContent = e.message; list.replaceChildren(); document.querySelector("#membersRoles").replaceChildren(); } }
  }
  document.querySelector("#membersRetry").addEventListener("click", load);
  new MutationObserver(() => { if (view.classList.contains("on")) load(); }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("on")) load();
})();
