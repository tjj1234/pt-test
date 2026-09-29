"use strict";
/**
 * runtime/mock-adapter.cjs —— 内存确定性 mock（实现 Runtime Contract）
 * ============================================================================
 * 无 DSH、无 LLM：按脚本吐 delta/step/done 帧，用于测试/回归（确定性、可离线）。
 *
 * 行为由 opts 控制：
 *   opts.mode     ：'ok'(默认) | 'error' | 'empty' | 'timeout'
 *   opts.script   ：(sessionKey)=>frames[] 自定义剧本（优先级高于 mode）
 *   opts.tickDelayMs ：每帧之间的异步让步毫秒数（默认 1，允许 abort() 中途生效）
 *
 * 与真实 DSH Adapter 的关键对齐点（可互换）：
 *   · onSpawn 在任务发送【之前】回调（停止句柄先注册，才能中止正在跑的一轮）
 *   · abort() 立即置 stopped，run() 最终以 stopped=true 收尾且不再吐后续帧
 *   · closeSession() 丢弃会话轨迹（下次 run 冷启动 fresh=true）
 *   · timeout 模式不吐 done（测超时路径）
 * ============================================================================
 */
const { normalizeDelta, normalizeStep, normalizeRunResult } = require("./contract.cjs");

/** 内置剧本（与 tests/regression/mock-dsh-runner.mjs 的 stdout 协议对齐）。 */
const DEFAULT_SCRIPT = {
  ok: [
    { type: "delta", text: "这是" },
    { type: "delta", text: "一条" },
    { type: "step", name: "attribution.query", args: '{"platform":"meta"}' },
    { type: "step", name: "attribution.query", result: '{"visits":960}', isError: false },
    { type: "delta", text: "回复" },
    { type: "done", ok: true, text: "这是一条回复", reason: "completed" },
  ],
  error: [{ type: "done", ok: false, error: "模拟模型调用失败" }],
  empty: [{ type: "done", ok: true, text: "" }],
  timeout: [], // 不吐 done，模拟卡死
};

function createMockRuntime(opts = {}) {
  const mode = opts.mode || "ok";
  const tickDelayMs = typeof opts.tickDelayMs === "number" ? opts.tickDelayMs : 1;
  const scriptFor = typeof opts.script === "function" ? opts.script : () => (DEFAULT_SCRIPT[mode] || DEFAULT_SCRIPT.ok);

  const sessions = new Map(); // sessionKey -> { seen:boolean }
  const jobs = new Map();     // sessionKey -> job

  async function run(spec) {
    const sid = String((spec && spec.sessionKey) || "");
    const t0 = Date.now();
    const steps = [];
    let text = "";
    let done = null;

    const rec = sessions.get(sid) || { seen: false };
    const fresh = !rec.seen;

    // 先注册停止句柄 + onSpawn（与真实 tenant 一致：先于任务发送）
    const job = {
      stopped: false,
      abort() { this.stopped = true; },
      kill() { this.abort(); },
    };
    jobs.set(sid, job);
    if (typeof spec.onSpawn === "function") { try { spec.onSpawn(job); } catch (e) {} }

    const frames = Array.isArray(scriptFor(sid)) ? scriptFor(sid) : [];
    for (const frame of frames) {
      if (job.stopped) break; // 停止后不再吐后续帧
      if (frame.type === "delta") {
        const d = normalizeDelta(frame.text);
        text += d;
        if (typeof spec.onDelta === "function") { try { spec.onDelta(d); } catch (e) {} }
      } else if (frame.type === "step") {
        const s = normalizeStep(frame);
        steps.push(s);
        if (typeof spec.onStep === "function") { try { spec.onStep(s); } catch (e) {} }
      } else if (frame.type === "done") {
        done = frame;
      }
      if (tickDelayMs > 0 && !job.stopped) await new Promise((r) => setTimeout(r, tickDelayMs));
    }

    rec.seen = true;
    sessions.set(sid, rec);

    if (job.stopped) {
      return normalizeRunResult({ ok: false, text: "", ms: Date.now() - t0, error: "已停止", stopped: true, steps, fresh });
    }
    if (!done) {
      // timeout 模式：没收到 done，按超时收尾
      return normalizeRunResult({ ok: false, text, ms: Date.now() - t0, error: "mock 超时", stopped: false, steps, fresh, code: "TIMEOUT" });
    }
    const ok = done.ok !== false;
    // 最终文本以 done.text 为准（对齐真实 DSH：done.text 是 summarize 的全量回复）；
    // done.text 为空时回退到 delta 累积文本。
    const finalText = ok ? (done.text != null && done.text !== "" ? String(done.text) : text) : "";
    return normalizeRunResult({
      ok, text: finalText, ms: Date.now() - t0,
      error: done.error || null, stopped: false, steps, fresh,
    });
  }

  function abort(sessionKey) {
    const sid = String(sessionKey || "");
    const job = jobs.get(sid);
    if (job) job.abort();
  }

  function closeSession(sessionKey) {
    const sid = String(sessionKey || "");
    sessions.delete(sid);
    jobs.delete(sid);
  }

  function close() {
    sessions.clear();
    jobs.clear();
  }

  return { run, abort, closeSession, close };
}

module.exports = { createMockRuntime, DEFAULT_SCRIPT };
