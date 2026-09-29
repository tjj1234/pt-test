"use strict";
/**
 * runtime/contract.cjs —— Runtime Contract（Slice 2 · DSH Adapter）
 * ============================================================================
 * 目标：把「平台对话运行时」抽象成统一接口，隔离 DSH 具体实现，使业务壳只依赖契约。
 *
 * 实现者（二者实现同一契约，可互换）：
 *   · dsh-adapter.cjs   —— 真实 DSH（每租户常驻进程 + stdin/stdout JSON-lines 协议）
 *   · mock-adapter.cjs  —— 内存确定性 mock（测试/回归，无 DSH、无 LLM）
 *
 * Runtime 实例方法（assertRuntime 校验）：
 *   run(spec)            → Promise<RunResult>  发起一轮对话（冷/热启动由实现决定）
 *   abort(sessionKey)                            立即取消当前轮（agent.cancel）
 *   closeSession(sessionKey)                     丢弃该会话轨迹（分岔/重新生成/删对话）
 *   close()                                      关闭整个 runtime（回收所有进程）
 *
 * spec 形状（任务「部件」交给 runtime，由 runtime 依据冷/热启动自行组装：
 *          冷启动注入 history，热启动由 runtime 内 session 持有轨迹、不再注入 history）：
 *   {
 *     sessionKey: string,    // 会话标识（DSH 内映射为 session-<key>；= 业务 conversationId）
 *     tenantId: string,      // 租户（进程复用 key）
 *     model: string,         // 模型 id
 *     apiKey: string,        // PT key（仅注入 env，不落盘）
 *     workspace: string,     // 租户 workspace cwd
 *     persona: string,       // 人设（可空）
 *     memory: string,        // 长期记忆（可空）
 *     imageNote: string,     // 图片说明（可空）
 *     history: string,       // 截断历史（仅冷启动注入）
 *     question: string,      // 当前问题（必填）
 *     onDelta: (text)=>void, // 逐字增量回调
 *     onStep:  (step)=>void, // 工具轨迹回调
 *     onSpawn: (job)=>void,  // 返回 { abort(), kill() } 停止句柄
 *     timeoutMs: number,     // 超时（可选）
 *   }
 *
 * RunResult 形状（normalizeRunResult 归一）：
 *   { ok, text, ms, error, stopped, steps, fresh, code }
 *
 * 契约语义（务必保持，否则破坏现有 SSE/停止/分岔行为）：
 *   1. 多轮对话：同一 sessionKey 复用同一会话（DSH session 持久 = 轨迹可见）。
 *   2. delta / step / done：逐字流式 + 工具轨迹 + 结束帧，顺序与现有 SSE 完全一致。
 *   3. abort/stop：abort() 立即取消当前轮；run() 最终以 stopped=true 或 ok=false 收尾。
 *   4. 分岔 / 重新生成：closeSession() 后下次 run 冷启动（只重放截断历史）。
 *   5. 错误：run() 返回 ok=false + error；进程退出时未决 waiter 以失败收尾（不悬挂）。
 *   6. 进程复用：同一租户复用常驻进程；空闲超时回收。
 * ============================================================================
 */

/** 契约允许的事件类型。 */
const RUNTIME_EVENT_TYPES = ["delta", "step", "done", "error", "aborted"];

/** run() 返回结果的规范键。 */
const RUN_RESULT_KEYS = ["ok", "text", "ms", "error", "stopped", "steps", "fresh", "code"];

/** Runtime 实例必须实现的方法。 */
const RUNTIME_METHODS = ["run", "abort", "closeSession", "close"];

/**
 * 校验 runtime 实例是否满足契约。
 * @returns {Array<string>} 缺失项列表（空数组 = 通过）。
 */
function validateRuntime(rt) {
  if (!rt || typeof rt !== "object") return ["runtime 不是对象"];
  const missing = [];
  for (const m of RUNTIME_METHODS) {
    if (typeof rt[m] !== "function") missing.push("缺方法: " + m);
  }
  return missing;
}

/**
 * 断言 runtime 满足契约；不满足则抛错。
 * @returns {object} 原样返回 rt，便于链式。
 */
function assertRuntime(rt, label) {
  const missing = validateRuntime(rt);
  if (missing.length) {
    throw new Error("Runtime Contract 校验失败" + (label ? "（" + label + "）" : "") + ": " + missing.join("; "));
  }
  return rt;
}

/** 归一化 delta 事件（onDelta 回调）。 */
function normalizeDelta(text) {
  return String(text == null ? "" : text);
}

/** 归一化 step 事件（onStep 回调）。 */
function normalizeStep(step) {
  if (!step || typeof step !== "object") step = {};
  const out = { name: String(step.name || "tool") };
  if (step.args != null) out.args = String(step.args);
  if (step.result != null) out.result = String(step.result);
  if (step.isError === true) out.isError = true;
  return out;
}

/** 归一化 run() 返回结果，保证业务壳可安全读取。 */
function normalizeRunResult(r) {
  if (!r || typeof r !== "object") r = {};
  return {
    ok: r.ok !== false,
    text: String(r.text == null ? "" : r.text),
    ms: Number(r.ms) || 0,
    error: r.error != null ? String(r.error) : null,
    stopped: r.stopped === true || r.canceled === true,
    steps: Array.isArray(r.steps) ? r.steps : [],
    fresh: r.fresh === true,
    code: r.code != null ? String(r.code) : null,
  };
}

module.exports = {
  RUNTIME_EVENT_TYPES,
  RUN_RESULT_KEYS,
  RUNTIME_METHODS,
  validateRuntime,
  assertRuntime,
  normalizeDelta,
  normalizeStep,
  normalizeRunResult,
};
