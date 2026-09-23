"use strict";
// 一次性工具：把 .request.log 里的 time(毫秒 epoch) 转成人类可读时间(北京时间 UTC+8, 带毫秒)
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "D:/trae001/pt-test/analytics";
const SRC = path.join(ROOT, ".request.log");
const OUT_JSON = path.join(ROOT, ".request.human.log");   // JSON 版：原样保留 + 增加 time_human
const OUT_TXT  = path.join(ROOT, ".request.readable.log"); // 纯文本版：一眼能看懂

// 北京时间(UTC+8) 格式化，带毫秒：2026-09-23 11:24:21.766
const fmt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  fractionalSecondDigits: 3, hour12: false,
});
const human = (ts) => fmt.format(new Date(ts)).replace(/\//g, "-");

if (!fs.existsSync(SRC)) {
  console.error("源文件不存在: " + SRC);
  process.exit(1);
}

const lines = fs.readFileSync(SRC, "utf8").split("\n").filter(Boolean);
const jsonOut = [];
const txtOut = [];

for (const raw of lines) {
  let o = null;
  try { o = JSON.parse(raw); } catch { jsonOut.push(raw); txtOut.push(raw); continue; }

  // JSON 版：保留原对象，增加可读时间
  if (typeof o.time === "number") {
    o.time_human = human(o.time) + " (UTC+8)";
  }
  jsonOut.push(JSON.stringify(o));

  // 纯文本版：尽量渲染成人类友好的一行
  let s = "";
  if (typeof o.time === "number") s += human(o.time);
  if (o.req && o.req.method) s += "  " + String(o.req.method).padEnd(4) + " " + (o.req.ip ? o.req.ip + " " : "") + o.req.url;
  if (o.res && typeof o.res.statusCode === "number") s += "  -> " + o.res.statusCode;
  if (typeof o.responseTime === "number") s += "  " + o.responseTime.toFixed(2) + "ms";
  if (o.event_id) s += "  event=" + o.event_id;
  if (o.webhook_id) s += "  wh=" + o.webhook_id;
  if (o.tenant_id) s += "  tenant=" + o.tenant_id;
  if (o.ip && !(o.req && o.req.ip)) s += "  ip=" + o.ip;
  if (o.msg) s += "  " + o.msg;
  txtOut.push(s);
}

fs.writeFileSync(OUT_JSON, jsonOut.join("\n") + "\n", "utf8");
fs.writeFileSync(OUT_TXT, txtOut.join("\n") + "\n", "utf8");

console.log("源行数:", lines.length);
console.log("已生成:", path.basename(OUT_JSON));
console.log("已生成:", path.basename(OUT_TXT));
console.log("示例首行:", txtOut[0]);
