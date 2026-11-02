/**
 * DSH 原生长上下文与预算门禁候选模块 (Context Gate Candidate)
 *
 * 核心设计目标：
 * 1. 封闭 DSH 原生 Compaction / Summary 模型调用绕过宿主 Run 预算的重大隐患。
 *    在 DSH 架构中，`BasicCompactionEngine` 触发的摘要调用不经过 `agent/request`，
 *    而是直接调用 `ctx.llm.stream()`（携带 `purpose: "compaction"`）。
 *    本网关在 `llm/stream` 处挂载前置门禁，在实际网络 I/O 发起前执行严格的预算准入许可。
 * 2. 支持对四项原生上下文插件（compaction-basic, command-compact, tool-result-pruner, repeat-tool-reminder）
 *    的可观测性度量、生命周期事件监听（compaction/start, compaction/summary, compaction/end）与事件留存。
 * 3. 严格的多租户 / 多会话隔离：
 *    - 每一个辅助/压缩调用必须归属于有效的活跃 Run / Session；
 *    - 未绑定可信活动 Run 时，默认拒绝（Fail-Closed）；
 *    - 预算拒绝时（如超出 maxModelCalls、maxCost 或已超时），抛出规范化的预算拒绝错误，
 *      本地 HTTP/网络请求计数保持为 0，且不执行后续隐式重试。
 * 4. 纯净设计：不持有凭据，不修改环境变量，不篡改原生审计日志或历史证据。
 */

function gateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 校验门禁配置选项
 * @param {object} opts
 */
function validateGateOptions(opts) {
  if (!opts || typeof opts !== "object") {
    throw gateError("INVALID_GATE_OPTIONS", "Gate options must be a non-null object");
  }
  if (typeof opts.getActiveTurn !== "function") {
    throw gateError("INVALID_GATE_OPTIONS", "getActiveTurn function must be provided");
  }
}

/**
 * 挂载 DSH 原生长上下文与预算门禁
 * 
 * @param {object} ctx - Cordis 上下文 (通常为根 Context 或 Agent 运行时的注入点)
 * @param {object} options
 * @param {(sessionId: string, purpose?: string) => object | null} options.getActiveTurn
 *        返回当前活动 turn 的描述：{ sessionId, tenantId, runId, budget: { admit(op): { allowed, code, settle() } }, recordEvent(evt) }
 * @param {(event: object) => void} [options.onCompactionEvent] - 可选的外部压缩事件观测回调
 * @returns {() => void} 销毁门禁监听器的 disposer
 */
export function installNativeContextGate(ctx, options) {
  validateGateOptions(options);

  const disposers = [];

  // 1. 拦截 llm/stream：拦截所有通过 ctx.llm.stream() 发起的模型调用（尤其是 purpose: "compaction" 的辅助摘要调用）
  const disposeLlmStream = ctx.on("llm/stream", async (streamOptions, next) => {
    const purpose = streamOptions?.purpose || "chat";
    const sessionId = streamOptions?.sessionId ? String(streamOptions.sessionId) : null;

    // 获取当前请求归属的活跃 Run / Turn
    const activeTurn = options.getActiveTurn(sessionId, purpose);

    // 安全边界 1：任何模型调用必须归属于有效的、处于活动状态的 Run。若未绑定或未配置预算，Fail-Closed
    if (!activeTurn) {
      throw gateError(
        "RUN_NOT_BOUND",
        `Model call with purpose "${purpose}" rejected: no active Run bound for session "${sessionId || "unknown"}"`
      );
    }

    const { budget, tenantId, runId } = activeTurn;
    if (!budget || typeof budget.admit !== "function") {
      throw gateError(
        "RUN_BUDGET_CONFIG_INVALID",
        `Active Run for session "${sessionId}" has invalid or missing budget`
      );
    }

    // 安全边界 2：在网络前执行预算许可检查
    // 对于 compaction 调用，请求类型归类为 "model"（计入模型总调用与用量预算）
    const admission = budget.admit({
      type: "model",
      purpose,
      model: streamOptions.model,
      provider: streamOptions.provider,
    });

    if (!admission.allowed) {
      throw gateError(
        admission.code || "RUN_MODEL_CALL_LIMIT",
        `Model request for purpose "${purpose}" was denied by configured budget`
      );
    }

    // 记录观测日志
    if (typeof activeTurn.recordEvent === "function") {
      activeTurn.recordEvent({
        type: "model_request_admitted",
        purpose,
        sessionId,
        tenantId,
        runId,
        provider: streamOptions.provider,
        model: streamOptions.model,
        timestamp: Date.now(),
      });
    }

    try {
      const resultStream = await next();
      admission.settle?.();
      return resultStream;
    } catch (err) {
      admission.settle?.();
      throw err;
    }
  }, { prepend: true }); // prepend: true 确保在任何其他适配器分派前优先准入拦截

  disposers.push(disposeLlmStream);

  // 2. 挂载压缩事件审计观察者（若存在 compaction 相关事件）
  const compactionEvents = [
    "compaction/start",
    "compaction/summary",
    "compaction/end",
    "compaction/prune",
  ];

  for (const eventName of compactionEvents) {
    try {
      const disposeEvent = ctx.on(eventName, (payload) => {
        if (typeof options.onCompactionEvent === "function") {
          try {
            options.onCompactionEvent({
              event: eventName,
              payload,
              timestamp: Date.now(),
            });
          } catch {}
        }
      });
      disposers.push(disposeEvent);
    } catch {}
  }

  return () => {
    for (const d of disposers) {
      try { d(); } catch {}
    }
  };
}
