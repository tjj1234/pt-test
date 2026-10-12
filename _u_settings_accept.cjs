/**
 * 「账户与授权」页面瘦身 —— 验收测试
 *
 * 这一页的验收点是「页面上不残留 GA 相关内容」+「两张卡片上下排列」，
 * 属于结构/契约层面的事实，所以直接读真实文件做静态核实，不造运行时替身。
 * 另外顺带检查 settings.js 不再引用被删掉的那批 DOM id —— 否则线上会 null 引用崩。
 *
 * 用法： node _u_settings_accept.cjs
 * 结果：终端打印 + 写入 __u_settings_accept_result.txt
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HTML = path.join(__dirname, "shell", "public", "settings.html");
const JS = path.join(__dirname, "shell", "public", "settings.js");
const html = fs.readFileSync(HTML, "utf8");
const js = fs.readFileSync(JS, "utf8");

let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push("PASS  " + name); }
  else { fail++; lines.push("FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function absent(name, re) { ok("已删除 " + name, !re.test(html) && !re.test(js)); }
function present(name, re, src) { ok("保留 " + name, re.test(src)); }

/* ---------- 1. GA 相关内容已从设置页移除 ---------- */
absent("GA4 property ID 输入框", /gaPropertyId/);
absent("「连接Google Analytics」按钮", /gaConnect/);
absent("刷新连接状态按钮", /gaRefresh/);
absent("GA 错误提示区", /gaError/);
/* ---------- 1b. 非 GA 的「广告与数据源授权」清单已按 M7 交互模式补回 ----------
 * 10/10 删那节的理由只是「GA 挪去技能页」，结果把非 GA 的账户清单一起误杀了。
 * PRD 3.4（清单 + 授权范围 + 三态 + 解除影响提醒）并没有撤销，所以这里恢复 negative
 * 断言的范围仅限 GA，下面的 acct-* 反而必须存在。
 */
present("已补回「广告与数据源授权」小节", /id="sourcesHeading"/, html);
present("授权列表容器不为空占位", /id="acctList"[\s\S]{0,80}id="acctStatus"|id="acctStatus"[\s\S]{0,200}id="acctList"/, html);
present("三态徽标样式齐全", /\.acct-badge\.ok[\s\S]{0,200}\.acct-badge\.warn[\s\S]{0,200}\.acct-badge\.danger/, html);
present("解除确认弹框（取消 / 确认解除）", /id="revokeModal"[\s\S]{0,600}id="revokeCancel"[\s\S]{0,300}id="revokeConfirm"/, html);
present("mock 开关 + 契约注释", /USE_MOCK_AUTH_ACCOUNTS[\s\S]{0,200}\/api\/auth-accounts/, js);
present("解除影响提醒文案", /解除影响/, js);
ok("不再出现 GA property 连接入口（仍只走技能页）", !/gaPropertyId|gaConnect|gaRefresh|gaError/.test(html));

/* ---------- 2. 该保留的都还在 ---------- */
present("PT key 表单", /id="f"/, html);
present("PT key 输入框", /id="key"/, html);
present("保存绑定按钮", /id="save"/, html);
present("已绑定态（掩码/更新时间）", /id="mask"[\s\S]{0,200}id="updated"/, html);
present("当前登录账户信息", /id="accountIdentity"/, html);
present("修改登录密码卡片", /id="pwf"/, html);
present("PT key 读写接口", /\/api\/auth\/key/, js);
present("账户信息接口", /\/api\/auth\/me/, js);
present("修改密码脚本仍在引入", /settings-pw\.js/, html);

/* ---------- 3. 两张卡片上下排列（修掉此前重叠） ---------- */
const wrapRule = html.match(/\.login-wrap\{[^}]*\}/);
ok("存在 .login-wrap 布局规则", !!wrapRule, html.slice(0, 0));
ok(".login-wrap 改为纵向排列", !!wrapRule && /flex-direction:column/.test(wrapRule[0]), wrapRule && wrapRule[0]);
ok(".login-wrap 给了卡片间距", !!wrapRule && /gap:\s*\d+px/.test(wrapRule[0]), wrapRule && wrapRule[0]);
ok("密码卡片不再自带 margin-top（避免和 gap 叠加）", !/id="pwf"[^>]*margin-top/.test(html));

/* ---------- 4. settings.js 仍然可解析、且不引用已删 DOM ---------- */
let syntaxOk = true, syntaxErr = "";
try {
  execFileSync(process.execPath, ["--check", JS], { stdio: "pipe" });
} catch (e) {
  syntaxOk = false;
  syntaxErr = String((e.stderr && e.stderr.toString()) || e.message);
}
ok("settings.js 语法可解析", syntaxOk, syntaxErr);
// 比「列黑名单」更硬的不变量：settings.js 里 $("#X") 引用的每个 id，HTML 里都必须真存在。
// 否则少一个节点就是线上 null 引用崩 —— 这正是上一次删节时要防的事。
const referenced = [...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]);
const missing = [...new Set(referenced)].filter((id) => !new RegExp('id="' + id + '"').test(html));
ok("settings.js 引用的 DOM id 在 HTML 里都存在", missing.length === 0, "缺：" + missing.join(", "));
ok("settings.js 仍是自执行闭包（无全局泄漏）", /^\(function \(\) \{[\s\S]*\}\)\(\);?\s*$/m.test(js.trim()));

const head = "设置页瘦身验收：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）";
const out = [head, ""].concat(lines).join("\n");
console.log(out);
fs.writeFileSync(path.join(__dirname, "__u_settings_accept_result.txt"), out + "\n", "utf8");
process.exit(fail ? 1 : 0);
