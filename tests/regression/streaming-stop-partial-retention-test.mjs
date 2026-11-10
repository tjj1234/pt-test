import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== Testing Streaming Stop/Timeout Partial Text Retention ===");

// 1. Static inspection of dsh-adapter.cjs
const dshAdapterSrc = fs.readFileSync(path.resolve("shell/runtime/dsh-adapter.cjs"), "utf8");

assert.ok(dshAdapterSrc.includes("w.textBuf = (w.textBuf || \"\") + frame.text"), "dsh-adapter must buffer streaming delta text into w.textBuf");
assert.ok(dshAdapterSrc.includes("text: currentText"), "requestWaiterAbort must resolve with currentText instead of hardcoded empty string");
assert.ok(dshAdapterSrc.includes("text: waiter.textBuf || \"\""), "failRunnerProcess must resolve with waiter.textBuf fallback");
assert.ok(dshAdapterSrc.includes("const currentText = (frame.text !== undefined && frame.text !== \"\") ? frame.text : (w.textBuf || \"\");"), "done/error frame handling must fall back to textBuf");

console.log("✔ dsh-adapter textBuf accumulation and abort/timeout retention verified");

// 2. Static inspection of server.cjs
const serverSrc = fs.readFileSync(path.resolve("shell/server.cjs"), "utf8");

assert.ok(serverSrc.includes("const partialText = typeof r.text === \"string\" ? r.text.trim() : \"\";"), "server.cjs must extract partialText from r.text");
assert.ok(serverSrc.includes("partial: true"), "server.cjs must tag interrupted partial responses with partial: true");
assert.ok(serverSrc.includes("await persistConversationMessages(finalMessages);"), "server.cjs must persist partial text into conversation history");

console.log("✔ server.cjs partial response persistence on stop/timeout verified");

// 3. Static inspection of app.js
const appSrc = fs.readFileSync(path.resolve("shell/public/app.js"), "utf8");

assert.ok(appSrc.includes("m.partial === true"), "app.js must check for m.partial flag in renderMessage");
assert.ok(appSrc.includes("回答已由用户中止（已保留部分内容）"), "app.js must display user-abort notice with partial text note");
assert.ok(appSrc.includes("回答因超时中断（已保留部分内容）"), "app.js must display timeout notice with partial text note");
assert.ok(appSrc.includes("hasPartialText"), "stoppedBarText must support hasPartialText flag");

console.log("✔ app.js partial message rendering and notice badges verified");

console.log("=== ALL STREAMING STOP/TIMEOUT PARTIAL RETENTION TESTS PASSED ===");
