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
    this.defaultTtlMs = Number.isSafeInteger(options.defaultTtlMs) && options.defaultTtlMs > 0 && options.defaultTtlMs <= DEFAULT_TICKET_TTL_MS
      ? options.defaultTtlMs
      : DEFAULT_TICKET_TTL_MS;
    this.maxCapacity = Number.isSafeInteger(options.maxCapacity) && options.maxCapacity > 0 && options.maxCapacity <= MAX_TICKET_CAPACITY
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
    if (![runId,sessionId,provider,model].every(value=>typeof value==='string'&&value.trim()&&value.length<=512)) throw gateError('INVALID_TICKET_PARAMS','Complete host binding is required');
    if (!budgetAdmission || budgetAdmission.allowed !== true) throw gateError('INVALID_BUDGET_ADMISSION','Host budget admission is required');
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>DEFAULT_TICKET_TTL_MS)) throw gateError('INVALID_TICKET_PARAMS','Invalid ticket lifetime');
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

    for (const key of ['sessionId','runId','provider','model']) {
      if (typeof matchParams[key]!=='string'||record[key]!==matchParams[key]) throw gateError('TICKET_'+key.replace('Id','').toUpperCase()+'_MISMATCH','Admission ticket binding mismatch');
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

  // Reservations are acquired once and released even if an iterator is never started.
  const disposeLlmStream=ctx.on('llm/stream',(streamOptions,next)=>{
    const purpose=streamOptions?.purpose||'chat',sessionId=streamOptions?.sessionId,signal=streamOptions?.signal;
    const active=options.getActiveTurn(sessionId,purpose);
    if(!sessionId||!active||!active.runId||active.sessionId!==sessionId)throw gateError('RUN_NOT_BOUND','No active Run binding');
    const binding={sessionId,runId:active.runId,tenantId:active.tenantId};
    const validate=()=>{
      const current=options.getActiveTurn(sessionId,purpose);
      if(!current||Object.keys(binding).some(key=>current[key]!==binding[key]))throw gateError('RUN_NOT_BOUND','Active Run binding changed');
      if(current.cancelRequested||signal?.aborted)throw gateError('RUN_CANCELLED','Run cancelled');
      if(current.expired)throw gateError('RUN_EXPIRED','Run expired');
    };
    validate();
    let admission,recordIntent;
    if(purpose==='chat'){
      ticketManager.consumeTicket(streamOptions.admissionTicket,{sessionId,runId:active.runId,provider:streamOptions.provider,model:streamOptions.model});
    }else{
      recordIntent=options.recordModelIntent||active.recordModelIntent;
      if(typeof recordIntent!=='function')throw gateError('MISSING_INTENT_RECORDER','Durable intent recorder required');
      if(typeof active.budget?.admit!=='function')throw gateError('RUN_BUDGET_CONFIG_INVALID','Budget unavailable');
      admission=active.budget.admit({type:'model',purpose,model:streamOptions.model,provider:streamOptions.provider});
      if(admission?.allowed!==true)throw gateError(admission?.code||'RUN_MODEL_CALL_LIMIT','Model budget denied');
    }
    let settled=false;
    const settle=error=>{if(settled)return;settled=true;try{if(admission)admission.settle?.({error});else streamOptions.onSettle?.(error);}catch{}};
    const generator=(async function*(){
      let failure;
      try{
        validate();
        if(Number.isSafeInteger(active.maxOutputTokens)&&active.maxOutputTokens>0){
          const cap=Number.isSafeInteger(streamOptions.maxTokens)&&streamOptions.maxTokens>0?Math.min(active.maxOutputTokens,streamOptions.maxTokens):active.maxOutputTokens;
          if(streamOptions.maxTokens!==cap){if(Object.isFrozen(streamOptions))throw gateError('RUN_OUTPUT_LIMIT','Request exceeds the output bound');streamOptions.maxTokens=cap;}
        }
        if(recordIntent){
          try{await recordIntent({...binding,purpose,provider:streamOptions.provider,model:streamOptions.model,maxTokens:streamOptions.maxTokens,timestamp:Date.now()});}
          catch{throw gateError('INTENT_AUDIT_FAILED','Model intent recording failed');}
        }
        validate();
        try{await active.recordEvent?.({type:purpose==='chat'?'chat_admission_consumed':'model_request_admitted',...binding,purpose,provider:streamOptions.provider,model:streamOptions.model,timestamp:Date.now()});}
        catch{throw gateError('INTENT_AUDIT_FAILED','Model audit recording failed');}
        validate();
        const raw=await next();validate();
        for await(const chunk of raw){validate();yield chunk;}
      }catch(error){failure=error;throw error;}finally{settle(failure);}
    })();
    return {
      [Symbol.asyncIterator](){return this;},
      next(value){return generator.next(value);},
      async return(value){try{return await generator.return(value);}finally{settle();}},
      async throw(error){try{return await generator.throw(error);}finally{settle(error);}},
    };
  },{prepend:true});

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
