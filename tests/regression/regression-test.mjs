/**
 * Slice 0 回归测试：mock DSH runner 协议 + 关键纯函数不变量。
 * 运行： node scripts/regression/regression-test.mjs
 * 说明：
 *  - 单元层：把 server-v5.cjs 里「不可导出的内联函数」按同一逻辑重表达，锁定其不变量。
 *  - 集成层：spawn mock-dsh-runner，验证 stdout 协议（ready/delta/step/done/pong/aborted/bye）。
 *  - 冒烟层：见 SMOKE.md（需真 PT key + 真 DSH + 浏览器，无法自动）。
 * 局限：tenant.cjs / server.cjs 目前是单体、函数未导出，无法直接 import 单测——
 *       这正是 Slice 1(Storage Contract)/2(DSH Adapter) 抽取要解决的接缝问题。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mock = path.join(__dirname, "mock-dsh-runner.mjs");

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
}

console.log("【单元】图片魔数校验不变量（server-v5.cjs P1-2 同逻辑）");
function magicType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && buf.slice(0, 6).toString("ascii").startsWith("GIF8")) return "gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}
assert("PNG 识别", magicType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === "png");
assert("JPEG 识别", magicType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])) === "jpg");
assert("GIF 识别", magicType(Buffer.from("GIF89a", "ascii")) === "gif");
assert("WEBP 识别", magicType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])) === "webp");
assert("文本伪图片拒绝", magicType(Buffer.from("hello world", "utf8")) === null);

console.log("\n【单元】上传静态服务路径穿越防护不变量（server-v5.cjs 556-561 行实际逻辑）");
// 真正的安全边界是内联 serve 逻辑：拆两段 + 段数校验 + 文件名禁用 ../反斜杠 + 租户匹配。
// 注意：uploadsAbsPath() 那个正则只用于拼 prompt 文本（imageNote），不是文件读取边界，勿拿它当安全校验。
function serveUploadsSafe(relPath, tenantId) {
  const parts = relPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;         // 必须恰好两段
  const t = parts[0], fname = parts[1];
  if (fname.indexOf("..") >= 0 || fname.indexOf("\\") >= 0) return false; // 文件名禁穿越
  return t === tenantId;                                                   // 租户必须匹配登录用户
}
assert("合法两段 + 租户匹配 → 放行", serveUploadsSafe("abc123/file.png", "abc123") === true);
assert("3 段 ../ 穿越 → 拒绝", serveUploadsSafe("a/../b", "a") === false);
assert("tenantId 为 .. → 租户不匹配 → 拒绝", serveUploadsSafe("../secret.png", "abc123") === false);
assert("文件名含 .. → 拒绝", serveUploadsSafe("abc123/..", "abc123") === false);
assert("文件名含反斜杠 → 拒绝", serveUploadsSafe("abc123/a\\b", "abc123") === false);
assert("空段 → 拒绝", serveUploadsSafe("//file.png", "abc123") === false);

console.log("\n【集成】mock DSH runner stdout 协议");
function runMock(mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mock, "--profile", "headless"], {
      env: { ...process.env, MOCK_MODE: mode },
    });
    let out = "";
    const frames = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const l = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (l) { try { frames.push(JSON.parse(l)); } catch (e) {} }
      }
    });
    child.on("exit", () => resolve(frames));
    child.stdin.write('{"type":"task","sessionId":"s1","task":"hi","model":"m"}\n');
    child.stdin.write('{"type":"ping"}\n');
    child.stdin.write('{"type":"abort","sessionId":"s1"}\n');
    child.stdin.write('{"type":"exit"}\n');
    child.stdin.end();
  });
}

const frames = await runMock("ok");
const types = frames.map((f) => f.type);
assert("启动先发 ready", types[0] === "ready");
assert("task 吐 delta", types.includes("delta"));
assert("task 吐 step", types.includes("step"));
assert("task 以 done 收尾", types.includes("done"));
assert("ping 回 pong", types.includes("pong"));
assert("abort 回 aborted", types.includes("aborted"));
assert("exit 回 bye", types.includes("bye"));
const doneFrame = frames.find((f) => f.type === "done");
assert("done 帧带 sessionId + text", doneFrame && doneFrame.sessionId === "s1" && doneFrame.text === "这是一条回复");

const errFrames = await runMock("error");
assert("error 模式 done.ok=false 且带 error", errFrames.some((f) => f.type === "done" && f.ok === false && f.error));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
