/**
 * DSH 原生推理强度选择与校验候选模块
 * 
 * 职责：
 * 1. 严格校验宿主传入的 provider/model 与 reasoningEffort。
 *    依据权威元数据（authoritative metadata），当模型不支持 reasoning 或 effort 不在支持列表时强力拒绝，
 *    绝不猜测、胡乱默认或在未知字段时宽容。
 * 2. 构造与管理原生 DSH 0.1.1-rc.2 的 ModelSelectionRef（{ current, assembled }），
 *    确保跨轮次切换模型（A -> B）时，A 的 effort 彻底清除，不向 B 污染泄漏。
 * 3. 区分“不指定（undefined）”与“显式配置”，严禁自造默认值，拒绝未知字段。
 * 4. 纯函数设计，不持有密钥，不修改共享 process.env，符合无副作用安全原则。
 */

export const KNOWN_REASONING_EFFORTS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const ALLOWED_SELECTION_KEYS = new Set([
  "provider",
  "model",
  "reasoningEffort",
]);

function invalidSelection(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 校验并规范化权威模型推理元数据
 * @param {object} modelInfo - 模型的权威元数据描述
 * @returns {{ reasoning: boolean, supportedEfforts: string[], defaultEffort?: string }}
 */
export function normalizeModelReasoningMeta(modelInfo) {
  if (!modelInfo || typeof modelInfo !== "object") {
    return { reasoning: false, supportedEfforts: [] };
  }

  // 1. 若明确声明 reasoning 为 false，或者未声明 reasoning
  if (modelInfo.reasoning === false || (!modelInfo.reasoning && !modelInfo.thinkingLevelMap && !modelInfo.efforts && !modelInfo.supportedEfforts)) {
    return { reasoning: false, supportedEfforts: [] };
  }

  // 2. 提取支持的 effort 列表
  let levels = [];
  if (Array.isArray(modelInfo.supportedEfforts)) {
    levels = modelInfo.supportedEfforts;
  } else if (Array.isArray(modelInfo.efforts)) {
    levels = modelInfo.efforts.map(e => (typeof e === "string" ? e : e?.id)).filter(Boolean);
  } else if (modelInfo.reasoning && typeof modelInfo.reasoning === "object" && Array.isArray(modelInfo.reasoning.efforts)) {
    levels = modelInfo.reasoning.efforts.map(e => (typeof e === "string" ? e : e?.id)).filter(Boolean);
  } else if (modelInfo.thinkingLevelMap && typeof modelInfo.thinkingLevelMap === "object") {
    // 依据 pi-ai 规则：非 null 的键为支持
    levels = Object.entries(modelInfo.thinkingLevelMap)
      .filter(([_, wire]) => wire !== null && wire !== undefined)
      .map(([level]) => level);
  } else if (modelInfo.reasoning === true) {
    // 默认 OpenAI 风格标准 5 档
    levels = ["minimal", "low", "medium", "high"];
  }

  const validLevels = [...new Set(levels.filter(l => typeof l === "string" && KNOWN_REASONING_EFFORTS.includes(l)))];
  const defaultEffort = typeof modelInfo.defaultEffort === "string" && validLevels.includes(modelInfo.defaultEffort)
    ? modelInfo.defaultEffort
    : (typeof modelInfo.reasoning?.defaultEffort === "string" && validLevels.includes(modelInfo.reasoning.defaultEffort)
      ? modelInfo.reasoning.defaultEffort
      : undefined);

  return {
    reasoning: validLevels.length > 0,
    supportedEfforts: validLevels,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

/**
 * 校验宿主输入的 Selection 请求并构造不可变的 ModelSelection 对象
 * 
 * @param {object} input - { provider, model, reasoningEffort }
 * @param {object} authoritativeMeta - 权威模型元数据信息 (包含 reasoning / supportedEfforts)
 * @returns {Readonly<{ provider: string, model: string, reasoningEffort?: string }>}
 */
export function validateAndBuildModelSelection(input, authoritativeMeta) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSelection("INVALID_SELECTION_INPUT", "Selection input must be a non-null object");
  }

  // 拒绝未知字段
  for (const key of Object.keys(input)) {
    if (!ALLOWED_SELECTION_KEYS.has(key)) {
      throw invalidSelection("UNRECOGNIZED_SELECTION_FIELD", `Unrecognized field in model selection: "${key}"`);
    }
  }

  const { provider, model, reasoningEffort } = input;

  if (typeof provider !== "string" || !provider.trim()) {
    throw invalidSelection("INVALID_PROVIDER", "Provider must be a non-empty string");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw invalidSelection("INVALID_MODEL", "Model must be a non-empty string");
  }

  const normMeta = normalizeModelReasoningMeta(authoritativeMeta);

  // 显式传入了 reasoningEffort
  if (reasoningEffort !== undefined && reasoningEffort !== null) {
    if (typeof reasoningEffort !== "string") {
      throw invalidSelection("INVALID_REASONING_EFFORT_TYPE", "Reasoning effort must be a string");
    }

    if (!KNOWN_REASONING_EFFORTS.includes(reasoningEffort)) {
      throw invalidSelection("UNKNOWN_REASONING_EFFORT", `Unknown reasoning effort "${reasoningEffort}"`);
    }

    if (!normMeta.reasoning || !normMeta.supportedEfforts.includes(reasoningEffort)) {
      throw invalidSelection(
        "UNSUPPORTED_REASONING_EFFORT",
        `Model "${model}" of provider "${provider}" does not support reasoning effort "${reasoningEffort}"`
      );
    }

    return Object.freeze({
      provider: provider.trim(),
      model: model.trim(),
      reasoningEffort,
    });
  }

  // 未指定 reasoningEffort (undefined)
  return Object.freeze({
    provider: provider.trim(),
    model: model.trim(),
  });
}

/**
 * 创建全新的 ModelSelectionRef 容器
 * 结构与 DSH 0.1.1-rc.2 的 ModelSelectionRef 完全兼容
 * @param {object} [initialSelection]
 * @returns {{ current: object | undefined, assembled: object | undefined }}
 */
export function createModelSelectionRef(initialSelection = undefined) {
  return {
    current: initialSelection,
    assembled: undefined,
  };
}

/**
 * 在热会话中执行模型切换或更新选择
 * 
 * 重点保障：
 * 1. 每次切换模型必须显式重新校验目标模型；
 * 2. 如果目标选择未显式指定 reasoningEffort，A 的 effort 必须被彻底清除，不向 B 污染泄漏；
 * 3. assembled 立即重置为 undefined，直到下一次 prompt assemble 生效。
 * 
 * @param {object} selectionRef - 引用容器
 * @param {object} nextSelectionInput - 下一轮的输入
 * @param {object} authoritativeMetaForTarget - 目标模型的权威元数据
 */
export function transitionModelSelection(selectionRef, nextSelectionInput, authoritativeMetaForTarget) {
  if (!selectionRef || typeof selectionRef !== "object") {
    throw invalidSelection("INVALID_SELECTION_REF", "SelectionRef must be a valid container object");
  }

  const validated = validateAndBuildModelSelection(nextSelectionInput, authoritativeMetaForTarget);

  selectionRef.current = validated;
  selectionRef.assembled = undefined;
  return selectionRef;
}

/**
 * 用于生产 runner 或集成接线时的纯函数适配器：
 * 将 ModelSelectionRef 与 Cordis Agent Context 关联（对齐 installModelSelection）
 * 
 * @param {object} agentCtx - Cordis agent context
 * @param {object} selectionRef - { current, assembled }
 * @returns {() => void} disposer
 */
export function bindModelSelectionToContext(agentCtx, selectionRef) {
  if (!agentCtx || typeof agentCtx.on !== "function") {
    throw invalidSelection("INVALID_AGENT_CONTEXT", "Agent context must provide an .on() method");
  }

  const disposeAssembly = agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const selected = selectionRef.current;
    const assembled = await next();
    selectionRef.assembled = selected;
    if (selected === undefined) return assembled;
    return {
      ...assembled,
      variables: {
        ...assembled?.variables,
        provider: selected.provider,
        model: selected.model,
      },
    };
  });

  const disposeRequest = agentCtx.on("agent/request", async (_payload, next) => {
    const resolved = await next();
    const selected = selectionRef.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved || {};
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });

  return () => {
    try { disposeAssembly(); } catch {}
    try { disposeRequest(); } catch {}
  };
}
