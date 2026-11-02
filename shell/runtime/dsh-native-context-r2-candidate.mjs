/**
 * DSH 原生长上下文与组合预算门禁候选 R2 (Context Gate R2 Candidate)
 *
 * 核心升级与约束（R2）：
 * 1. 预算只计一次（No Double-Counting）：
 *    - 当前 Runner 在 `agent/request` 已经对普通对话请求（chat）执行了 `budget.admit({ type: "model" })`；
 *    - 辅助压缩/摘要调用（`purpose: "compaction"`）直接调用 `ctx.llm.stream()`，完全绕开了 `agent/request`；
 *    - 本门禁在 `llm/stream` 处前置拦截：
 *      · 仅对 `purpose === "compaction"`（或非常规对话的辅助模型请求）执行 `budget.admit({ type: "model" })`；
 *      · 普通对话请求在 `agent/request` 处计数，在 `llm/stream` 处透传（或标记为已准入），彻底杜绝重复扣减！
 * 2. 真实异步流的生命周期与精确 settle（Precise Settle on Stream Completion）：
 *    - 包装返回的 `AsyncIterable<StreamChunk>`；
 *    - 仅在流完全消费结束（正常迭代完毕、抛出异常或被 abort）时才执行 `admission.settle(...)`；
 *    - 彻底纠正 R1 中“流刚创建就立即 settle”的语义偏差。
 * 3. 严格会话归属与防猜机制（Fail-Closed on Unbound Run）：
 *    - 从 `options.sessionId` 获取会话 ID，并向可信宿主查询活动 Run；
 *    - 严禁猜测全局唯一活动会话，严禁跨会话共享上下文；
 *    - 缺可信活动 Run 或预算未配置时，一律在网络前阻断（Fail-Closed）；
 * 4. 真实多会话隔离：
 *    - 两个并发会话的预算、状态与事件独立记录，无任何串扰；
 *    - 预算耗尽时本地 HTTP 请求严格保持为 0，且不执行隐式重试。
 */

function gateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 校验安装选项
 */
function validateOptions(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    throw gateError("INVALID_GATE_OPTIONS", "Gate options must be a non-null object");
  }
  if (typeof opts.getActiveTurn !== "function") {
    throw gateError("INVALID_GATE_OPTIONS", "getActiveTurn must be a function");
  }
}

/**
 * 包装异步可迭代流，在流实际终止时触发 settle 回调
 * @param {AsyncIterable<any>} innerStream
 * @param {() => void} onSettle
 * @returns {AsyncIterable<any>}
 */
async function* wrapStreamWithSettle(innerStream, onSettle) {
  let settled = false;
  const doSettle = (err) => {
    if (!settled) {
      settled = true;
      try { onSettle(err); } catch {}
    }
  };

  try {
    for await (const chunk of innerStream) {
      yield chunk;
    }
    doSettle(null);
  } catch (err) {
    doSettle(err);
    throw err;
  } finally {
    doSettle(null);
  }
}

/**
 * 安装 DSH 原生上下文组合预算门禁 R2
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} options
 * @param {(sessionId: string, purpose: string) => object | null} options.getActiveTurn
 *        返回当前活动 turn: { sessionId, tenantId, runId, budget: { admit(op): { allowed, code, settle() } }, recordEvent(evt) }
 * @param {(evt: object) => void} [options.onCompactionEvent] - 压缩生命周期观测
 * @returns {() => void} 销毁监听器的 disposer
 */
export function installNativeContextGateR2(ctx, options) {
  validateOptions(options);

  const disposers = [];

  // 前置拦截 llm/stream
  const disposeLlmStream = ctx.on("llm/stream", async (streamOptions, next) => {
    const purpose = streamOptions?.purpose || "chat";
    const sessionId = streamOptions?.sessionId ? String(streamOptions.sessionId) : null;

    // 安全防线 1：普通 chat 请求已经由 persistent-runner 的 agent/request 准入并计入 budget。
    // 为了防止“预算重复扣减”，对于 chat 请求本网关直接透传给底层适配器！
    if (purpose === "chat") {
      return next();
    }

    // 安全防线 2：对于辅助模型调用（如 purpose: "compaction"），必须进行可信归属检查
    if (!sessionId) {
      throw gateError(
        "RUN_NOT_BOUND",
        `Auxiliary model call with purpose "${purpose}" rejected: no sessionId present on request`
      );
    }

    const activeTurn = options.getActiveTurn(sessionId, purpose);
    if (!activeTurn) {
      throw gateError(
        "RUN_NOT_BOUND",
        `Auxiliary model call with purpose "${purpose}" rejected: no active Run bound for session "${sessionId}"`
      );
    }

    const { budget, tenantId, runId } = activeTurn;
    if (!budget || typeof budget.admit !== "function") {
      throw gateError(
        "RUN_BUDGET_CONFIG_INVALID",
        `Active Run for session "${sessionId}" has invalid budget`
      );
    }

    // 安全防线 3：在网络前执行预算许可
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

    // 记录预算准入观测事件
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
      // 获取底层流
      const rawStream = await next();

      // 安全防线 4：精确在流消费完成/终止时执行 settle，不能在流返回时提前 settle
      return wrapStreamWithSettle(rawStream, (err) => {
        try {
          admission.settle?.({ error: err || undefined });
        } catch {}
      });
    } catch (err) {
      try { admission.settle?.({ error: err }); } catch {}
      throw err;
    }
  }, { prepend: true });

  disposers.push(disposeLlmStream);

  // 监听原生压缩审计事件
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
