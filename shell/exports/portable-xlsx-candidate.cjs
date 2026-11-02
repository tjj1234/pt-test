'use strict';
/**
 * shell/exports/portable-xlsx-candidate.cjs
 * ============================================================================
 * 可移植 XLSX 产物生成候选模块 (Portable XLSX Generator Candidate)
 * 契约规范：docs/refactor/GEMINI-PORTABLE-XLSX-PACKAGE-20261101.md
 *
 * 职责：
 *   接收结构化表格输入（sheets 数组，每 sheet 含 name 与二维 cells 数组），
 *   使用 shell 锁定的纯 JS 依赖（fflate）直接生成标准、紧凑、免外部依赖的 OOXML (.xlsx)。
 *   彻底剥离对 analytics/business 中 SheetJS (xlsx) 的路径依赖，支持独立归档运行。
 *
 * 核心安全与设计约束：
 *   1. 纯生成能力：无文件系统写入副作用，输入深度不可变；
 *   2. 前置资源边界（Reject-before-Scan）：
 *      - 显式公开 schema 与上限，数组在遍历前先做 O(1) length 检查；
 *      - 严格校验 sheet 数量、行数、列数、总单元格数、字符串长度与输出字节数；
 *   3. 强类型与无猜测：
 *      - 单元格仅接受 string / finite number / boolean / null / undefined；
 *      - 严禁将数字字符串猜测为数值或日期（"123" 保持为 inlineStr）；
 *      - 遇到 NaN、Infinity、非法 XML 控制字符、重复或非法工作表名立即拒绝；
 *   4. 公式注入防御与零可执行内容：
 *      - 字符串单元格以 inlineStr 存储，不生成外部共享字符串表；
 *      - 对以 `=+\-@\t\r` 开头的潜在公式字符串自动前缀单引号转义，并记入 degradations；
 *      - 严禁生成 `<f>` 公式节点、宏（VBA）、外部超链接或隐藏执行流；
 *   5. 可靠依赖：
 *      - 严格仅从 shell 锁定依赖解析 fflate，严禁从 cwd 或 NODE_PATH 回退。
 * ============================================================================
 */

const { createHash } = require('node:crypto');
const path = require('node:path');

// 严格受限解析 fflate
let _fflate = null;
function getFflate() {
  if (_fflate) return _fflate;
  try {
    // Only the shipped shell installation is a dependency authority.
    _fflate = require(path.join(__dirname, '..', 'node_modules', 'fflate'));
    return _fflate;
  } catch (err) {
    const error = new Error('Locked dependency fflate cannot be resolved from shell directory');
    error.code = 'DEPENDENCY_MISSING';
    error.cause = err;
    throw error;
  }
}

// 默认限制与硬上限
const PORTABLE_XLSX_LIMITS = Object.freeze({
  maxSheets: 10,
  maxRows: 10000,
  maxCols: 100,
  maxCells: 50000,
  maxStringLength: 32767,
  maxTextBytes: 4 * 1024 * 1024,
  maxBytes: 10 * 1024 * 1024, // 10 MB
});

const HARD_CEILINGS = Object.freeze({
  maxSheets: 64,
  maxRows: 50000,
  maxCols: 1024,
  maxCells: 50000,
  maxStringLength: 32767,
  maxTextBytes: 4 * 1024 * 1024,
  maxBytes: 50 * 1024 * 1024, // 50 MB
});

const PORTABLE_XLSX_SCHEMA = Object.freeze({
  type: 'object',
  required: ['sheets'],
  properties: {
    title: { type: 'string', maxLength: 256 },
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'cells'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 31 },
          cells: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: ['string', 'number', 'boolean', 'null'] },
            },
          },
        },
      },
    },
  },
});

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 列索引转字母 (0 -> A, 25 -> Z, 26 -> AA)
 */
function colToLetters(colIndex) {
  let letters = '';
  let temp = colIndex;
  while (temp >= 0) {
    letters = String.fromCharCode((temp % 26) + 65) + letters;
    temp = Math.floor(temp / 26) - 1;
  }
  return letters;
}

/**
 * XML 字符转义
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 非法 XML 控制字符校验正则 (保留 \t=0x09, \n=0x0A, \r=0x0D)
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

function invalidXmlText(value) {
  if (INVALID_XML_CHARS.test(value)) return true;
  for (const character of value) {
    const cp=character.codePointAt(0);
    if ((cp>=0xd800&&cp<=0xdfff)||cp===0xfffe||cp===0xffff) return true;
  }
  return false;
}

// 非法工作表名字符 (Excel 规定不得包含 :\/?*[] 或以单引号开头/结尾)
const INVALID_SHEET_NAME_CHARS = /[:\\/?*\[\]]/;

// 公式注入前缀探测
const FORMULA_INJECTION_PREFIX = /^[\=\+\-\@\t\r]/;

/**
 * 规范化并校验 limits
 */
function resolveLimits(customLimits) {
  const resolved = { ...PORTABLE_XLSX_LIMITS };
  if (customLimits !== undefined) {
    if (!customLimits || typeof customLimits !== 'object' || Array.isArray(customLimits)) throw fail('LIMIT_INVALID','Export limits are invalid');
    for (const key of Object.keys(customLimits)) {
      if (!Object.hasOwn(PORTABLE_XLSX_LIMITS,key) || !Number.isSafeInteger(customLimits[key]) || customLimits[key] <= 0 || customLimits[key] > HARD_CEILINGS[key]) throw fail('LIMIT_INVALID','Export limits are invalid');
      resolved[key] = customLimits[key];
    }
  }
  return resolved;
}

/**
 * 生成可移植标准 XLSX 二进制内容
 *
 * @param {object} input - 结构化表格输入
 * @param {object} [limits] - 自定义限制
 * @returns {{ buffer: Buffer, mimeType: string, bytes: number, sha256: string, degradations: object[] }}
 */
function generatePortableXlsx(input, limits) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('INVALID_INPUT', 'Input must be a non-null object');
  }

  const effectiveLimits = resolveLimits(limits);
  const degradations = [];

  // 1. 数组长度前置检查 (Reject-before-Scan)
  const rawSheets = input.sheets;
  if (!Array.isArray(rawSheets)) {
    throw fail('INVALID_INPUT', 'input.sheets must be an array');
  }
  if (rawSheets.length === 0) {
    throw fail('EMPTY_SHEETS', 'At least one sheet is required');
  }
  if (rawSheets.length > effectiveLimits.maxSheets) {
    throw fail('SHEET_LIMIT_EXCEEDED', `Sheet count exceeds limit (${effectiveLimits.maxSheets})`);
  }

  const seenSheetNames = new Set();
  let totalCellCount = 0, totalTextBytes = 0;
  const validatedSheets = [];

  for (let sIdx = 0; sIdx < rawSheets.length; sIdx++) {
    const s = rawSheets[sIdx];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw fail('INVALID_SHEET', `Sheet at index ${sIdx} must be a plain object`);
    }

    // 校验工作表名称
    const sheetName = s.name;
    if (typeof sheetName !== 'string' || sheetName.length === 0 || sheetName.length > 31) {
      throw fail('INVALID_SHEET_NAME', `Sheet name must be a string between 1 and 31 characters`);
    }
    if (invalidXmlText(sheetName)) throw fail("INVALID_XML_CHARACTER","Sheet name has invalid XML text");
    if (INVALID_SHEET_NAME_CHARS.test(sheetName) || sheetName.startsWith("'") || sheetName.endsWith("'")) {
      throw fail('INVALID_SHEET_NAME_CHARACTERS', `Sheet name "${sheetName}" contains illegal characters`);
    }
    const lowerName = sheetName.toLowerCase();
    if (seenSheetNames.has(lowerName)) {
      throw fail('DUPLICATE_SHEET_NAME', `Duplicate sheet name "${sheetName}"`);
    }
    seenSheetNames.add(lowerName);

    // 校验二维 cells 数组 (前置 O(1) 检查)
    const rawRows = s.cells;
    if (!Array.isArray(rawRows)) {
      throw fail('INVALID_SHEET_CELLS', `cells for sheet "${sheetName}" must be a 2D array`);
    }
    if (rawRows.length > effectiveLimits.maxRows) {
      throw fail('ROW_LIMIT_EXCEEDED', `Row count for sheet "${sheetName}" exceeds limit (${effectiveLimits.maxRows})`);
    }

    const validatedRows = [];
    for (let rIdx = 0; rIdx < rawRows.length; rIdx++) {
      const row = rawRows[rIdx];
      if (!Array.isArray(row)) {
        throw fail('INVALID_ROW', `Row at index ${rIdx} in sheet "${sheetName}" must be an array`);
      }
      if (row.length > effectiveLimits.maxCols) {
        throw fail('COL_LIMIT_EXCEEDED', `Col count in sheet "${sheetName}" exceeds limit (${effectiveLimits.maxCols})`);
      }

      totalCellCount += row.length;
      if (totalCellCount > effectiveLimits.maxCells) {
        throw fail('CELL_LIMIT_EXCEEDED', `Total cell count exceeds limit (${effectiveLimits.maxCells})`);
      }

      const validatedCells = [];
      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const val = row[cIdx];
        const cellCoord = `${colToLetters(cIdx)}${rIdx + 1}`;

        if (val === null) {
          validatedCells.push({ type: 'empty', coord: cellCoord });
          continue;
        }

        if (typeof val === 'number') {
          if (!Number.isFinite(val)) {
            throw fail('INVALID_CELL_VALUE', `Cell ${cellCoord} has non-finite number value (NaN or Infinity)`);
          }
          validatedCells.push({ type: 'n', val, coord: cellCoord });
          continue;
        }

        if (typeof val === 'boolean') {
          validatedCells.push({ type: 'b', val: val ? 1 : 0, coord: cellCoord });
          continue;
        }

        if (typeof val === 'string') {
          if (val.length > effectiveLimits.maxStringLength) {
            throw fail('STRING_LENGTH_EXCEEDED', `Cell ${cellCoord} string exceeds limit (${effectiveLimits.maxStringLength})`);
          }
          if (invalidXmlText(val)) {
            throw fail('INVALID_XML_CHARACTER', `Cell ${cellCoord} contains illegal XML control characters`);
          }

          totalTextBytes += Buffer.byteLength(val,'utf8');
          if (totalTextBytes > effectiveLimits.maxTextBytes) throw fail('TEXT_LIMIT_EXCEEDED','Workbook text exceeds limit');

          // 公式注入防范：针对以 = + - @ \t \r 开头的字符串添加前导单引号
          let safeStr = val;
          if (FORMULA_INJECTION_PREFIX.test(val)) {
            safeStr = `'${val}`;
            degradations.push({
              kind: 'formula-escape',
              sheet: sheetName,
              cell: cellCoord,
              original: val,
            });
          }

          validatedCells.push({ type: 'inlineStr', val: safeStr, coord: cellCoord });
          continue;
        }

        throw fail('INVALID_CELL_VALUE', `Cell ${cellCoord} has unsupported value type: ${typeof val}`);
      }
      validatedRows.push(validatedCells);
    }

    validatedSheets.push({
      name: sheetName,
      rows: validatedRows,
    });
  }

  // 2. 组装符合 ECMA-376 标准的最小 OOXML 结构
  const fflate = getFflate();
  const zipFiles = {};

  // [Content_Types].xml
  let sheetTypesXml = '';
  for (let i = 1; i <= validatedSheets.length; i++) {
    sheetTypesXml += `  <Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`;
  }
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n${sheetTypesXml}</Types>`;
  zipFiles['[Content_Types].xml'] = fflate.strToU8(contentTypesXml);

  // _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n</Relationships>`;
  zipFiles['_rels/.rels'] = fflate.strToU8(rootRelsXml);

  // xl/_rels/workbook.xml.rels
  let wbRelsEntries = '';
  for (let i = 1; i <= validatedSheets.length; i++) {
    wbRelsEntries += `  <Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>\n`;
  }
  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${wbRelsEntries}</Relationships>`;
  zipFiles['xl/_rels/workbook.xml.rels'] = fflate.strToU8(wbRelsXml);

  // xl/workbook.xml
  let sheetsEntries = '';
  for (let i = 1; i <= validatedSheets.length; i++) {
    const sName = escapeXml(validatedSheets[i - 1].name);
    sheetsEntries += `    <sheet name="${sName}" sheetId="${i}" r:id="rId${i}"/>\n`;
  }
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <sheets>\n${sheetsEntries}  </sheets>\n</workbook>`;
  zipFiles['xl/workbook.xml'] = fflate.strToU8(workbookXml);

  // xl/worksheets/sheetN.xml
  for (let i = 1; i <= validatedSheets.length; i++) {
    const s = validatedSheets[i - 1];
    let sheetDataXml = '  <sheetData>\n';

    for (let rIdx = 0; rIdx < s.rows.length; rIdx++) {
      const row = s.rows[rIdx];
      if (row.length === 0) continue;

      let rowCellsXml = '';
      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const cell = row[cIdx];
        if (cell.type === 'empty') continue;

        if (cell.type === 'n') {
          rowCellsXml += `<c r="${cell.coord}" t="n"><v>${cell.val}</v></c>`;
        } else if (cell.type === 'b') {
          rowCellsXml += `<c r="${cell.coord}" t="b"><v>${cell.val}</v></c>`;
        } else if (cell.type === 'inlineStr') {
          rowCellsXml += `<c r="${cell.coord}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.val)}</t></is></c>`;
        }
      }

      if (rowCellsXml.length > 0) {
        sheetDataXml += `    <row r="${rIdx + 1}">${rowCellsXml}</row>\n`;
      }
    }
    sheetDataXml += '  </sheetData>\n';

    const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n${sheetDataXml}</worksheet>`;
    zipFiles[`xl/worksheets/sheet${i}.xml`] = fflate.strToU8(worksheetXml);
  }

  // 3. 执行同步压缩包装
  const rawZipped = fflate.zipSync(zipFiles);
  const buffer = Buffer.from(rawZipped);

  if (buffer.length > effectiveLimits.maxBytes) {
    throw fail('BYTE_LIMIT_EXCEEDED', `Generated XLSX size exceeds limit (${effectiveLimits.maxBytes})`);
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: buffer.length,
    sha256,
    degradations: Object.freeze(degradations),
  };
}

module.exports = {
  generatePortableXlsx,
  PORTABLE_XLSX_LIMITS,
  PORTABLE_XLSX_SCHEMA,
};
