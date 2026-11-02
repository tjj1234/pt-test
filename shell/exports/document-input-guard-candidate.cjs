'use strict';
/**
 * shell/exports/document-input-guard-candidate.cjs
 * ============================================================================
 * F2 结构化文档导出输入门禁候选模块 (Input Guard Candidate)
 * 契约规范：docs/refactor/GEMINI-DOCEXPORT-INPUT-GUARD-PACKAGE-20261026.md
 *
 * 职责：
 *   作为结构化文档导出（Word / PDF / Excel）的纯函数输入校验门禁。
 *   在进入任何生成器或重型处理之前，对输入数据进行严格的纯 JSON 结构校验、
 *   属性描述符探查、原型链防篡改、循环/共享引用检测、以及增量 UTF-8 字节和
 *   Unicode code point 资源边界统计。
 *
 * 核心安全与工程约束：
 *   1. 零外部依赖：纯原生 Node.js 实现，无网络请求、无文件读写、无数据库依赖。
 *   2. 严格 Fail-Closed：一旦发现未知字段、异常类型、维度失配或超限立即阻断。
 *   3. 错误信息严格脱敏：绝不回显用户单元格内容、敏感文本或文件路径。
 *   4. 防御对象陷阱：拒绝 getter、setter、Proxy 抛错及自定义原型对象。
 *   5. 循环与共享引用检测：拒绝循环引用以及任何跨分支复用同一个可变对象/数组。
 *   6. 增量 UTF-8 统计：边遍历边统计字节开销，超限立即中止，拒绝先复制超大输入。
 *   7. 公式样字符串原样保留：对于以 `=+\-@\t\r` 开头的字符串，作为普通文本校验保留。
 *   8. 不可变与深冻结：原始入参绝不原地修改，返回深冻结 (deep-frozen) 的规范化副本。
 * ============================================================================
 */

const { Buffer } = require('node:buffer');
const { types } = require('node:util');

/**
 * 默认资源边界与硬上限 (不可突破)
 */
const DEFAULT_INPUT_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,      // 5 MB 总 UTF-8 字节数
  maxTitleCodePoints: 500,        // 标题最大 Unicode code points
  maxCodePointsPerField: 10_000,  // 单字段最大 Unicode code points (作者、日期、段落、单元格)
  maxSections: 50,                // 最大章节数
  maxParagraphs: 10_000,          // 所有章节累计段落数
  maxTables: 20,                  // 最大表格数 (顶层 + 章节内部)
  maxRows: 10_000,                // 最大总数据行数 (所有表格累计)
  maxCells: 100_000,              // 最大总单元格数 (含表头与行单元格累计)
  maxColumnsPerTable: 100,        // 单表最大列数
  maxDepth: 8,                    // 最大嵌套层级
});

const HARD_INPUT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,     // 20 MB
  maxTitleCodePoints: 2_000,
  maxCodePointsPerField: 50_000,
  maxSections: 200,
  maxParagraphs: 50_000,
  maxTables: 100,
  maxRows: 50_000,
  maxCells: 500_000,
  maxColumnsPerTable: 500,
  maxDepth: 16,
});

/**
 * 门禁稳定错误码
 */
const DOC_INPUT_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'DOC_INPUT_INVALID',
  UNKNOWN_FIELD: 'DOC_UNKNOWN_FIELD',
  GETTER_PROHIBITED: 'DOC_GETTER_PROHIBITED',
  PROTOTYPE_POLLUTION: 'DOC_PROTOTYPE_POLLUTION',
  CIRCULAR_REFERENCE: 'DOC_CIRCULAR_REFERENCE',
  SHARED_REFERENCE: 'DOC_SHARED_REFERENCE',
  TITLE_REQUIRED: 'DOC_TITLE_REQUIRED',
  TITLE_EMPTY: 'DOC_TITLE_EMPTY',
  INVALID_TYPE: 'DOC_INVALID_TYPE',
  NON_FINITE_NUMBER: 'DOC_NON_FINITE_NUMBER',
  BYTES_LIMIT_EXCEEDED: 'DOC_BYTES_LIMIT_EXCEEDED',
  CODEPOINTS_LIMIT_EXCEEDED: 'DOC_CODEPOINTS_LIMIT_EXCEEDED',
  SECTIONS_LIMIT_EXCEEDED: 'DOC_SECTIONS_LIMIT_EXCEEDED',
  PARAGRAPHS_LIMIT_EXCEEDED: 'DOC_PARAGRAPHS_LIMIT_EXCEEDED',
  TABLES_LIMIT_EXCEEDED: 'DOC_TABLES_LIMIT_EXCEEDED',
  ROWS_LIMIT_EXCEEDED: 'DOC_ROWS_LIMIT_EXCEEDED',
  CELLS_LIMIT_EXCEEDED: 'DOC_CELLS_LIMIT_EXCEEDED',
  COLUMNS_LIMIT_EXCEEDED: 'DOC_COLUMNS_LIMIT_EXCEEDED',
  DEPTH_LIMIT_EXCEEDED: 'DOC_DEPTH_LIMIT_EXCEEDED',
  ROW_LENGTH_MISMATCH: 'DOC_TABLE_ROW_LENGTH_MISMATCH',
  LIMIT_OPTION_INVALID: 'DOC_LIMIT_OPTION_INVALID',
  LIMIT_EXCEEDS_CEILING: 'DOC_LIMIT_EXCEEDS_CEILING',
});

const ALLOWED_ROOT_KEYS = new Set(['title', 'author', 'date', 'sections', 'table']);
const ALLOWED_SECTION_KEYS = new Set(['heading', 'paragraphs', 'table']);
const ALLOWED_TABLE_KEYS = new Set(['headers', 'rows']);
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 创建脱敏门禁异常：确保错误信息中只包含结构位置、元数据与计数值，严禁携带用户单元格与文本内容
 */
function createDocInputError(message, code) {
  const err = new TypeError(`[DOC_INPUT_GUARD] ${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * 高性能 Unicode code point 计数器 (无需为超长字符串分配字符数组)
 */
function countCodePoints(str) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    count++;
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // 跨过低代理项
      }
    }
  }
  return count;
}

/**
 * 解析并校验资源限制配置，确保不突破硬上限
 */
function resolveLimits(options = {}) {
  if (options === null || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw createDocInputError('Limits option must be a plain object', DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID);
  }
  const result = { ...DEFAULT_INPUT_LIMITS };
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(DEFAULT_INPUT_LIMITS, key)) {
      throw createDocInputError('Unknown limit option', DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createDocInputError('Limit accessors are prohibited', DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID);
    }
    const userVal = descriptor.value;
    if (typeof userVal !== 'number' || !Number.isSafeInteger(userVal) || userVal <= 0) {
      throw createDocInputError(`Limit option [redacted] must be a positive safe integer`, DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID);
    }
    const ceiling = HARD_INPUT_LIMITS[key];
    if (userVal > ceiling) {
      throw createDocInputError(
        `Limit option [redacted] (${userVal}) exceeds hard ceiling (${ceiling})`,
        DOC_INPUT_ERROR_CODES.LIMIT_EXCEEDS_CEILING
      );
    }
    result[key] = userVal;
  }

  return Object.freeze(result);
}

/**
 * 安全深度冻结对象与数组
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * 纯函数核心门禁：校验并规范化结构化文档输入
 *
 * @param {unknown} value 输入待校验对象
 * @param {object} [limits] 自定义资源限制
 * @returns {{ normalized: Readonly<object>, diagnostics: Readonly<object> }}
 */
function guardStructuredDocumentInput(value, limits = {}) {
  const effectiveLimits = resolveLimits(limits);

  // 1. 顶层非空校验与纯对象检查
  if (types.isProxy(value)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw createDocInputError('Document root input must be a non-null plain object', DOC_INPUT_ERROR_CODES.INVALID_INPUT);
  }

  // 统计指标
  let totalBytes = 2; // 计入顶层 `{}` 2 字节
  let sectionCount = 0;
  let paragraphCount = 0;
  let tableCount = 0;
  let rowCount = 0;
  let cellCount = 0;
  let maxDepthObserved = 1;

  // 引用追踪：区分循环引用与分支间共享可变对象
  const seenObjects = new Set();
  const activeStack = new Set();

  function trackDepth(currentDepth) {
    if (currentDepth > maxDepthObserved) {
      maxDepthObserved = currentDepth;
    }
    if (currentDepth > effectiveLimits.maxDepth) {
      throw createDocInputError(
        `Document nesting depth exceeded limit (allowed: ${effectiveLimits.maxDepth}, reached: ${currentDepth})`,
        DOC_INPUT_ERROR_CODES.DEPTH_LIMIT_EXCEEDED
      );
    }
  }

  function addBytes(bytes) {
    totalBytes += bytes;
    if (totalBytes > effectiveLimits.maxBytes) {
      throw createDocInputError(
        `Total document UTF-8 input size exceeds limit (allowed: ${effectiveLimits.maxBytes} bytes)`,
        DOC_INPUT_ERROR_CODES.BYTES_LIMIT_EXCEEDED
      );
    }
  }

  function enterObject(obj, locationName) {
    if (activeStack.has(obj)) {
      throw createDocInputError(`Circular reference detected at ${locationName}`, DOC_INPUT_ERROR_CODES.CIRCULAR_REFERENCE);
    }
    if (seenObjects.has(obj)) {
      throw createDocInputError(`Shared mutable object reference detected at ${locationName}`, DOC_INPUT_ERROR_CODES.SHARED_REFERENCE);
    }
    seenObjects.add(obj);
    activeStack.add(obj);
  }

  function exitObject(obj) {
    activeStack.delete(obj);
  }

  /**
   * 安全提取并校验对象的自身属性描述符，阻断 getter / setter / proxy 陷阱
   */
  function inspectOwnProperties(obj, allowedKeys, locationName) {
    if (types.isProxy(obj)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    let proto;
    try {
      proto = Object.getPrototypeOf(obj);
    } catch {
      throw createDocInputError(`Accessor trap threw on getPrototypeOf at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    }

    if (proto !== Object.prototype && proto !== null) {
      throw createDocInputError(`Object at ${locationName} has custom prototype, expected plain object`, DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION);
    }

    let keys;
    try {
      keys = Reflect.ownKeys(obj);
    } catch {
      throw createDocInputError(`Accessor trap threw on inspecting properties at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    }

    const descriptors = {};
    for (const key of keys) {
      if (typeof key === 'symbol') {
        throw createDocInputError(`Symbol properties are prohibited at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
      }

      if (DANGEROUS_PROTO_KEYS.has(key)) {
        throw createDocInputError(`Dangerous prototype property [redacted] detected at ${locationName}`, DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION);
      }

      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, key);
      } catch {
        throw createDocInputError(`Accessor trap threw on getOwnPropertyDescriptor for [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      }

      if (!desc) {
        throw createDocInputError(`Failed to retrieve property descriptor for [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
      }

      if (desc.get || desc.set) {
        throw createDocInputError(`Accessor descriptor (getter/setter) detected for property [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      }

      if (!allowedKeys.has(key)) {
        throw createDocInputError(`Unknown property [redacted] detected at ${locationName}`, DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD);
      }

      descriptors[key] = desc;
    }

    return descriptors;
  }

  /**
   * 安全检查数组及其自身属性，阻断数组属性污染与 getter 陷阱
   */
  function inspectArray(arr, locationName) {
    if (types.isProxy(arr)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    if (!Array.isArray(arr)) {
      throw createDocInputError(`Expected array at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
    }

    let proto;
    try {
      proto = Object.getPrototypeOf(arr);
    } catch {
      throw createDocInputError(`Accessor trap threw on getPrototypeOf array at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    }

    if (proto !== Array.prototype) {
      throw createDocInputError(`Array at ${locationName} has custom prototype`, DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION);
    }

    let keys;
    try {
      keys = Reflect.ownKeys(arr);
    } catch {
      throw createDocInputError(`Accessor trap threw on inspecting array properties at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
    }

    // 数组自身键只能是 0..len-1 以及 'length'
    const len = arr.length;
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key === 'symbol') {
        throw createDocInputError(`Symbol property on array is prohibited at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
      }
      if (DANGEROUS_PROTO_KEYS.has(key)) {
        throw createDocInputError(`Dangerous property [redacted] detected on array at ${locationName}`, DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION);
      }
      const idx = Number(key);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= len || String(idx) !== key) {
        throw createDocInputError(`Non-index property [redacted] detected on array at ${locationName}`, DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD);
      }

      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(arr, key);
      } catch {
        throw createDocInputError(`Accessor trap threw on array index [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      }

      if (!desc) {
        throw createDocInputError(`Failed to retrieve descriptor for array index [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
      }

      if (desc.get || desc.set) {
        throw createDocInputError(`Accessor descriptor (getter/setter) detected at array index [redacted] at ${locationName}`, DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      }
    }
  }

  /**
   * 校验字符串单字段 code point 并计入 UTF-8 字节
   */
  function processString(str, maxPoints, locationName) {
    if (typeof str !== 'string') {
      throw createDocInputError(`Expected string at ${locationName}`, DOC_INPUT_ERROR_CODES.INVALID_TYPE);
    }

    // Every code point occupies at most two UTF-16 code units. Reject an
    // oversized field before JSON.stringify can allocate an escaped copy.
    if (str.length > maxPoints * 2) {
      throw createDocInputError(`Code point limit exceeded at ${locationName}`, DOC_INPUT_ERROR_CODES.CODEPOINTS_LIMIT_EXCEEDED);
    }
    const points = countCodePoints(str);
    if (points > maxPoints) {
      throw createDocInputError(
        `Code point limit exceeded at ${locationName} (allowed: ${maxPoints}, got: ${points})`,
        DOC_INPUT_ERROR_CODES.CODEPOINTS_LIMIT_EXCEEDED
      );
    }

    // JSON escaping can expand control characters and lone surrogates.
    addBytes(Buffer.byteLength(JSON.stringify(str), 'utf8'));
    return str;
  }

  /**
   * 校验表格结构与数据行单元格
   */
  function processTable(tableObj, locationName, currentDepth) {
    tableCount++;
    if (tableCount > effectiveLimits.maxTables) {
      throw createDocInputError(
        `Total tables count exceeded limit (allowed: ${effectiveLimits.maxTables})`,
        DOC_INPUT_ERROR_CODES.TABLES_LIMIT_EXCEEDED
      );
    }

    trackDepth(currentDepth);
    enterObject(tableObj, locationName);

    const descMap = inspectOwnProperties(tableObj, ALLOWED_TABLE_KEYS, locationName);

    // 1. headers 必须存在且为非空字符串数组
    if (!descMap.headers) {
      throw createDocInputError(`Table at ${locationName} must contain "headers" property`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
    }

    const rawHeaders = descMap.headers.value;
    trackDepth(currentDepth + 1);
    enterObject(rawHeaders, `${locationName}.headers`);
    inspectArray(rawHeaders, `${locationName}.headers`);

    if (rawHeaders.length === 0) {
      throw createDocInputError(`Table headers array at ${locationName} cannot be empty`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
    }

    if (rawHeaders.length > effectiveLimits.maxColumnsPerTable) {
      throw createDocInputError(
        `Table at ${locationName} exceeds maximum columns limit (allowed: ${effectiveLimits.maxColumnsPerTable}, got: ${rawHeaders.length})`,
        DOC_INPUT_ERROR_CODES.COLUMNS_LIMIT_EXCEEDED
      );
    }

    const colCount = rawHeaders.length;
    cellCount += colCount;
    if (cellCount > effectiveLimits.maxCells) {
      throw createDocInputError(
        `Total cells count exceeded limit (allowed: ${effectiveLimits.maxCells})`,
        DOC_INPUT_ERROR_CODES.CELLS_LIMIT_EXCEEDED
      );
    }

    addBytes(Buffer.byteLength('headers', 'utf8') + 5); // `"headers":[]`

    const normalizedHeaders = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const headerVal = rawHeaders[c];
      normalizedHeaders[c] = processString(headerVal, effectiveLimits.maxCodePointsPerField, `${locationName}.headers[${c}]`);
    }
    exitObject(rawHeaders);

    // 2. rows 必须存在且为数组
    if (!descMap.rows) {
      throw createDocInputError(`Table at ${locationName} must contain "rows" property`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
    }

    const rawRows = descMap.rows.value;
    trackDepth(currentDepth + 1);
    enterObject(rawRows, `${locationName}.rows`);
    inspectArray(rawRows, `${locationName}.rows`);
    if (rawRows.length > effectiveLimits.maxRows - rowCount) {
      throw createDocInputError('Total table rows exceed limit', DOC_INPUT_ERROR_CODES.ROWS_LIMIT_EXCEEDED);
    }

    addBytes(Buffer.byteLength('rows', 'utf8') + 5); // `"rows":[]`

    const normalizedRows = new Array(rawRows.length);
    for (let r = 0; r < rawRows.length; r++) {
      rowCount++;
      if (rowCount > effectiveLimits.maxRows) {
        throw createDocInputError(
          `Total rows count exceeded limit (allowed: ${effectiveLimits.maxRows})`,
          DOC_INPUT_ERROR_CODES.ROWS_LIMIT_EXCEEDED
        );
      }

      const rowArr = rawRows[r];
      trackDepth(currentDepth + 2);
      enterObject(rowArr, `${locationName}.rows[${r}]`);
      inspectArray(rowArr, `${locationName}.rows[${r}]`);

      // 严格 Fail-Closed：列数失配立即阻断，不回显用户数据
      if (rowArr.length !== colCount) {
        throw createDocInputError(
          `Table row at index ${r} has ${rowArr.length} columns, expected ${colCount}`,
          DOC_INPUT_ERROR_CODES.ROW_LENGTH_MISMATCH
        );
      }

      cellCount += colCount;
      if (cellCount > effectiveLimits.maxCells) {
        throw createDocInputError(
          `Total cells count exceeded limit (allowed: ${effectiveLimits.maxCells})`,
          DOC_INPUT_ERROR_CODES.CELLS_LIMIT_EXCEEDED
        );
      }

      addBytes(2); // `[]` 数组外框

      const normalizedRow = new Array(colCount);
      for (let c = 0; c < colCount; c++) {
        trackDepth(currentDepth + 3);
        const cell = rowArr[c];

        if (cell === null) {
          addBytes(4); // `null`
          normalizedRow[c] = null;
        } else if (typeof cell === 'number') {
          if (!Number.isFinite(cell)) {
            throw createDocInputError(
              `Non-finite number found at ${locationName}.rows[${r}][${c}]`,
              DOC_INPUT_ERROR_CODES.NON_FINITE_NUMBER
            );
          }
          const numStr = String(cell);
          addBytes(Buffer.byteLength(numStr, 'utf8'));
          normalizedRow[c] = cell;
        } else if (typeof cell === 'string') {
          // 公式样字符串保留原样，作为纯文本处理
          normalizedRow[c] = processString(cell, effectiveLimits.maxCodePointsPerField, `${locationName}.rows[${r}][${c}]`);
        } else {
          // 拒绝对象、数组、undefined、symbol、function 等异常单元格类型，不回显具体值
          throw createDocInputError(
            `Invalid cell value type at ${locationName}.rows[${r}][${c}]: expected string, finite number, or null`,
            DOC_INPUT_ERROR_CODES.INVALID_TYPE
          );
        }
      }

      normalizedRows[r] = normalizedRow;
      exitObject(rowArr);
    }

    exitObject(rawRows);
    exitObject(tableObj);

    return {
      headers: normalizedHeaders,
      rows: normalizedRows,
    };
  }

  // --- 开始主遍历 ---
  trackDepth(1);
  enterObject(value, 'root');

  const rootDesc = inspectOwnProperties(value, ALLOWED_ROOT_KEYS, 'root');

  // 1. 必填 title 校验
  if (!rootDesc.title) {
    throw createDocInputError('Document root must contain "title" property', DOC_INPUT_ERROR_CODES.TITLE_REQUIRED);
  }

  const rawTitle = rootDesc.title.value;
  if (typeof rawTitle !== 'string') {
    throw createDocInputError('Document title must be a string', DOC_INPUT_ERROR_CODES.TITLE_REQUIRED);
  }

  const normalizedTitle = processString(rawTitle, effectiveLimits.maxTitleCodePoints, 'root.title');
  if (rawTitle.trim().length === 0) {
    throw createDocInputError('Document title cannot be empty or whitespace only', DOC_INPUT_ERROR_CODES.TITLE_EMPTY);
  }

  addBytes(Buffer.byteLength('title', 'utf8') + 3); // `"title":`

  const normalizedDoc = { title: normalizedTitle };

  // 2. 可选 author 校验
  if (rootDesc.author) {
    const rawAuthor = rootDesc.author.value;
    if (typeof rawAuthor !== 'string') {
      throw createDocInputError('Document author must be a string if provided', DOC_INPUT_ERROR_CODES.INVALID_TYPE);
    }
    addBytes(Buffer.byteLength('author', 'utf8') + 3);
    normalizedDoc.author = processString(rawAuthor, effectiveLimits.maxCodePointsPerField, 'root.author');
  }

  // 3. 可选 date 校验
  if (rootDesc.date) {
    const rawDate = rootDesc.date.value;
    if (typeof rawDate !== 'string') {
      throw createDocInputError('Document date must be a string if provided', DOC_INPUT_ERROR_CODES.INVALID_TYPE);
    }
    addBytes(Buffer.byteLength('date', 'utf8') + 3);
    normalizedDoc.date = processString(rawDate, effectiveLimits.maxCodePointsPerField, 'root.date');
  }

  // 4. 可选 sections 校验
  if (rootDesc.sections) {
    const rawSections = rootDesc.sections.value;
    trackDepth(2);
    enterObject(rawSections, 'root.sections');
    inspectArray(rawSections, 'root.sections');

    if (rawSections.length > effectiveLimits.maxSections) {
      throw createDocInputError(
        `Total sections count exceeded limit (allowed: ${effectiveLimits.maxSections}, got: ${rawSections.length})`,
        DOC_INPUT_ERROR_CODES.SECTIONS_LIMIT_EXCEEDED
      );
    }

    addBytes(Buffer.byteLength('sections', 'utf8') + 5); // `"sections":[]`

    const normalizedSections = new Array(rawSections.length);
    for (let s = 0; s < rawSections.length; s++) {
      sectionCount++;
      const secObj = rawSections[s];
      trackDepth(3);

      if (types.isProxy(secObj)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      if (secObj === null || typeof secObj !== 'object' || Array.isArray(secObj)) {
        throw createDocInputError(`Section at index ${s} must be a plain object`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
      }

      enterObject(secObj, `root.sections[${s}]`);
      const secDesc = inspectOwnProperties(secObj, ALLOWED_SECTION_KEYS, `root.sections[${s}]`);
      addBytes(2); // `{}`

      const normalizedSec = {};

      // 章节 heading (可选)
      if (secDesc.heading) {
        const rawHeading = secDesc.heading.value;
        if (typeof rawHeading !== 'string') {
          throw createDocInputError(`Section heading at index ${s} must be a string`, DOC_INPUT_ERROR_CODES.INVALID_TYPE);
        }
        addBytes(Buffer.byteLength('heading', 'utf8') + 3);
        normalizedSec.heading = processString(rawHeading, effectiveLimits.maxCodePointsPerField, `root.sections[${s}].heading`);
      }

      // 章节 paragraphs (可选)
      if (secDesc.paragraphs) {
        const rawParas = secDesc.paragraphs.value;
        trackDepth(4);
        enterObject(rawParas, `root.sections[${s}].paragraphs`);
        inspectArray(rawParas, `root.sections[${s}].paragraphs`);
        if (rawParas.length > effectiveLimits.maxParagraphs - paragraphCount) {
          throw createDocInputError('Total paragraphs exceed limit', DOC_INPUT_ERROR_CODES.PARAGRAPHS_LIMIT_EXCEEDED);
        }

        addBytes(Buffer.byteLength('paragraphs', 'utf8') + 5);

        const normalizedParas = new Array(rawParas.length);
        for (let p = 0; p < rawParas.length; p++) {
          paragraphCount++;
          trackDepth(5);
          const pVal = rawParas[p];
          if (typeof pVal === 'string') {
            normalizedParas[p] = processString(pVal, effectiveLimits.maxCodePointsPerField, `root.sections[${s}].paragraphs[${p}]`);
          } else if (typeof pVal === 'number') {
            if (!Number.isFinite(pVal)) {
              throw createDocInputError(
                `Non-finite number found at root.sections[${s}].paragraphs[${p}]`,
                DOC_INPUT_ERROR_CODES.NON_FINITE_NUMBER
              );
            }
            const pStr = String(pVal);
            addBytes(Buffer.byteLength(pStr, 'utf8'));
            normalizedParas[p] = pVal;
          } else {
            throw createDocInputError(
              `Invalid paragraph type at root.sections[${s}].paragraphs[${p}]: expected string or finite number`,
              DOC_INPUT_ERROR_CODES.INVALID_TYPE
            );
          }
        }

        normalizedSec.paragraphs = normalizedParas;
        exitObject(rawParas);
      }

      // 章节 table (可选)
      if (secDesc.table) {
        const rawTable = secDesc.table.value;
        if (types.isProxy(rawTable)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      if (rawTable === null || typeof rawTable !== 'object' || Array.isArray(rawTable)) {
          throw createDocInputError(`Section table at index ${s} must be a plain object`, DOC_INPUT_ERROR_CODES.INVALID_INPUT);
        }
        addBytes(Buffer.byteLength('table', 'utf8') + 3);
        normalizedSec.table = processTable(rawTable, `root.sections[${s}].table`, 4);
      }

      normalizedSections[s] = normalizedSec;
      exitObject(secObj);
    }

    normalizedDoc.sections = normalizedSections;
    exitObject(rawSections);
  }

  // 5. 可选顶层 table 校验
  if (rootDesc.table) {
    const rawRootTable = rootDesc.table.value;
    if (types.isProxy(rawRootTable)) throw createDocInputError('Proxy input is prohibited', DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED);
      if (rawRootTable === null || typeof rawRootTable !== 'object' || Array.isArray(rawRootTable)) {
      throw createDocInputError('Document root table must be a plain object', DOC_INPUT_ERROR_CODES.INVALID_INPUT);
    }
    addBytes(Buffer.byteLength('table', 'utf8') + 3);
    normalizedDoc.table = processTable(rawRootTable, 'root.table', 2);
  }

  exitObject(value);

  // The incremental bound protects traversal; this exact check includes all
  // commas and JSON escapes before a generator receives the frozen copy.
  const exactBytes = Buffer.byteLength(JSON.stringify(normalizedDoc), 'utf8');
  if (exactBytes > effectiveLimits.maxBytes) {
    throw createDocInputError('Total document UTF-8 input size exceeds limit', DOC_INPUT_ERROR_CODES.BYTES_LIMIT_EXCEEDED);
  }

  // 6. 返回深冻结的规范化副本与纯计数诊断对象
  const diagnostics = Object.freeze({
    totalBytes: exactBytes,
    sectionCount,
    paragraphCount,
    tableCount,
    rowCount,
    cellCount,
    maxDepth: maxDepthObserved,
  });

  return {
    normalized: deepFreeze(normalizedDoc),
    diagnostics,
  };
}

module.exports = {
  guardStructuredDocumentInput,
  DEFAULT_INPUT_LIMITS,
  HARD_INPUT_LIMITS,
  DOC_INPUT_ERROR_CODES,
  countCodePoints,
  resolveLimits,
};
