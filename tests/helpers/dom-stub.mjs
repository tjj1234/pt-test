/**
 * 最小 DOM 桩 —— 仓库里没有 jsdom，前端回归测试靠它把真实的 shell/public/app.js
 * 放进 vm 里跑起来（验证的是产品代码，不是复制品）。
 *
 * 用法：
 *   import { makeDomStub } from "../helpers/dom-stub.mjs";
 *   const dom = makeDomStub();
 *   const ctx = vm.createContext({ console, ...dom, window: {...}, fetch: fakeFetch, ... });
 *   vm.runInContext(readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
 *   dom.document.querySelector("#chat")   // 拿到桩元素，可查 children / textContent
 *
 * 设计约定：
 *   - querySelector("#id") 命中同一份缓存：app.js 顶部的 $("#chat") 和后面 $("...") 拿到同一对象。
 *   - innerHTML = "" 会清空 children（renderChat 靠它刷屏），这样能断言"视图有没有被覆盖"。
 *   - 只实现 app.js 真正用到的 API；缺方法时补在 makeEl 里，别在测试里 monkey patch。
 */
export function makeEl(tag) {
  const listeners = Object.create(null);
  let _html = "";
  const el = {
    tagName: tag || "div", id: "", className: "", hidden: false, value: "", textContent: "",
    src: "", title: "", alt: "", disabled: false, files: null,
    scrollTop: 0, scrollHeight: 0, style: {}, dataset: {}, accept: "",
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
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
    // 桩不解析 HTML，所以 querySelector 命中不到真实子节点 —— 造一个并挂进 children，
    // 这样 streamInto(t, text) 写进 .bub 的内容能被断言到（真实 DOM 里它本来就在子树中）。
    querySelector(sel) {
      el._q = el._q || new Map();
      if (!el._q.has(sel)) { const c = makeEl(); el._q.set(sel, c); el.children.push(c); }
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

export class EventStub {
  constructor(t, o) { this.type = t; Object.assign(this, o || {}); }
}

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

export function makeDomStub() {
  const elCache = new Map();
  const body = makeEl("body");
  const document = {
    body,
    // "#id" / ".cls" / 任意选择器都走同一份缓存，保证 app.js 里多次 $("...") 拿到同一对象
    querySelector(sel) {
      if (!elCache.has(sel)) { const e = makeEl(); e.id = String(sel).replace(/^#/, ""); elCache.set(sel, e); }
      return elCache.get(sel);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return document.querySelector("#" + String(id)); },
    createElement(t) { return makeEl(t); },
    createTextNode(t) { const e = makeEl("#text"); e.textContent = String(t); return e; },
    addEventListener() {}, removeEventListener() {},
  };
  return {
    document,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    Event: EventStub,
    makeEl,
    /** 按 id 取桩元素（等价于 document.querySelector("#"+id)） */
    el: (id) => document.querySelector("#" + id),
  };
}
