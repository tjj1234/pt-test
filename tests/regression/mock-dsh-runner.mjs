/**
 * mock-dsh-runner —— 模拟 DSH 常驻 runner 的 stdout 协议。
 * 用途：Slice 0 回归基线。让 SSE 协议 / 停止 / 错误 / 超时路径在「无 DSH、无 LLM」下确定性可测。
 * 协议与 conv/persistent-runner.mjs 完全对齐：
 *   stdin  命令： {"type":"task"|"close"|"ping"|"exit"|"abort", ...}
 *   stdout 事件： ready / delta / step / done / aborted / closed / pong / bye / error
 * 用法： node mock-dsh-runner.mjs --profile headless
 *       环境变量 MOCK_MODE 控制行为： ok(默认) | error | empty | timeout
 *       注意：timeout 模式不吐 done（用于测 tenant 侧超时保护）。
 */
import { writeSync } from "node:fs";

function emit(obj) {
  try { writeSync(1, JSON.stringify(obj) + "\n"); } catch (e) { /* stdout 已关 */ }
}

const MODE = process.env.MOCK_MODE || "ok";

/** 每个 task 按剧本吐事件帧。 */
function scriptFor(mode, sid) {
  switch (mode) {
    case "error":
      return [{ type: "done", sessionId: sid, ok: false, error: "模拟模型调用失败", ms: 5 }];
    case "empty":
      return [{ type: "done", sessionId: sid, ok: true, text: "", reason: "completed", ms: 5 }];
    case "timeout":
      return []; // 不吐 done，模拟卡死
    default: // ok
      return [
        { type: "delta", sessionId: sid, text: "这是" },
        { type: "delta", sessionId: sid, text: "一条" },
        { type: "step", sessionId: sid, name: "attribution.query", args: '{"platform":"meta"}' },
        { type: "step", sessionId: sid, name: "attribution.query", result: '{"visits":960}', isError: false },
        { type: "delta", sessionId: sid, text: "回复" },
        { type: "done", sessionId: sid, ok: true, text: "这是一条回复", reason: "completed", ms: 12 },
      ];
  }
}

function handleLine(line) {
  let cmd;
  try { cmd = JSON.parse(line); } catch (e) { emit({ type: "error", message: "bad json" }); return; }
  switch (cmd.type) {
    case "task": {
      const sid = String(cmd.sessionId || "");
      for (const frame of scriptFor(MODE, sid)) emit(frame);
      return;
    }
    case "close": emit({ type: "closed", sessionId: String(cmd.sessionId || "") }); return;
    case "abort": emit({ type: "aborted", sessionId: String(cmd.sessionId || "") }); return;
    case "ping": emit({ type: "pong" }); return;
    case "exit": emit({ type: "bye" }); process.exit(0); return;
    default: emit({ type: "error", message: "unknown cmd: " + cmd.type }); return;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

emit({ type: "ready" });
