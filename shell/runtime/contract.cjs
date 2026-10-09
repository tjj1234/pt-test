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
 *     persona: string,       // 人设 = [基础] 段（可空，由 tenant 读 agent-persona.md）
 *     constraints: string[], // [约束] 段（可空，由 tenant 从业务线资产包只读公开导出读取）
 *     capabilities: object[],// [能力] 段（可空，如 [{ name, description }]，按当前用户授权过滤）
 *     memory: string,        // 长期记忆（可空）
 *     imageNote: string,     // 图片说明（可空）
 *     context: object,       // 当前上下文（可空，如 { panel, panelLabel }），由 runtime 拼进系统提示
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

/**
 * 把当前上下文（context）格式化成「上下文」段的行列表。
 * context 形状可扩展（当前仅支持面板），例如：
 *   { panel: "dash", panelLabel: "归因看板" }
 * 返回空数组表示无需注入。
 */
function contextLines(ctx) {
  if (!ctx || typeof ctx !== "object") return [];
  const lines = [];
  if (ctx.panel) {
    lines.push("用户当前所在 / 引用的数据面板：" + ctx.panel + (ctx.panelLabel ? "（" + ctx.panelLabel + "）" : ""));
    lines.push("当用户说「这个面板」「当前面板」「这里」等指代时，请理解为其指向上述数据面板，并优先调用该面板对应的数据工具（如归因查询 attribution.query）来回答。");
  }
  return lines;
}

/** 把当前上下文格式化成注入系统提示的段落（旧单段格式，保留兼容）。 */
function formatContext(ctx) {
  const lines = contextLines(ctx);
  return lines.length ? "【当前上下文】\n" + lines.join("\n") : "";
}

/** 把约束列表（string[]）格式化成「【约束】」段；空则返回空串。 */
function formatConstraints(constraints) {
  const items = (Array.isArray(constraints) ? constraints : [])
    .map((c) => String(c == null ? "" : c).trim())
    .filter(Boolean);
  return items.length ? "【约束】\n" + items.map((c) => "- " + c).join("\n") : "";
}

/** 把能力列表（[{ name, description }]）格式化成「【能力】」段；空则返回空串。 */
function formatCapabilities(capabilities) {
  const items = (Array.isArray(capabilities) ? capabilities : [])
    .map((t) => {
      if (!t || typeof t !== "object") return "";
      const name = String(t.name || "").trim();
      const desc = String(t.description || "").trim();
      return name ? (desc ? name + "：" + desc : name) : "";
    })
    .filter(Boolean);
  return items.length ? "【能力】\n" + items.map((c) => "- " + c).join("\n") : "";
}

/**
 * 系统提示四段式组装（M4）：
 *   【基础】 人设（agent-persona.md）
 *   【约束】 业务线资产包读出的工程铁律
 *   【上下文】 当前数据上下文（面板/引用）
 *   【能力】 当前用户已授权的工具清单 + 描述
 * 其后按顺序追加：长期记忆 / 图片说明 /（冷启动）截断历史 / 当前问题。
 * 返回组装好的完整任务文本；各段为空自动省略。
 */
function assembleSystemPrompt(spec = {}) {
  const parts = [];
  if (spec.persona) parts.push("【基础】\n" + String(spec.persona));
  const constraintText = formatConstraints(spec.constraints);
  if (constraintText) parts.push(constraintText);
  const ctxLines = contextLines(spec.context);
  if (ctxLines.length) parts.push("【上下文】\n" + ctxLines.join("\n"));
  const capabilityText = formatCapabilities(spec.capabilities);
  if (capabilityText) parts.push(capabilityText);
  if (spec.memory) parts.push("用户长期记忆：\n" + String(spec.memory));
  if (spec.imageNote) parts.push(String(spec.imageNote));
  if (spec.history) parts.push("以下是本次对话的历史（仅供理解上下文，不要复述）：\n" + String(spec.history));
  parts.push("用户现在问：" + String(spec.question || ""));
  return parts.join("\n\n");
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
  contextLines,
  formatContext,
  formatConstraints,
  formatCapabilities,
  assembleSystemPrompt,
};
