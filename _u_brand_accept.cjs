/* 品牌文案回归验收 —— 静态核实 shell/public 下无「北极星」且新品牌就位
 * 背景：提交包①（技能页面改版）时磁盘文件是旧基线，误把品牌分支
 *       （a2d45dd）对 index.html / app.js 的改动整体回退。
 *       本脚本把「无北极星 + 新品牌就位 + 技能改版未受损」固化成可重跑断言。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "shell", "public");
let pass = 0, fail = 0;
const out = [];
function ok(name, cond, detail) {
  if (cond) { pass++; out.push("PASS " + name); }
  else { fail++; out.push("FAIL " + name + (detail ? "  → " + detail : "")); }
}
function read(f) { return fs.readFileSync(path.join(PUB, f), "utf8"); }

/* ---------- 1. 全量前端文件不得再出现「北极星」 ---------- */
const files = fs.readdirSync(PUB).filter((f) => /\.(html|js)$/.test(f));
const offenders = [];
for (const f of files) {
  const t = read(f);
  if (t.includes("北极星")) offenders.push(f);
}
ok("C1 shell/public 全量 html/js 无「北极星」", offenders.length === 0, offenders.join(", "));

/* ---------- 2. 品牌文案就位（index.html 四处 + app.js 一处） ---------- */
const idx = read("index.html");
ok("C2 index.html title 为新品牌", idx.includes("<title>PowerTokens Agent · 你的增长小助手</title>"));
ok("C3 侧边栏品牌为新品牌", idx.includes("<h1>PowerTokens Agent</h1><p>你的增长小助手</p>"));
ok("C4 首页问候语标题为新品牌", idx.includes("<h3>你好，我是 PowerTokens Agent 👋</h3>"));
ok("C5 首页问候语副标题已简化", idx.includes("你的小助手，可以帮你分析增长数据、生成图片和视频。"));
const app = read("app.js");
ok("C6 状态面板文案已去掉「北极星」", app.includes("❌ 离线（先启动后端服务）"));

/* ---------- 3. 品牌修复不得损伤包①包②的功能改动 ---------- */
ok("C7 技能卡片容器仍在", idx.includes('id="skillGrid"'));
ok("C8 技能详情容器仍在", idx.includes('id="skillDetail"'));
ok("C9 ga-connect.js 仍被引入", idx.includes("/assets/ga-connect.js"));
ok("C10 技能三态判定函数仍在", app.includes("function skillUseDecision"));
ok("C11 按需连接引导仍在", app.includes("renderConnectorBlock"));
const settings = read("settings.html");
ok("C12 设置页无 GA 残留", !/gaPropertyId|gaConnect|acctStatus|Google Analytics/i.test(settings));
ok("C13 设置页两张卡片纵向排列", /\.login-wrap\{[^}]*flex-direction:column/.test(settings));
const gac = fs.existsSync(path.join(PUB, "ga-connect.js"));
ok("C14 共享 GA 连接模块存在", gac);

/* ---------- 4. 语法可解析 ---------- */
try {
  new (require("vm").Script)(app);
  ok("C15 app.js 语法可解析", true);
} catch (e) { ok("C15 app.js 语法可解析", false, e.message); }

/* ---------- 输出 ---------- */
out.push("");
out.push("RESULT " + pass + "/" + (pass + fail) + " PASS" + (fail ? ("  (" + fail + " FAIL)") : ""));
const text = out.join("\n");
console.log(text);
fs.writeFileSync(path.join(__dirname, "__u_brand_accept_result.txt"), text, "utf8");
process.exit(fail ? 1 : 0);
