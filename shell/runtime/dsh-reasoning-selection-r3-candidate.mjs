/**
 * DSH 原生推理选择与前置资源边界校验候选 R3 (Reasoning Selection R3 Candidate)
 *
 * 核心升级与修复（R3）：
 * 1. 可移植依赖导入：
 *    - 不采用脆弱的硬编码路径；
 *    - 优先尝试标准裸包导入 `@deepseek-ai/dsh-agent`；
 *    - 若在独立 profile 目录中解析失败，支持通过多种安全后备路径（包含 process.cwd()、NODE_PATH 以及宿主环境）
 *      定位并复用锁定 DSH 安装内的 `installModelSelection`，避免环境路径丢失。
 * 2. 前置 O(1) 资源上限与拒绝（Reject-before-Scan / Bounded-Enumerate）：
 *    - 数组：先检查 `.length <= MAX_EFFORTS_COUNT (32)`，超限直接 O(1) 拒绝，绝不先执行 map/filter/去重；
 *    - 稀疏数组与 Getter 探测防护：绝不在未校验长度前访问元素；
 *    - 对象映射：采用受限逐项迭代器，检查键数量超限立即 abort 抛出，在检查具体键名称之前优先校验数量；
 *    - 字符串：先检查 `.length <= MAX_STRING_LENGTH (256)` 再执行 trim/正则/查找。
 * 3. 严格逐模型权威元数据支持（严禁推断与脑补）：
 *    - 仅从明确的 `supportedEfforts` 列表或合规且非空的 `thinkingLevelMap` 提取；
 *    - 仅有 `reasoning: true` 而缺乏具体列表时，支持集合严格为空，禁止脑补任何档位；
 *    - 多字段冲突（例如 `reasoning: false` 却包含 efforts，或 `supportedEfforts` 与 `thinkingLevelMap` 声明不一致）明确抛错拒绝；
 *    - 原生不支持的 wire 映射必须拒绝（只接受已知 thinkingLevelMap 目标值）。
 * 4. 原子性保证与纯函数：
 *    - 校验失败立即抛出，绝对不改变调用方传入的入参对象，不改变当前的 `selectionRef`；
 *    - 错误信息严格受控，不回显超长或敏感字符串内容。
 */

import { createRequire } from "node:module";

// 可移植的 installModelSelection 导入解析
let installModelSelection;
try {
  const mod = await import("@deepseek-ai/dsh-agent");
  installModelSelection = mod.installModelSelection;
} catch {
  const require = createRequire(import.meta.url);
  const candidatePaths = [
    process.cwd(),
    `${process.cwd()}/shell`,
    new URL("../../shell", import.meta.url).pathname,
    new URL("../..", import.meta.url).pathname,
    process.env.NODE_PATH || "",
  ].filter(Boolean);

  let resolved = null;
  for (const p of candidatePaths) {
    try {
      const probeRequire = createRequire(`${p.replace(/\/$/, "")}/package.json`);
      resolved = probeRequire.resolve("@deepseek-ai/dsh-agent");
      if (resolved) break;
    } catch {}
  }

  if (!resolved) {
    throw new Error("Cannot locate @deepseek-ai/dsh-agent dependency");
  }

  const mod = await import(`file://${resolved}`);
  installModelSelection = mod.installModelSelection;
}

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

export const MAX_STRING_LENGTH = 256;
export const MAX_EFFORTS_COUNT = 32;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 严格 O(1) 长度防范辅助函数
 */
function checkBoundedString(str, fieldName) {
  if (typeof str !== "string") {
    throw fail(`INVALID_${fieldName.toUpperCase()}`, `${fieldName} must be a string`);
  }
  if (str.length === 0 || str.length > MAX_STRING_LENGTH) {
    throw fail(
      `INVALID_${fieldName.toUpperCase()}_LENGTH`,
      `${fieldName} length must be between 1 and ${MAX_STRING_LENGTH}`
    );
  }
  const trimmed = str.trim();
  if (trimmed.length === 0) {
    throw fail(`INVALID_${fieldName.toUpperCase()}`, `${fieldName} must not be empty or whitespace only`);
  }
  return trimmed;
}

/**
 * 校验并提取权威模型的 Reasoning 支持集合（严格无推断、前置限额）
 *
 * @param {object} modelInfo - 权威模型元数据
 * @returns {{ reasoning: boolean, supportedEfforts: readonly string[], defaultEffort?: string }}
 */
export function normalizeAuthoritativeReasoningMeta(modelInfo) {
  if (modelInfo === null || modelInfo === undefined || typeof modelInfo !== "object" || Array.isArray(modelInfo)) {
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  // 1. 矛盾元数据防范：显式 reasoning: false 时禁止携带任何非空推理配置
  if (modelInfo.reasoning === false) {
    const hasEfforts = Array.isArray(modelInfo.efforts) && modelInfo.efforts.length > 0;
    const hasSupported = Array.isArray(modelInfo.supportedEfforts) && modelInfo.supportedEfforts.length > 0;
    const hasMap = modelInfo.thinkingLevelMap && typeof modelInfo.thinkingLevelMap === "object";
    if (hasEfforts || hasSupported || (hasMap && Object.keys(modelInfo.thinkingLevelMap).length > 0)) {
      throw fail("CONTRADICTORY_REASONING_METADATA", "Model specifies reasoning=false but provides reasoning effort metadata");
    }
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  // 2. 检查多重支持定义是否存在且冲突
  const rawSupported = modelInfo.supportedEfforts;
  const rawEfforts = modelInfo.efforts ?? (typeof modelInfo.reasoning === "object" ? modelInfo.reasoning?.efforts : undefined);
  const rawMap = modelInfo.thinkingLevelMap;

  let listFromSupported = null;
  let listFromEfforts = null;
  let listFromMap = null;

  // A. 提取 supportedEfforts (前置 O(1) 长度防范)
  if (rawSupported !== undefined) {
    if (!Array.isArray(rawSupported)) {
      throw fail("INVALID_REASONING_METADATA", "supportedEfforts must be an array");
    }
    if (rawSupported.length > MAX_EFFORTS_COUNT) {
      throw fail("REASONING_METADATA_LIMIT_EXCEEDED", `supportedEfforts array exceeds maximum limit (${MAX_EFFORTS_COUNT})`);
    }
    const set = new Set();
    for (let i = 0; i < rawSupported.length; i++) {
      const item = rawSupported[i];
      if (typeof item !== "string" || item.length > MAX_STRING_LENGTH) {
        throw fail("INVALID_REASONING_EFFORT_METADATA", "Each supported effort must be a bounded string");
      }
      const trimmed = item.trim();
      if (!KNOWN_REASONING_EFFORTS.includes(trimmed)) {
        throw fail("UNKNOWN_REASONING_EFFORT_METADATA", `Metadata contains unknown reasoning effort "${trimmed}"`);
      }
      set.add(trimmed);
    }
    listFromSupported = [...set].sort();
  }

  // B. 提取 efforts (前置 O(1) 长度防范)
  if (rawEfforts !== undefined) {
    if (!Array.isArray(rawEfforts)) {
      throw fail("INVALID_REASONING_METADATA", "efforts must be an array");
    }
    if (rawEfforts.length > MAX_EFFORTS_COUNT) {
      throw fail("REASONING_METADATA_LIMIT_EXCEEDED", `efforts array exceeds maximum limit (${MAX_EFFORTS_COUNT})`);
    }
    const set = new Set();
    for (let i = 0; i < rawEfforts.length; i++) {
      const item = rawEfforts[i];
      const id = typeof item === "string" ? item : (item && typeof item === "object" ? item.id : null);
      if (typeof id !== "string" || id.length > MAX_STRING_LENGTH) {
        throw fail("INVALID_REASONING_EFFORT_METADATA", "Each effort item must be or contain a bounded string ID");
      }
      const trimmed = id.trim();
      if (!KNOWN_REASONING_EFFORTS.includes(trimmed)) {
        throw fail("UNKNOWN_REASONING_EFFORT_METADATA", `Metadata contains unknown reasoning effort "${trimmed}"`);
      }
      set.add(trimmed);
    }
    listFromEfforts = [...set].sort();
  }

  // C. 提取 thinkingLevelMap (前置数量检查与逐项枚举防范)
  if (rawMap !== undefined) {
    if (rawMap === null || typeof rawMap !== "object" || Array.isArray(rawMap)) {
      throw fail("INVALID_REASONING_METADATA", "thinkingLevelMap must be a plain object");
    }
    // Reject-before-Scan: 前置轻量计数，上限截断检查，杜绝扫描超大未知对象
    let countCheck = 0;
    for (const _ in rawMap) {
      if (!Object.prototype.hasOwnProperty.call(rawMap, _)) continue;
      countCheck++;
      if (countCheck > MAX_EFFORTS_COUNT) {
        throw fail("REASONING_METADATA_LIMIT_EXCEEDED", `thinkingLevelMap keys count exceeds maximum limit (${MAX_EFFORTS_COUNT})`);
      }
    }

    const set = new Set();
    for (const level in rawMap) {
      if (!Object.prototype.hasOwnProperty.call(rawMap, level)) continue;
      if (level.length > MAX_STRING_LENGTH) {
        throw fail("INVALID_REASONING_EFFORT_METADATA", "thinkingLevelMap key length exceeds limit");
      }
      if (!KNOWN_REASONING_EFFORTS.includes(level)) {
        throw fail("UNKNOWN_REASONING_EFFORT_METADATA", `thinkingLevelMap contains unknown reasoning effort key "${level}"`);
      }
      const wire = rawMap[level];
      if (wire !== null && wire !== undefined) {
        if (typeof wire !== "string" || wire.length > MAX_STRING_LENGTH || wire.trim().length === 0) {
          throw fail("INVALID_REASONING_WIRE_VALUE", `thinkingLevelMap wire value for "${level}" must be a non-empty bounded string`);
        }
        set.add(level);
      }
    }
    listFromMap = [...set].sort();
  }

  // D. 冲突检查：若提供了多个定义且内容不一致，必须明确拒绝
  const definedLists = [
    { name: "supportedEfforts", list: listFromSupported },
    { name: "efforts", list: listFromEfforts },
    { name: "thinkingLevelMap", list: listFromMap },
  ].filter(d => d.list !== null);

  if (definedLists.length > 1) {
    const firstStr = JSON.stringify(definedLists[0].list);
    for (let i = 1; i < definedLists.length; i++) {
      if (JSON.stringify(definedLists[i].list) !== firstStr) {
        throw fail(
          "CONTRADICTORY_REASONING_METADATA",
          `Conflicting reasoning efforts defined between ${definedLists[0].name} and ${definedLists[i].name}`
        );
      }
    }
  }

  const finalEfforts = definedLists.length > 0 ? definedLists[0].list : [];

  if (finalEfforts.length === 0) {
    return Object.freeze({ reasoning: false, supportedEfforts: Object.freeze([]) });
  }

  const supportedSet = new Set(finalEfforts);

  // E. defaultEffort 提取与校验
  let defaultEffort = undefined;
  const rawDefault = modelInfo.defaultEffort ?? (typeof modelInfo.reasoning === "object" ? modelInfo.reasoning?.defaultEffort : undefined);
  if (rawDefault !== undefined) {
    if (typeof rawDefault !== "string" || rawDefault.length > MAX_STRING_LENGTH || !supportedSet.has(rawDefault.trim())) {
      throw fail("INVALID_DEFAULT_EFFORT", "defaultEffort must be a bounded string matching one of the supported efforts");
    }
    defaultEffort = rawDefault.trim();
  }

  return Object.freeze({
    reasoning: true,
    supportedEfforts: Object.freeze(finalEfforts),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  });
}

/**
 * 校验输入并构造不可变的 ModelSelection 事实对象
 */
export function validateAndBuildModelSelection(input, authoritativeMeta) {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    throw fail("INVALID_SELECTION_INPUT", "Selection input must be a non-null plain object");
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_SELECTION_KEYS.has(key)) {
      throw fail("UNRECOGNIZED_SELECTION_FIELD", `Unrecognized field in model selection: "${key}"`);
    }
  }

  const provider = checkBoundedString(input.provider, "provider");
  const model = checkBoundedString(input.model, "model");

  const meta = normalizeAuthoritativeReasoningMeta(authoritativeMeta);

  if (input.reasoningEffort !== undefined) {
    if (input.reasoningEffort === null) {
      throw fail("INVALID_REASONING_EFFORT_TYPE", "reasoningEffort must not be null; omit the field to specify no effort");
    }
    if (typeof input.reasoningEffort !== "string") {
      throw fail("INVALID_REASONING_EFFORT_TYPE", "reasoningEffort must be a string");
    }
    if (input.reasoningEffort.length === 0 || input.reasoningEffort.length > MAX_STRING_LENGTH) {
      throw fail("INVALID_REASONING_EFFORT_LENGTH", `reasoningEffort length must be <= ${MAX_STRING_LENGTH}`);
    }

    const effort = input.reasoningEffort.trim();
    if (!KNOWN_REASONING_EFFORTS.includes(effort)) {
      throw fail("UNKNOWN_REASONING_EFFORT", `Unknown reasoning effort level`);
    }

    if (!meta.reasoning || !meta.supportedEfforts.includes(effort)) {
      throw fail(
        "UNSUPPORTED_REASONING_EFFORT",
        `Selected model has no authoritative metadata support for reasoning effort "${effort}"`
      );
    }

    return Object.freeze({
      provider,
      model,
      reasoningEffort: effort,
    });
  }

  return Object.freeze({
    provider,
    model,
  });
}

export function createModelSelectionRef(initialSelection = undefined) {
  return {
    current: initialSelection,
    assembled: undefined,
  };
}

export function transitionModelSelection(selectionRef, nextSelectionInput, authoritativeMetaForTarget) {
  if (!selectionRef || typeof selectionRef !== "object" || Array.isArray(selectionRef)) {
    throw fail("INVALID_SELECTION_REF", "SelectionRef must be a non-null container object");
  }

  const validated = validateAndBuildModelSelection(nextSelectionInput, authoritativeMetaForTarget);

  selectionRef.current = validated;
  selectionRef.assembled = undefined;
  return selectionRef;
}

export { installModelSelection };
