/**
 * 快捷问题动态渲染 —— 验收测试
 *
 * 关键点：本脚本不另写一份「替身实现」，而是从 app.js 真实源码里
 * 截取 QUICK_QUESTIONS_BEGIN/END 之间的代码原样执行，测的就是线上要跑的那份逻辑。
 *
 * 用法： node _u_quick_accept.cjs
 * 结果：终端打印 + 写入 __u_quick_accept_result.txt
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = __dirname;
const APP_JS = path.join(REPO, "shell", "public", "app.js");

/* ---------- 1. 从 app.js 抽出被测代码 ---------- */
const src = fs.readFileSync(APP_JS, "utf8");
const B = "/* QUICK_QUESTIONS_BEGIN */", E = "/* QUICK_QUESTIONS_END */";
const b = src.indexOf(B), e = src.indexOf(E);
if (b < 0 || e < 0) {
  console.error("FAIL: 在 app.js 里找不到 QUICK_QUESTIONS_BEGIN/END 标记");
  process.exit(1);
}
const block = src.slice(b + B.length, e);

/* ---------- 2. 极简 DOM 垫片 ---------- */
function makeNode(tag) {
  const n = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    listeners: {},
    _text: "",
    hidden: false,
    type: "",
    title: "",
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = v == null ? "" : String(v);
      this.children = []; // 赋值即清空子节点（对齐真实语义）
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    },
    click() {
      (this.listeners.click || []).forEach((f) => f());
    },
  };
  return n;
}
const document = { createElement: makeNode };

const sandbox = { document, console, fetch: () => Promise.reject(new Error("no network in test")) };
vm.createContext(sandbox);
const api = vm.runInContext(block + "\n({ pickQuickQuestion, renderQuickRow, loadQuickQuestions });", sandbox);
const { pickQuickQuestion, renderQuickRow, loadQuickQuestions } = api;

/* ---------- 3. 真实数据：基座 server.cjs 里 SKILL_QUESTIONS 的当前值 ---------- */
const REAL = [
  { id: "attribution.query", title: "归因查询", desc: "", sampleQuestion: "最近7天各渠道素材表现如何？" },
  { id: "media.route", title: "媒体生成", desc: "", sampleQuestion: "帮我生成一张产品宣传图：画面是一杯咖啡放在木桌上，暖色灯光，简约高级风格。" },
  { id: "ga.query", title: "GA 数据查询", desc: "", sampleQuestion: "这周我的GA网站访问量多少？" },
];

/* ---------- 4. 断言工具 ---------- */
let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push("PASS  " + name); }
  else { fail++; lines.push("FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function eq(name, got, want) {
  ok(name, got === want, "got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
}

/* ---------- 5. 用例 ---------- */

// A. 3 个真实技能 -> 3 个按钮，文案逐字一致（验收标准①②）
{
  const box = makeNode("div");
  const n = renderQuickRow(REAL, box);
  eq("A1 按钮数 = 技能数", n, 3);
  eq("A2 容器子节点数", box.children.length, 3);
  eq("A3 第1个按钮文案", box.children[0].textContent, REAL[0].sampleQuestion);
  eq("A4 第2个按钮文案", box.children[1].textContent, REAL[1].sampleQuestion);
  eq("A5 第3个按钮文案", box.children[2].textContent, REAL[2].sampleQuestion);
  ok("A6 渲染后容器可见", box.hidden === false);
  eq("A7 顺序保持（第3个 id=ga.query）", box.children[2].dataset.skillId, "ga.query");
  eq("A8 hover 提示带技能名", box.children[0].title, "技能：归因查询");
}

// B. 点击触发对应技能例句（验收标准②）
{
  const box = makeNode("div");
  const picked = [];
  renderQuickRow(REAL, box, (q) => picked.push(q));
  box.children[1].click(); // 点第 2 个（媒体生成）
  eq("B1 点击触发次数", picked.length, 1);
  eq("B2 点击传出的是该技能例句", picked[0], REAL[1].sampleQuestion);
  box.children[2].click();
  eq("B3 再点第3个传出正确例句", picked[1], REAL[2].sampleQuestion);
}

// C. 新增/下线技能不用改前端：数量自动跟随（验收标准③）
{
  const box = makeNode("div");
  const five = REAL.concat([
    { id: "x.one", title: "新技能一", sampleQuestion: "新技能一怎么用？" },
    { id: "x.two", title: "新技能二", sampleQuestion: "新技能二帮我看看" },
  ]);
  eq("C1 扩到5个技能 -> 5个按钮", renderQuickRow(five, box), 5);
  const box2 = makeNode("div");
  eq("C2 技能下线剩2个 -> 2个按钮", renderQuickRow(REAL.slice(0, 2), box2), 2);
  const box3 = makeNode("div");
  eq("C3 重复渲染不累积", renderQuickRow(REAL, box3) === 3 && renderQuickRow(REAL, box3) === 3 && box3.children.length === 3, true);
}

// D. 字段缺失 / 异常形状：不崩且优雅降级
{
  const box = makeNode("div");
  const messy = [
    { id: "no.q", title: "没配例句的技能" },                       // 无 sampleQuestion -> 标题兜底
    { id: "snake.q", sample_question: "蛇形字段例句" },             // snake_case 兼容
    { id: "ws.q", sampleQuestion: "   前后有空格   " },             // 去空格
    null, "字符串", 123, undefined,                                 // 脏数据
    { id: "empty.q", sampleQuestion: "   ", title: "" },            // 例句空且无标题 -> 跳过
  ];
  const n = renderQuickRow(messy, box);
  eq("D1 有效项才渲染（5->4）", n, 4);
  eq("D2 标题兜底文案", box.children[0].textContent, "没配例句的技能 可以帮我做什么？");
  eq("D3 snake_case 兜底字段可用", box.children[1].textContent, "蛇形字段例句");
  eq("D4 例句去空格", box.children[2].textContent, "前后有空格");
  eq("D5 脏数据被跳过后的第4项", box.children[3].textContent, "empty.q 可以帮我做什么？");
}

// E. 空列表 / 非数组：整块收起，不留空白 margin
{
  const box = makeNode("div");
  eq("E1 空数组 -> 0按钮", renderQuickRow([], box), 0);
  ok("E2 空数组 -> 容器隐藏", box.hidden === true);
  const box2 = makeNode("div");
  eq("E3 null -> 0按钮", renderQuickRow(null, box2), 0);
  ok("E4 null -> 容器隐藏", box2.hidden === true);
  let threw = false;
  try { renderQuickRow("不是数组", makeNode("div")); } catch (e) { threw = true; }
  ok("E5 非数组不抛异常", threw === false);
}

// F. 安全：HTML 内容不得被当成标签解析（走 textContent）
{
  const box = makeNode("div");
  const evil = [{ id: "xss", title: "<img src=x onerror=alert(1)>", sampleQuestion: "<script>alert(1)</script>帮我看看" }];
  renderQuickRow(evil, box);
  eq("F1 恶意例句原样存为文本", box.children[0].textContent, "<script>alert(1)</script>帮我看看");
  ok("F2 未产生子节点（说明是纯文本）", box.children[0].children.length === 0);
}

// G. pickQuickQuestion 单点
{
  eq("G1 取 sampleQuestion", pickQuickQuestion(REAL[0]), REAL[0].sampleQuestion);
  eq("G2 非对象返回空", pickQuickQuestion("x"), "");
  eq("G3 null 返回空", pickQuickQuestion(null), "");
  eq("G4 只有 id 时用 id 兜底", pickQuickQuestion({ id: "only.id" }), "only.id 可以帮我做什么？");
}

// H. 网络异常不影响主流程（loadQuickQuestions 内部静默）
{
  ok("H1 loadQuickQuestions 是函数", typeof loadQuickQuestions === "function");
  let threw = false;
  try { const p = loadQuickQuestions(); p.catch(() => {}); } catch (e) { threw = true; }
  ok("H2 fetch 失败不向外抛同步异常", threw === false);
}

/* ---------- 6. 输出 ---------- */
const total = pass + fail;
const head = [
  "快捷问题动态渲染 —— 验收测试",
  "被测源码：shell/public/app.js（QUICK_QUESTIONS_BEGIN/END 之间，非替身实现）",
  "数据源：基座 shell/server.cjs 的 SKILL_QUESTIONS 当前值",
  "",
].join("\n");
const tail = "\n合计：" + total + " 项，PASS " + pass + " / FAIL " + fail + "\n" + (fail === 0 ? "RESULT: ALL PASS" : "RESULT: HAS FAILURE");
const out = head + lines.join("\n") + tail;
fs.writeFileSync(path.join(REPO, "__u_quick_accept_result.txt"), out, "utf8");
console.log(out);
process.exit(fail === 0 ? 0 : 1);
