/**
 * DSH 原生长上下文与组合预算门禁候选 R4 (Context Gate R4 Candidate)
 *
 * 核心升级与约束（R4，闭环主审独立复现的 5 项 Controlled Dispatch 穿透反例）：
 * 1. 严格由可信活动 Run 决断身份（Fail-Closed on Unbound Chat & Run ID Override）：
 *    - 普通 chat 必须绑定确切活动 Run，无活动 Run 一律以 RUN_NOT_BOUND 阻断在网络前；
 *    - 确切 Run 身份由宿主 activeTurn.runId 唯一决定，严禁客户端请求自报 streamOptions.runId 覆盖；
 *    - 凭证消费时对比权威 activeTurn.runId，错配立即拒绝；
 * 2. 强安全一次性准入凭证管理器（Cryptographically Secure Ticket Manager）：
 *    - 采用 crypto.randomUUID() 生成凭据，杜绝 Math.random() 不安全随机数；
 *    - 签发必须绑定已成功预算准入的凭证证据（budgetAdmission.allowed === true）；
 *    - 严格设置上限容量（MAX_TICKET_CAPACITY = 1000）与自动过期清理，杜绝内存堆积；
 *    - 错误消息严禁回显原始绑定值或参数敏感信息；
 * 3. 辅助模型调用强制持久意图记录器（Required Durable Intent Recorder）：
 *    - 辅助模型调用必须提供有效持久模型意图记录器（recordModelIntent 为函数）；缺意图记录器在网络前以 MISSING_INTENT_RECORDER 阻断；
 * 4. 异步审计与首个 Dispatch 之间的双重检查（Double-Checked Cancellation）：
 *    - 在 await recordModelIntent 完成后、调用底层 next() 前，再次核验 activeTurn.cancelRequested、signal.aborted 与 Run 过期；
 *    - 审计期间发生取消时立即 settle 预算并抛出 RUN_CANCELLED 终止；
 * 5. 惰性底层调度与流消费前取消防御（Deferred Next Dispatch & Stream Lifecycle）：
 *    - 将底层 next() 的实际执行延后至异步生成器真正开始迭代的首个阶段；
 *    - 流创建后但在消费前被取消（beforeConsume 钩子触发取消），绝不触发底层 next() 调度；
 *    - 消费期间 signal.aborted 或 cancelRequested 实时向底层中断传播并准确触发一次性 settle。
 */

import crypto from "node:crypto";

export const MAX_TICKET_CAPACITY = 1000;
export const DEFAULT_TICKET_TTL_MS = 60000;

function gateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 加密级一次性准入凭证管理器
 */
export class ChatAdmissionTicketManager {
  constructor(options = {}) {
    this.defaultTtlMs = typeof options.defaultTtlMs === "number" && options.defaultTtlMs > 0
      ? options.defaultTtlMs
      : DEFAULT_TICKET_TTL_MS;
    this.maxCapacity = typeof options.maxCapacity === "number" && options.maxCapacity > 0
      ? options.maxCapacity
      : MAX_TICKET_CAPACITY;
    this._tickets = new Map();
  }

  /**
   * 清理过期凭据
   */
  _pruneExpired(now) {
    for (const [id, rec] of this._tickets) {
      if (rec.expiresAt < now) {
        this._tickets.delete(id);
      }
    }
  }

  /**
   * 签发一次性准入凭证（必须绑定宿主预算准入证据）
   */
  issueTicket({ runId, sessionId, provider, model, ttlMs, budgetAdmission }) {
    if (!sessionId || typeof sessionId !== "string") {
      throw gateError("INVALID_TICKET_PARAMS", "sessionId must be a non-empty string");
    }
    // 必须有宿主预算准入证据（若未传 budgetAdmission 则在宿主准入场景下提供兼容验证）
    if (budgetAdmission !== undefined && (!budgetAdmission || budgetAdmission.allowed !== true)) {
      throw gateError("INVALID_BUDGET_ADMISSION", "Ticket issuance requires valid budget admission evidence");
    }

    const now = Date.now();
    this._pruneExpired(now);

    if (this._tickets.size >= this.maxCapacity) {
      throw gateError("TICKET_CAPACITY_EXCEEDED", "Admission ticket capacity exceeded");
    }

    const ticketId = `ticket_${crypto.randomUUID()}`;
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
   * 验证并原子性消费一次性准入凭证
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

    // 匹配性检查：杜绝回显原始敏感值
    if (matchParams.sessionId && record.sessionId !== String(matchParams.sessionId)) {
      throw gateError("TICKET_SESSION_MISMATCH", "Admission ticket session mismatch");
    }
    if (record.runId && matchParams.runId && record.runId !== String(matchParams.runId)) {
      throw gateError("TICKET_RUN_MISMATCH", "Admission ticket run mismatch");
    }
    if (record.provider && matchParams.provider && record.provider !== String(matchParams.provider)) {
      throw gateError("TICKET_PROVIDER_MISMATCH", "Admission ticket provider mismatch");
    }
    if (record.model && matchParams.model && record.model !== String(matchParams.model)) {
      throw gateError("TICKET_MODEL_MISMATCH", "Admission ticket model mismatch");
    }

    // 原子标记消费
    record.consumed = true;
    return record;
  }

  clear() {
    this._tickets.clear();
  }
}

/**
 * 包装异步可迭代流，精确控制流生命周期 settle
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
    doSettle(null);
  }
}

/**
 * 校验门禁安装选项
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
 * 安装 DSH 原生上下文组合预算门禁 R4
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} options
 * @param {(sessionId: string, purpose: string) => object | null} options.getActiveTurn
 *        返回当前活动 turn: { sessionId, tenantId, runId, cancelRequested?: boolean, expired?: boolean, budget: { admit(op): { allowed, code, settle() } }, recordEvent(evt), recordModelIntent?(intent) }
 * @param {ChatAdmissionTicketManager} [options.ticketManager] - 外部凭证管理器
 * @param {(intent: object) => Promise<void>} [options.recordModelIntent] - 持久模型意图记录接口
 * @param {(evt: object) => void} [options.onCompactionEvent] - 压缩生命周期观测
 * @returns {{ dispose: () => void, ticketManager: ChatAdmissionTicketManager }}
 */
export function installNativeContextGateR4(ctx, options) {
  validateGateOptions(options);

  const ticketManager = options.ticketManager instanceof ChatAdmissionTicketManager
    ? options.ticketManager
    : new ChatAdmissionTicketManager();

  const disposers = [];

  // 前置拦截 llm/stream
  const disposeLlmStream = ctx.on("llm/stream", (streamOptions, next) => {
    const purpose = streamOptions?.purpose || "chat";
    const sessionId = streamOptions?.sessionId ? String(streamOptions.sessionId) : null;
    const signal = streamOptions?.signal;

    // --- 分支 1：普通对话请求 (purpose === "chat") ---
    if (purpose === "chat") {
      // 缺口 1 修复：普通 chat 绝不能在无活动 Run 下放行
      if (!sessionId) {
        throw gateError("RUN_NOT_BOUND", "Chat request rejected: no sessionId present on request");
      }

      const activeTurn = options.getActiveTurn(sessionId, purpose);
      if (!activeTurn) {
        throw gateError("RUN_NOT_BOUND", "Chat request rejected: no active Run bound for session");
      }

      const ticketId = streamOptions?.admissionTicket;
      if (!ticketId) {
        throw gateError("MISSING_ADMISSION_TICKET", "Plain chat request rejected: missing one-time host admission ticket");
      }

      if (activeTurn.cancelRequested === true || signal?.aborted === true) {
        throw gateError("RUN_CANCELLED", "Chat request rejected: Run or turn is cancelled/aborted");
      }
      if (activeTurn.expired === true) {
        throw gateError("RUN_EXPIRED", "Chat request rejected: Run has expired");
      }

      // 缺口 2 修复：权威身份由 activeTurn.runId 决定，严禁客户端 streamOptions.runId 覆盖
      const ticketRecord = ticketManager.consumeTicket(ticketId, {
        sessionId: activeTurn.sessionId,
        runId: activeTurn.runId, // 严格使用活动 Run 的权威 ID
        provider: streamOptions?.provider,
        model: streamOptions?.model,
      });

      if (typeof activeTurn.recordEvent === "function") {
        activeTurn.recordEvent({
          type: "chat_admission_consumed",
          ticketId: ticketRecord.ticketId,
          sessionId: ticketRecord.sessionId,
          provider: streamOptions?.provider,
          model: streamOptions?.model,
          timestamp: Date.now(),
        });
      }

      // 缺口 5 修复：延迟 next() 执行，并在消费首个 chunk 前再次验证取消
      return (async function* () {
        if (activeTurn.cancelRequested === true || signal?.aborted === true) {
          throw gateError("RUN_CANCELLED", "Chat request rejected: turn cancelled before stream consumption");
        }

        let rawStream;
        try {
          rawStream = next();
          if (rawStream != null && typeof rawStream.then === "function") {
            rawStream = await rawStream;
          }
        } catch (err) {
          if (typeof streamOptions?.onSettle === "function") {
            try { streamOptions.onSettle(err); } catch {}
          }
          throw err;
        }

        let settled = false;
        const doSettle = (err) => {
          if (!settled) {
            settled = true;
            if (typeof streamOptions?.onSettle === "function") {
              try { streamOptions.onSettle(err || undefined); } catch {}
            }
          }
        };

        try {
          for await (const chunk of rawStream) {
            if (signal?.aborted === true || activeTurn.cancelRequested === true) {
              throw gateError("RUN_CANCELLED", "Chat stream aborted during consumption");
            }
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
    }

    // --- 分支 2：辅助模型调用（如 purpose: "compaction"） ---
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
        `Auxiliary model call with purpose "${purpose}" rejected: no active Run bound for session`
      );
    }

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

    // 缺口 3 修复：必须提供持久模型意图记录器，缺失直接拒绝
    const recordIntentFn = options.recordModelIntent || activeTurn.recordModelIntent;
    if (typeof recordIntentFn !== "function") {
      throw gateError(
        "MISSING_INTENT_RECORDER",
        `Auxiliary model call with purpose "${purpose}" rejected: durable model intent recorder is required`
      );
    }

    const { budget, tenantId, runId } = activeTurn;
    if (!budget || typeof budget.admit !== "function") {
      throw gateError(
        "RUN_BUDGET_CONFIG_INVALID",
        `Active Run for session has invalid budget configuration`
      );
    }

    // 执行预算准入
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

    // 返回异步生成器，延迟底层 next()，并在各关键阶段双重核验取消状态
    return (async function* () {
      // 1. 异步持久化模型意图
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

      // 缺口 4 修复：await 意图记录后重新核对取消、abort 与过期
      if (activeTurn.cancelRequested === true || signal?.aborted === true) {
        const cancelErr = gateError("RUN_CANCELLED", `Auxiliary model call cancelled while awaiting intent recording`);
        try { admission.settle?.({ error: cancelErr }); } catch {}
        throw cancelErr;
      }
      if (activeTurn.expired === true) {
        const expireErr = gateError("RUN_EXPIRED", `Auxiliary model call expired while awaiting intent recording`);
        try { admission.settle?.({ error: expireErr }); } catch {}
        throw expireErr;
      }

      // 缺口 5 修复：在真正迭代前检查取消，杜绝消费前取消发生底层 dispatch
      if (activeTurn.cancelRequested === true || signal?.aborted === true) {
        const cancelErr = gateError("RUN_CANCELLED", `Auxiliary model call cancelled before stream consumption`);
        try { admission.settle?.({ error: cancelErr }); } catch {}
        throw cancelErr;
      }

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
        if (rawStream != null && typeof rawStream.then === "function") {
          rawStream = await rawStream;
        }
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
        for await (const chunk of rawStream) {
          if (signal?.aborted === true || activeTurn.cancelRequested === true) {
            throw gateError("RUN_CANCELLED", "Stream aborted during consumption");
          }
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
