/**
 * DSH 原生长上下文与组合预算门禁候选 R3 (Context Gate R3 Candidate)
 *
 * 核心升级与约束（R3）：
 * 1. 一次性宿主准入凭证（One-Time Admission Credential）：
 *    - 普通对话请求（chat）不能仅凭 `purpose === "chat"` 自由放行；
 *    - 必须由宿主在 `agent/request` 预算准入时签发确切的一次性准入凭证（Ticket）；
 *    - 在 `llm/stream` 处严格消费一次，绑定确切 Run / 原生 sessionId / provider / model；
 *    - 无凭证、凭证重用、跨会话/模型篡改或超时均在网络前以 Fail-Closed 阻断，杜绝无预算透传；
 * 2. 真实原生归属复用与多会话隔离：
 *    - 严格复用原生 `compaction-basic` 传递的 `sessionId: agent.session.id` 与 `purpose: "compaction"`；
 *    - 严禁猜测全局唯一活动会话，未绑定活动 Run 的辅助调用立即阻断；
 *    - 两个并发重叠会话的凭证、预算、取消状态与事件独立隔离；
 * 3. 严格网络前阻断（Fail-Closed on Cancellation / Expiry / Exhaustion）：
 *    - 无论普通对话还是辅助压缩，凡 `cancelRequested === true`、`signal.aborted === true`、Run 已过期或预算耗尽，一律在网络前拒绝；
 *    - 流期间取消实时向底层流传播；
 * 4. 可 await 的宿主模型意图与审计接口：
 *    - 辅助摘要在发往网络前，必须先完成宿主模型意图持久化（`recordModelIntent`）；
 *    - 意图记录失败立即 settle 预算并终止，不得继续发往网络；
 * 5. 严格流生命周期与 settle 语义：
 *    - 包装返回流，保证在正常结束、抛出异常、消费者提前 break/return 或取消时精准 settle；
 *    - 杜绝隐式重试。
 */

function gateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 一次性准入凭证管理器
 */
export class ChatAdmissionTicketManager {
  constructor(defaultTtlMs = 60000) {
    this.defaultTtlMs = defaultTtlMs;
    this._tickets = new Map();
  }

  /**
   * 签发一次性准入凭证
   */
  issueTicket({ runId, sessionId, provider, model, ttlMs }) {
    if (!sessionId || typeof sessionId !== "string") {
      throw gateError("INVALID_TICKET_PARAMS", "sessionId must be a non-empty string");
    }
    const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : this.defaultTtlMs;

    this._tickets.set(ticketId, {
      ticketId,
      runId: runId ? String(runId) : undefined,
      sessionId: String(sessionId),
      provider: provider ? String(provider) : undefined,
      model: model ? String(model) : undefined,
      issuedAt: now,
      expiresAt: now + ttl,
      consumed: false,
    });

    return ticketId;
  }

  /**
   * 验证并消费一次性准入凭证（原子性一次性消费）
   */
  consumeTicket(ticketId, matchParams = {}) {
    if (!ticketId || typeof ticketId !== "string") {
      throw gateError("MISSING_ADMISSION_TICKET", "Chat request rejected: missing admission ticket");
    }

    const record = this._tickets.get(ticketId);
    if (!record) {
      throw gateError("INVALID_ADMISSION_TICKET", "Admission ticket not recognized or invalid");
    }

    if (record.consumed) {
      throw gateError("TICKET_ALREADY_CONSUMED", "Admission ticket has already been consumed (replay rejected)");
    }

    const now = Date.now();
    if (now > record.expiresAt) {
      this._tickets.delete(ticketId);
      throw gateError("EXPIRED_ADMISSION_TICKET", "Admission ticket has expired");
    }

    // 匹配性检查：绑定确切 Run / 原生 sessionId / provider / model
    if (matchParams.sessionId && record.sessionId !== String(matchParams.sessionId)) {
      throw gateError("TICKET_SESSION_MISMATCH", `Ticket bound to session "${record.sessionId}", got "${matchParams.sessionId}"`);
    }
    if (record.runId && matchParams.runId && record.runId !== String(matchParams.runId)) {
      throw gateError("TICKET_RUN_MISMATCH", `Ticket bound to run "${record.runId}", got "${matchParams.runId}"`);
    }
    if (record.provider && matchParams.provider && record.provider !== String(matchParams.provider)) {
      throw gateError("TICKET_PROVIDER_MISMATCH", `Ticket bound to provider "${record.provider}", got "${matchParams.provider}"`);
    }
    if (record.model && matchParams.model && record.model !== String(matchParams.model)) {
      throw gateError("TICKET_MODEL_MISMATCH", `Ticket bound to model "${record.model}", got "${matchParams.model}"`);
    }

    // 标记消费，防止重放 (保留记录或加入已消费集合)
    record.consumed = true;
    return record;
  }

  clear() {
    this._tickets.clear();
  }
}

/**
 * 包装异步可迭代流，在流实际终止时触发 settle 回调
 * 保证在消费完毕、抛错、或消费者提前 return 时均能执行 settle
 *
 * @param {AsyncIterable<any>} innerStream
 * @param {(err: Error | null) => void} onSettle
 * @returns {AsyncIterable<any>}
 */
export async function* wrapStreamWithSettle(innerStream, onSettle) {
  let settled = false;
  const doSettle = (err) => {
    if (!settled) {
      settled = true;
      try { onSettle(err); } catch {}
    }
  };

  try {
    const resolvedStream = innerStream != null && typeof innerStream.then === "function"
      ? await innerStream
      : innerStream;

    for await (const chunk of resolvedStream) {
      yield chunk;
    }
    doSettle(null);
  } catch (err) {
    doSettle(err);
    throw err;
  } finally {
    // 覆盖 consumer 提前 return (例如 break) 导致的流退出
    doSettle(null);
  }
}

/**
 * 校验安装配置
 */
function validateGateOptions(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    throw gateError("INVALID_GATE_OPTIONS", "Gate options must be a non-null object");
  }
  if (typeof opts.getActiveTurn !== "function") {
    throw gateError("INVALID_GATE_OPTIONS", "getActiveTurn must be a function");
  }
}

/**
 * 安装 DSH 原生上下文组合预算门禁 R3
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} options
 * @param {(sessionId: string, purpose: string) => object | null} options.getActiveTurn
 *        返回当前活动 turn: { sessionId, tenantId, runId, cancelRequested?: boolean, expired?: boolean, budget: { admit(op): { allowed, code, settle() } }, recordEvent(evt), recordModelIntent?(intent) }
 * @param {ChatAdmissionTicketManager} [options.ticketManager] - 可选的外部凭证管理器，未提供则内部初始化
 * @param {(intent: object) => Promise<void>} [options.recordModelIntent] - 可选的持久模型意图记录接口
 * @param {(evt: object) => void} [options.onCompactionEvent] - 压缩生命周期观测
 * @returns {{ dispose: () => void, ticketManager: ChatAdmissionTicketManager }}
 */
export function installNativeContextGateR3(ctx, options) {
  validateGateOptions(options);

  const ticketManager = options.ticketManager instanceof ChatAdmissionTicketManager
    ? options.ticketManager
    : new ChatAdmissionTicketManager();

  const disposers = [];

  // 前置拦截 llm/stream (保持同步派发以兼容 DSH 原生 llm.stream 返回 AsyncIterable 的契约)
  const disposeLlmStream = ctx.on("llm/stream", (streamOptions, next) => {
    const purpose = streamOptions?.purpose || "chat";
    const sessionId = streamOptions?.sessionId ? String(streamOptions.sessionId) : null;
    const signal = streamOptions?.signal;

    // --- 分支 1：普通对话请求 (purpose === "chat") ---
    if (purpose === "chat") {
      // 缺口 1 修复：普通 chat 绝不能按 purpose 直接放行！必须持有宿主签发的一次性凭证
      const ticketId = streamOptions?.admissionTicket;
      if (!ticketId) {
        throw gateError(
          "MISSING_ADMISSION_TICKET",
          "Plain chat request rejected: missing one-time host admission ticket"
        );
      }

      // 获取可能绑定的活动 turn
      const activeTurn = sessionId ? options.getActiveTurn(sessionId, purpose) : null;

      // 验证取消状态与 signal
      if (activeTurn?.cancelRequested === true || signal?.aborted === true) {
        throw gateError("RUN_CANCELLED", "Chat request rejected: Run or turn is cancelled/aborted");
      }
      if (activeTurn?.expired === true) {
        throw gateError("RUN_EXPIRED", "Chat request rejected: Run has expired");
      }

      // 消费并校验凭证（防重用、防篡改）
      const ticketRecord = ticketManager.consumeTicket(ticketId, {
        sessionId: sessionId || activeTurn?.sessionId,
        runId: streamOptions?.runId || activeTurn?.runId,
        provider: streamOptions?.provider,
        model: streamOptions?.model,
      });

      // 记录准入通过事件
      if (typeof activeTurn?.recordEvent === "function") {
        activeTurn.recordEvent({
          type: "chat_admission_consumed",
          ticketId: ticketRecord.ticketId,
          sessionId: ticketRecord.sessionId,
          provider: streamOptions?.provider,
          model: streamOptions?.model,
          timestamp: Date.now(),
        });
      }

      // 获取底层流并执行流生命周期 settle
      const rawStream = next();
      return wrapStreamWithSettle(rawStream, (err) => {
        if (typeof streamOptions?.onSettle === "function") {
          try { streamOptions.onSettle(err); } catch {}
        }
      });
    }

    // --- 分支 2：辅助模型调用（如 purpose: "compaction"） ---
    // 缺口 2 修复：严格复用原生 compaction-basic 传递的 sessionId，未绑定则在网络前拒绝
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

    // 缺口 3 修复：取消、abort、过期在网络前立即 Fail-Closed
    if (activeTurn.cancelRequested === true || signal?.aborted === true) {
      throw gateError(
        "RUN_CANCELLED",
        `Auxiliary model call with purpose "${purpose}" rejected: turn or signal is cancelled/aborted`
      );
    }
    if (activeTurn.expired === true) {
      throw gateError(
        "RUN_EXPIRED",
        `Auxiliary model call with purpose "${purpose}" rejected: active Run has expired`
      );
    }

    const { budget, tenantId, runId } = activeTurn;
    if (!budget || typeof budget.admit !== "function") {
      throw gateError(
        "RUN_BUDGET_CONFIG_INVALID",
        `Active Run for session "${sessionId}" has invalid budget configuration`
      );
    }

    // 执行辅助模型调用预算准入
    const admission = budget.admit({
      type: "model",
      purpose,
      model: streamOptions.model,
      provider: streamOptions.provider,
    });

    if (!admission.allowed) {
      throw gateError(
        admission.code || "RUN_MODEL_CALL_LIMIT",
        `Auxiliary model call with purpose "${purpose}" denied by configured budget`
      );
    }

    // 缺口 4 修复：返回异步生成器，以便在首个 chunk 前完成可 await 的持久模型意图记录
    return (async function* () {
      const recordIntentFn = options.recordModelIntent || activeTurn.recordModelIntent;
      if (typeof recordIntentFn === "function") {
        try {
          await recordIntentFn({
            sessionId,
            tenantId,
            runId,
            purpose,
            provider: streamOptions.provider,
            model: streamOptions.model,
            timestamp: Date.now(),
          });
        } catch (intentErr) {
          try { admission.settle?.({ error: intentErr }); } catch {}
          throw gateError(
            "INTENT_AUDIT_FAILED",
            `Model intent recording failed: ${intentErr instanceof Error ? intentErr.message : String(intentErr)}`
          );
        }
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

      let rawStream;
      try {
        rawStream = next();
      } catch (err) {
        try { admission.settle?.({ error: err }); } catch {}
        throw err;
      }

      let settled = false;
      const doSettle = (err) => {
        if (!settled) {
          settled = true;
          try { admission.settle?.({ error: err || undefined }); } catch {}
        }
      };

      try {
        const resolvedStream = rawStream != null && typeof rawStream.then === "function"
          ? await rawStream
          : rawStream;
        for await (const chunk of resolvedStream) {
          yield chunk;
        }
        doSettle(null);
      } catch (err) {
        doSettle(err);
        throw err;
      } finally {
        doSettle(null);
      }
    })();
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

  const dispose = () => {
    for (const d of disposers) {
      try { d(); } catch {}
    }
  };

  return { dispose, ticketManager };
}
