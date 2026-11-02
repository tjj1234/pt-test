/**
 * DSH 原生推理强度选择与校验候选 R2 模块
 * 
 * 核心升级与约束（R2）：
 * 1. 消除推断：彻底禁止仅根据 `reasoning: true` 自动推断或脑补 `minimal/low/medium/high`。
 *    必须根据明确的逐模型权威元数据（explicit authoritative metadata）或原生 pi-ai thinkingLevelMap 映射，
 *    只有在支持集合中明确存在的 effort 才能通过校验；缺失/模糊/未提供时一律拒绝显式 effort。
 * 2. 复用原生：直接导入并复用锁定 DSH 的 `installModelSelection`，不重写第二套 `agent/request` 或 prompt assembly 钩子。
 * 3. 输入严格校验与防范：
 *    - 超长字符串防护：先在 O(1) 限制下检查长度，防止 DoS 正则或内存滥用；
 *    - 明确拒绝 null、非法类型、未知字段、矛盾元数据；
 *    - 纯函数设计，不持有密钥，不修改输入对象，不污染环境变量。
 * 4. 状态隔离与清理：
 *    - 提供 `createModelSelectionRef()` 包装；
 *    - `transitionModelSelection(ref, nextInput, authoritativeMeta)` 保证 A(high) -> B(未指定) 切换时，
 *      A 的 effort 彻底清除，B 绝无继承；
 *    - 失败校验抛出异常，且保证原有 selectionRef 的状态完好无损（原子性保证）。
 */

import { installModelSelection } from "../../shell/node_modules/@deepseek-ai/dsh-agent/lib/index.js";

export const KNOWN_REASONING_EFFORTS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const ALLOWED_SELECTION_KEYS = Object.freeze(new Set([
  "provider",
  "model",
  "reasoningEffort",
]));

const MAX_STRING_LENGTH = 256;
const MAX_EFFORTS_COUNT = 32;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 校验并提取权威模型的 Reasoning 支持集合（严格无推断）
 * 
 * 规则：
 * - 只有显式声明了支持的 effort 列表（如 `efforts` 数组或非空非 null 的 `thinkingLevelMap` 映射），才视为支持该 effort。
 * - 仅有 `reasoning: true` 而无任何具体 effort 集合时，不推断任何 effort 档位（支持列表为空），
 *   此时允许作为普通文本模型选择，但若请求显式指定 effort 则一律拒绝。
 * - 拒绝矛盾元数据（例如声明 `reasoning: false` 却挂载了 `efforts`）。
 * 
 * @param {object} modelInfo - 权威模型元数据
 * @returns {{ reasoning: boolean, supportedEfforts: readonly string[], defaultEffort?: string }}
 */
export function normalizeAuthoritativeReasoningMeta(modelInfo) {
  if (modelInfo === null || modelInfo === undefined || typeof modelInfo !== "object" || Array.isArray(modelInfo)) {
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  // 1. 检查是否存在矛盾元数据
  if (modelInfo.reasoning === false) {
    if (
      (Array.isArray(modelInfo.efforts) && modelInfo.efforts.length > 0) ||
      (Array.isArray(modelInfo.supportedEfforts) && modelInfo.supportedEfforts.length > 0) ||
      (modelInfo.thinkingLevelMap && typeof modelInfo.thinkingLevelMap === "object" && Object.keys(modelInfo.thinkingLevelMap).length > 0)
    ) {
      throw fail("CONTRADICTORY_REASONING_METADATA", "Model specifies reasoning=false but defines reasoning efforts metadata");
    }
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  // 2. 提取具体明确支持的 efforts 档位（严格无推测）
  let rawList = null;

  if (Array.isArray(modelInfo.supportedEfforts)) {
    rawList = modelInfo.supportedEfforts;
  } else if (Array.isArray(modelInfo.efforts)) {
    rawList = modelInfo.efforts.map(e => (typeof e === "string" ? e : e?.id)).filter(Boolean);
  } else if (modelInfo.reasoning && typeof modelInfo.reasoning === "object" && Array.isArray(modelInfo.reasoning.efforts)) {
    rawList = modelInfo.reasoning.efforts.map(e => (typeof e === "string" ? e : e?.id)).filter(Boolean);
  } else if (modelInfo.thinkingLevelMap && typeof modelInfo.thinkingLevelMap === "object" && !Array.isArray(modelInfo.thinkingLevelMap)) {
    // pi-ai 映射规范：非 null 且非 undefined 的档位为支持
    rawList = Object.entries(modelInfo.thinkingLevelMap)
      .filter(([_, wire]) => wire !== null && wire !== undefined && typeof wire === "string" && wire.trim().length > 0)
      .map(([level]) => level);
  }

  // 若未提供任何具体列表（包括仅提供 reasoning: true 的情况），支持列表严格为空
  if (!rawList || rawList.length === 0) {
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  if (rawList.length > MAX_EFFORTS_COUNT) {
    throw fail("REASONING_METADATA_LIMIT_EXCEEDED", `Supported efforts list exceeds limit (${MAX_EFFORTS_COUNT})`);
  }

  // 校验每个 effort 是否属于已知档位并去重
  const supportedSet = new Set();
  for (const item of rawList) {
    if (typeof item !== "string" || item.length > MAX_STRING_LENGTH) {
      throw fail("INVALID_REASONING_EFFORT_METADATA", "Reasoning effort in metadata must be a bounded string");
    }
    const trimmed = item.trim();
    if (!KNOWN_REASONING_EFFORTS.includes(trimmed)) {
      throw fail("UNKNOWN_REASONING_EFFORT_METADATA", `Metadata contains unknown reasoning effort "${trimmed}"`);
    }
    supportedSet.add(trimmed);
  }

  const supportedEfforts = Object.freeze([...supportedSet]);

  let defaultEffort = undefined;
  const rawDefault = modelInfo.defaultEffort ?? (typeof modelInfo.reasoning === "object" ? modelInfo.reasoning.defaultEffort : undefined);
  if (rawDefault !== undefined) {
    if (typeof rawDefault !== "string" || !supportedSet.has(rawDefault)) {
      throw fail("INVALID_DEFAULT_EFFORT", `Default reasoning effort "${rawDefault}" is not in supported efforts list`);
    }
    defaultEffort = rawDefault;
  }

  return Object.freeze({
    reasoning: supportedEfforts.length > 0,
    supportedEfforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  });
}

/**
 * 校验输入并构造不可变的 ModelSelection 事实对象
 * 
 * @param {object} input - { provider, model, reasoningEffort }
 * @param {object} authoritativeMeta - 权威模型元数据
 * @returns {Readonly<{ provider: string, model: string, reasoningEffort?: string }>}
 */
export function validateAndBuildModelSelection(input, authoritativeMeta) {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    throw fail("INVALID_SELECTION_INPUT", "Selection input must be a non-null object");
  }

  // 拒绝未知字段
  for (const key of Object.keys(input)) {
    if (!ALLOWED_SELECTION_KEYS.has(key)) {
      throw fail("UNRECOGNIZED_SELECTION_FIELD", `Unrecognized field in model selection: "${key}"`);
    }
  }

  const { provider, model, reasoningEffort } = input;

  // 快速 O(1) 长度防范与类型检查
  if (typeof provider !== "string") {
    throw fail("INVALID_PROVIDER", "Provider must be a string");
  }
  if (provider.length === 0 || provider.length > MAX_STRING_LENGTH || !provider.trim()) {
    throw fail("INVALID_PROVIDER", `Provider must be a non-empty string <= ${MAX_STRING_LENGTH} chars`);
  }

  if (typeof model !== "string") {
    throw fail("INVALID_MODEL", "Model must be a string");
  }
  if (model.length === 0 || model.length > MAX_STRING_LENGTH || !model.trim()) {
    throw fail("INVALID_MODEL", `Model must be a non-empty string <= ${MAX_STRING_LENGTH} chars`);
  }

  const meta = normalizeAuthoritativeReasoningMeta(authoritativeMeta);

  // 显式指定 reasoningEffort 的处理
  if (reasoningEffort !== undefined) {
    if (reasoningEffort === null) {
      throw fail("INVALID_REASONING_EFFORT_TYPE", "Reasoning effort must not be null; omit the field to specify no effort");
    }
    if (typeof reasoningEffort !== "string") {
      throw fail("INVALID_REASONING_EFFORT_TYPE", "Reasoning effort must be a string");
    }
    if (reasoningEffort.length === 0 || reasoningEffort.length > MAX_STRING_LENGTH) {
      throw fail("INVALID_REASONING_EFFORT_LENGTH", `Reasoning effort length exceeds ${MAX_STRING_LENGTH}`);
    }

    const trimmedEffort = reasoningEffort.trim();
    if (!KNOWN_REASONING_EFFORTS.includes(trimmedEffort)) {
      throw fail("UNKNOWN_REASONING_EFFORT", `Unknown reasoning effort "${trimmedEffort}"`);
    }

    // 严格核查该模型是否明确支持该 effort（无推测）
    if (!meta.reasoning || !meta.supportedEfforts.includes(trimmedEffort)) {
      throw fail(
        "UNSUPPORTED_REASONING_EFFORT",
        `Model "${model.trim()}" of provider "${provider.trim()}" has no explicit metadata support for reasoning effort "${trimmedEffort}"`
      );
    }

    return Object.freeze({
      provider: provider.trim(),
      model: model.trim(),
      reasoningEffort: trimmedEffort,
    });
  }

  // 未指定 reasoningEffort（合法的无 effort 选择，清除任何先前 effort）
  return Object.freeze({
    provider: provider.trim(),
    model: model.trim(),
  });
}

/**
 * 构造与 DSH 原生 ModelSelectionRef 结构完全一致的容器
 * 结构契约: { current: ModelSelection | undefined, assembled: ModelSelection | undefined }
 * 
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
 * 热会话中执行模型选择切换 (A -> B)
 * 
 * 关键保障：
 * 1. 原子性：在成功通过校验前，绝不修改传入的 selectionRef；
 * 2. 彻底清理：若新模型未指定 effort，新 selection.current 绝不保留上一模型的 effort；
 * 3. assembled 立即重置为 undefined，等待下一次原生 prompt assemble 快照。
 * 
 * @param {object} selectionRef - 原生 ModelSelectionRef
 * @param {object} nextSelectionInput - 下一轮选择输入
 * @param {object} authoritativeMetaForTarget - 目标模型的权威元数据
 * @returns {object} selectionRef
 */
export function transitionModelSelection(selectionRef, nextSelectionInput, authoritativeMetaForTarget) {
  if (!selectionRef || typeof selectionRef !== "object" || Array.isArray(selectionRef)) {
    throw fail("INVALID_SELECTION_REF", "SelectionRef must be a non-null container object");
  }

  // 先进行纯函数校验与构建（失败会直接抛出，不污染 selectionRef）
  const validated = validateAndBuildModelSelection(nextSelectionInput, authoritativeMetaForTarget);

  // 成功后原子赋值
  selectionRef.current = validated;
  selectionRef.assembled = undefined;
  return selectionRef;
}

// 重新导出 DSH 原生 installModelSelection，确保宿主直接复用原生钩子
export { installModelSelection };
