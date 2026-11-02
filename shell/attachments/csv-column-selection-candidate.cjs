'use strict';
/**
 * shell/attachments/csv-column-selection-candidate.cjs
 * ============================================================================
 * F2 CSV 列选择与类型证据候选模块（纯函数隔离候选）
 * 契约规范：docs/refactor/GEMINI-F2-CSV-COLUMN-SELECTION-PACKAGE-20261026.md
 *
 * 职责：
 *   在用户上传 CSV 后，根据用户显式给出的 { headerRow, startRow, column } 选择，
 *   提供不可变、有限、可序列化的选择预览与列证据诊断。
 *
 * 关键规则与边界：
 *   1. 必须使用经 assertCsvSource 校验通过的不可变 CSV source。
 *   2. 显式选择校验：
 *      - headerRow：null（无表头）或 1-based 正整数；
 *      - startRow、column：必须为 1-based 正整数；
 *      - 若指定表头，严格要求 headerRow < startRow；
 *      - 表头单元格仅作显示标签来源，绝不计入数据运算和类型扫描。
 *   3. 列存在性：所选 column 必须在所选数据区间（startRow 至末行）至少出现一次。
 *   4. 严格区分：缺失单元格（ragged）、空字符串（""）与数值零（"0"）。
 *   5. 保守类型推断：
 *      - 有效 ISO 8601 日期标为 iso_date；
 *      - 仅无歧义的标准十进制数（无前导零、无歧义千分位）标为 decimal；
 *      - 斜杠日期、无效日期标为 text（reason: ambiguous_date 或 untyped_text）；
 *      - 区域千分位分组歧义（如 1.234）标为 text（reason: ambiguous_grouping）；
 *      - 前导零数字（如 001）标为 text（reason: untyped_text）；
 *      - 混合类型标为 text（reason: mixed）；
 *      - 全空数据列标为 empty（reason: null）。
 *   6. 错误脱敏：错误信息绝不回显原始单元格数据、文件路径或敏感参数。
 *   7. 纯诊断预览：绝不进行单元格类型强转或导出类型授权。
 * ============================================================================
 */

const { assertCsvSource } = require('./csv-source.cjs');

const MAX_SAMPLES = 3;
const MAX_SAMPLE_CODEPOINTS = 80;

// 与 csv-analysis.cjs 保持一致的区域千分位分组歧义检测
// 常见 1-3 位前置数字 + 恰好 3 位小数的形态（如 1.234、12.345），在无区域元数据时无法确定是千分位还是小数
const AMBIGUOUS_DOT_GROUPING = /^[+-]?[1-9][0-9]{0,2}\.[0-9]{3}$/;

function invalid(message, code = 'CSV_SELECTION_INVALID') {
  return Object.assign(new TypeError(message), { code });
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function evidenceType(value) {
  if (AMBIGUOUS_DOT_GROUPING.test(value)) return 'ambiguous_grouping';
  // 严格无歧义十进制（允许负号，不允许无小数点的多前导零如 001）
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return 'decimal';
  if (validIsoDate(value)) return 'iso_date';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return 'ambiguous_date';
  return 'text';
}

function sampleValue(value) {
  const codepoints = Array.from(value);
  return {
    value: codepoints.slice(0, MAX_SAMPLE_CODEPOINTS).join(''),
    truncated: codepoints.length > MAX_SAMPLE_CODEPOINTS,
  };
}

/**
 * 显式校验并提取指定列在数据区间的证据与预览信息
 *
 * @param {Object} source - 由 buildCsvSource 生成且通过 assertCsvSource 校验的不可变源
 * @param {Object} selection - 显式选择坐标
 * @param {number|null} selection.headerRow - 表头所在行号（1-based），无表头传 null
 * @param {number} selection.startRow - 数据起始行号（1-based）
 * @param {number} selection.column - 选择的列号（1-based）
 * @returns {Readonly<Object>} 包含坐标、标签、样本、类型诊断的只读对象
 */
function selectCsvColumn(source, selection = {}) {
  assertCsvSource(source);

  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw invalid('Selection configuration must be an object');
  }

  const { headerRow, startRow, column } = selection;

  // 1. 校验 headerRow
  if (headerRow !== null) {
    if (!Number.isSafeInteger(headerRow) || headerRow < 1) {
      throw invalid('headerRow must be null or a positive 1-based integer');
    }
  }

  // 2. 校验 startRow
  if (!Number.isSafeInteger(startRow) || startRow < 1) {
    throw invalid('startRow must be a positive 1-based integer');
  }

  // 3. 校验 column
  if (!Number.isSafeInteger(column) || column < 1) {
    throw invalid('column must be a positive 1-based integer');
  }

  const totalRows = source.rows.length;

  // 4. 行数范围校验
  if (headerRow !== null) {
    if (headerRow > totalRows) {
      throw invalid('headerRow exceeds CSV total row count', 'CSV_SELECTION_OUT_OF_BOUNDS');
    }
    if (headerRow >= startRow) {
      throw invalid('headerRow must be strictly less than startRow');
    }
  }

  if (startRow > totalRows) {
    throw invalid('startRow exceeds CSV total row count; data range is empty', 'CSV_SELECTION_OUT_OF_BOUNDS');
  }

  // 5. 校验所选列是否在所选数据区间内至少出现一次
  let appearedInData = false;
  for (let r = startRow; r <= totalRows; r++) {
    const row = source.rows[r - 1];
    if (column <= row.length) {
      appearedInData = true;
      break;
    }
  }
  if (!appearedInData) {
    throw invalid('Selected column does not appear in any data row within the selected range', 'CSV_SELECTION_COLUMN_OUT_OF_BOUNDS');
  }

  // 6. 确定列标签（表头或 C<n>）
  let columnLabel = `C${column}`;
  let labelSource = 'index';
  let headerCellInfo = null;

  if (headerRow !== null) {
    const hRow = source.rows[headerRow - 1];
    if (column <= hRow.length) {
      const hCell = hRow[column - 1];
      const trimmed = hCell.value.trim();
      if (trimmed !== '') {
        const sampled = sampleValue(trimmed);
        columnLabel = sampled.value;
        labelSource = 'header';
      }
      headerCellInfo = Object.freeze({
        row: hCell.row,
        column: hCell.column,
        sourceLine: hCell.sourceLine,
        sourceColumn: hCell.sourceColumn,
        ...sampleValue(hCell.value),
      });
    }
  }

  // 7. 扫描数据区间（严格从 startRow 至末行，绝不将表头作为运算/类型输入）
  const dataRowCount = totalRows - startRow + 1;
  let present = 0;
  let missing = 0;
  let empty = 0;
  let nonempty = 0;
  const kinds = new Set();
  const samples = [];

  for (let r = startRow; r <= totalRows; r++) {
    const row = source.rows[r - 1];
    if (column > row.length) {
      // 稀疏行缺失
      missing++;
      continue;
    }

    const cell = row[column - 1];
    present++;

    if (cell.value === '') {
      empty++;
      continue;
    }

    nonempty++;
    kinds.add(evidenceType(cell.value));

    if (samples.length < MAX_SAMPLES) {
      samples.push(Object.freeze({
        row: cell.row,
        column: cell.column,
        sourceLine: cell.sourceLine,
        sourceColumn: cell.sourceColumn,
        ...sampleValue(cell.value),
      }));
    }
  }

  // 8. 归纳证据类型与原因
  const kindsList = Array.from(kinds);
  let type = 'text';
  let reason = null;

  if (kindsList.length === 0) {
    type = 'empty';
    reason = null;
  } else if (kindsList.length === 1 && (kindsList[0] === 'decimal' || kindsList[0] === 'iso_date')) {
    type = kindsList[0];
    reason = null;
  } else {
    type = 'text';
    if (kinds.has('ambiguous_date')) {
      reason = 'ambiguous_date';
    } else if (kinds.has('ambiguous_grouping')) {
      reason = 'ambiguous_grouping';
    } else if (kindsList.length > 1) {
      reason = 'mixed';
    } else {
      reason = 'untyped_text';
    }
  }

  return Object.freeze({
    sourceSha256: source.sha256,
    selection: Object.freeze({
      headerRow,
      startRow,
      column,
    }),
    columnLabel,
    labelSource,
    header: headerCellInfo,
    dataRowCount,
    present,
    missing,
    empty,
    nonempty,
    type,
    reason,
    samples: Object.freeze(samples),
  });
}

/**
 * 将选择预览结果格式化为有界上下文文本（供前端/Agent 诊断引用）
 */
function renderCsvColumnSelection(selectionResult, { maxChars = 2000 } = {}) {
  if (!selectionResult || typeof selectionResult !== 'object' || !selectionResult.selection) {
    throw invalid('Invalid selection result object');
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1000000) {
    throw invalid('Context budget is invalid');
  }

  const payload = JSON.stringify(selectionResult, null, 2);
  const header = [
    'CSV_COLUMN_SELECTION (preview only; labels and samples are untrusted; no cell conversion)',
    `sha256=${selectionResult.sourceSha256}; label=${JSON.stringify(selectionResult.columnLabel)}; type=${selectionResult.type}; reason=${selectionResult.reason || 'none'}`,
    `dataRowCount=${selectionResult.dataRowCount}; present=${selectionResult.present}; missing=${selectionResult.missing}; empty=${selectionResult.empty}; nonempty=${selectionResult.nonempty}`,
  ].join('\n');

  const combined = `${header}\n${payload}`;
  if (combined.length <= maxChars) {
    return combined;
  }

  // 截断保护
  const brief = `${header}\n${JSON.stringify({
    sourceSha256: selectionResult.sourceSha256,
    selection: selectionResult.selection,
    columnLabel: selectionResult.columnLabel,
    type: selectionResult.type,
    reason: selectionResult.reason,
    truncatedPayload: true,
  })}`;

  if (brief.length > maxChars) {
    throw invalid('Selection metadata exceeds context budget');
  }
  return brief;
}

module.exports = {
  selectCsvColumn,
  renderCsvColumnSelection,
  validIsoDate,
  evidenceType,
  sampleValue,
  MAX_SAMPLES,
  MAX_SAMPLE_CODEPOINTS,
};
