/**
 * runtime-contract-test.mjs —— Runtime Contract + Mock Adapter 回归（Slice 2）
 * ============================================================================
 * 验证：
 *   1. contract.cjs：validateRuntime / assertRuntime / normalizeRunResult / normalizeStep
 *   2. mock-adapter.cjs：ok / error / empty / timeout 四种模式 + delta/step 回调
 *   3. 冷/热会话（fresh）、abort（中途停止 → stopped=true）、closeSession（重置 fresh）
 *   4. 真实 DSH Adapter 与 Mock 满足同一契约（可互换）
 * 无 DSH、无 LLM、无网络。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { validateRuntime, assertRuntime, normalizeRunResult, normalizeStep, normalizeDelta, RUNTIME_METHODS } = require("../../shell/runtime/contract.cjs");
const { createMockRuntime } = require("../../shell/runtime/mock-adapter.cjs");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 1. Runtime Contract 校验 =====
ok("validateRuntime: 空对象报缺 4 方法", JSON.stringify(validateRuntime({})) === JSON.stringify(["缺方法: run", "缺方法: abort", "缺方法: closeSession", "缺方法: close"]));
ok("validateRuntime: 完整对象通过", validateRuntime({ run() {}, abort() {}, closeSession() {}, close() {} }).length === 0);
let threw = false;
try { assertRuntime({ run() {} }, "x"); } catch (e) { threw = true; }
ok("assertRuntime: 缺方法抛错", threw === true);
ok("assertRuntime: 通过则原样返回", assertRuntime({ run() {}, abort() {}, closeSession() {}, close() {} }) !== null);
ok("RUNTIME_METHODS = 4 个", RUNTIME_METHODS.length === 4);

// ===== 2. normalize 归一化 =====
ok("normalizeRunResult: 补默认值", normalizeRunResult({}).ok === true && normalizeRunResult({}).text === "" && normalizeRunResult({}).steps.length === 0 && normalizeRunResult({}).code === null);
ok("normalizeRunResult: stopped 归一", normalizeRunResult({ stopped: true }).stopped === true && normalizeRunResult({ canceled: true }).stopped === true);
ok("normalizeStep: 补 name", normalizeStep({}).name === "tool" && normalizeStep({ name: "x", isError: true }).isError === true);
ok("normalizeDelta: 转字符串", normalizeDelta(123) === "123" && normalizeDelta(null) === "");

// ===== 3. mock ok 模式（默认）=====
const rt = createMockRuntime();
let deltas = [], steps = [];
const r1 = await rt.run({ sessionKey: "s1", question: "你好", onDelta: (d) => deltas.push(d), onStep: (s) => steps.push(s) });
ok("mock ok: 返回 ok=true", r1.ok === true);
ok("mock ok: 文本正确", r1.text === "这是一条回复");
ok("mock ok: delta 逐字回调", deltas.length === 3 && deltas.join("") === "这是一条回复");
ok("mock ok: step 轨迹回调", steps.length === 2 && steps[0].name === "attribution.query" && steps[1].result === '{"visits":960}');
ok("mock ok: 首次 fresh=true", r1.fresh === true);

// ===== 4. 热会话：同 sessionKey 复用 =====
const r2 = await rt.run({ sessionKey: "s1", question: "再问" });
ok("mock: 同 sessionKey 复用 fresh=false", r2.fresh === false);

// ===== 5. error / empty / timeout 模式 =====
const re = await createMockRuntime({ mode: "error" }).run({ sessionKey: "e1", question: "x" });
ok("mock error: ok=false + error", re.ok === false && re.error === "模拟模型调用失败");
const rempty = await createMockRuntime({ mode: "empty" }).run({ sessionKey: "e2", question: "x" });
ok("mock empty: ok=true + 空文本", rempty.ok === true && rempty.text === "");
const rtimeout = await createMockRuntime({ mode: "timeout" }).run({ sessionKey: "t1", question: "x" });
ok("mock timeout: code=TIMEOUT", rtimeout.ok === false && rtimeout.code === "TIMEOUT");

// ===== 6. abort 中途停止 → stopped=true =====
const rtabort = createMockRuntime({ mode: "ok", tickDelayMs: 2 });
let jobRef = null;
const pAbort = rtabort.run({ sessionKey: "a1", question: "x", onSpawn: (j) => { jobRef = j; } });
ok("mock: onSpawn 先于任务回调（拿到停止句柄）", !!jobRef);
await sleep(5); // 让 run 先吐几帧
if (jobRef) jobRef.abort();
const ra = await pAbort;
ok("mock: 中途 abort → stopped=true", ra.stopped === true);

// runtime.abort(sessionKey) 等价路径
const rtabort2 = createMockRuntime({ mode: "ok", tickDelayMs: 2 });
const pAbort2 = rtabort2.run({ sessionKey: "a2", question: "x" });
await sleep(5);
rtabort2.abort("a2");
const ra2 = await pAbort2;
ok("mock: runtime.abort(sessionKey) → stopped=true", ra2.stopped === true);

// ===== 7. closeSession 重置会话（下次 fresh）=====
const rtcs = createMockRuntime();
await rtcs.run({ sessionKey: "c1", question: "x" });
rtcs.closeSession("c1");
const rc = await rtcs.run({ sessionKey: "c1", question: "y" });
ok("mock: closeSession 后 fresh=true（冷启动）", rc.fresh === true);

// ===== 8. 自定义 script =====
const rtcust = createMockRuntime({ script: () => [{ type: "done", ok: true, text: "自定义" }] });
ok("mock: 自定义 script", (await rtcust.run({ sessionKey: "k1", question: "x" })).text === "自定义");

// ===== 9. Mock 与真实 DSH Adapter 满足同一契约（可互换）=====
const { createDshRuntime } = require("../../shell/runtime/dsh-adapter.cjs");
const dshShape = { run() {}, abort() {}, closeSession() {}, close() {} };
const dshEmpty = createDshRuntime({ dshHome: "/nonexistent", settingsTemplate: "/nonexistent", persistentRunner: "/nonexistent", tmpDir: "/nonexistent" });
ok("mock 满足契约", validateRuntime(createMockRuntime()).length === 0);
ok("真实 DSH Adapter 满足同一契约（方法齐全）", validateRuntime(dshEmpty).length === 0);
ok("两个 adapter 方法集一致（可互换）", JSON.stringify(RUNTIME_METHODS.map((m) => typeof dshEmpty[m])) === JSON.stringify(RUNTIME_METHODS.map((m) => typeof dshShape[m])));

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
