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
absent("授权列表容器", /acctList|acctStatus/);
absent("「广告与数据源授权」标题", /广告与数据源授权/);
absent("acct-* 样式类", /acct-item|acct-main|acct-badge|acct-side|acct-scope|acct-updated/);
ok("不再请求 ga-connector 接口", !/ga-connector/.test(js));
ok("不再出现 Google Analytics 字样（注释里的去向说明除外）",
  !/Google Analytics/.test(html.replace(/<!--[\s\S]*?-->/g, "")));

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
ok("settings.js 不再引用被删的 DOM id", !/\$\("#(gaPropertyId|gaConnect|gaRefresh|gaError|acctList|acctStatus)"\)/.test(js));
ok("settings.js 仍是自执行闭包（无全局泄漏）", /^\(function \(\) \{[\s\S]*\}\)\(\);?\s*$/m.test(js.trim()));

const head = "设置页瘦身验收：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）";
const out = [head, ""].concat(lines).join("\n");
console.log(out);
fs.writeFileSync(path.join(__dirname, "__u_settings_accept_result.txt"), out + "\n", "utf8");
process.exit(fail ? 1 : 0);
