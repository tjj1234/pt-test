'use strict';

const { assertCsvSource } = require('./csv-source.cjs');

const MAX_ANALYSIS_ROWS = 10_000;
const MAX_DECIMAL_DIGITS = 128;
const MAX_DECIMAL_SCALE = 18;
const OPERATIONS = new Set(['sum', 'count', 'min', 'max']);
const NUMERIC = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/;
// With no locale metadata, `1.234` can mean either a decimal or a grouped
// integer. Reject the common 1-3 digit + exactly-three-digit shape; values
// such as `0.125` and `1234.567` remain unambiguous under the dot-decimal rule.
const AMBIGUOUS_DOT_GROUPING = /^[+-]?[1-9][0-9]{0,2}\.[0-9]{3}$/;

function invalid(message, code = 'CSV_ANALYSIS_INVALID') {
  return Object.assign(new TypeError(message), { code });
}

function parseDecimal(value, cell) {
  if (AMBIGUOUS_DOT_GROUPING.test(value)) {
    throw invalid(`CSV value at R${cell.row}C${cell.column} has an ambiguous regional separator`, 'CSV_ANALYSIS_VALUE_INVALID');
  }
  const match = NUMERIC.exec(value);
  const fraction = match?.[3] || '';
  const digits = match ? match[2] + fraction : '';
  if (!match || digits.length > MAX_DECIMAL_DIGITS || fraction.length > MAX_DECIMAL_SCALE) {
    throw invalid(`CSV value at R${cell.row}C${cell.column} is not a supported unit-free decimal`, 'CSV_ANALYSIS_VALUE_INVALID');
  }
  const coefficient = BigInt(`${match[1]}${digits}`);
  return { coefficient, scale: fraction.length };
}

function align(value, scale) { return value.coefficient * (10n ** BigInt(scale - value.scale)); }

function decimalText(coefficient, scale) {
  if (coefficient === 0n) return '0';
  let digits = (coefficient < 0n ? -coefficient : coefficient).toString();
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  if (scale) {
    if (digits.length <= scale) digits = `${'0'.repeat(scale + 1 - digits.length)}${digits}`;
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return `${coefficient < 0n ? '-' : ''}${digits}`;
}

/**
 * Deterministic, explicit-column calculation on an immutable uploaded CSV.
 * Rows and columns are 1-based. No header, unit, date, locale, or formula inference occurs.
 * Empty strings are skipped; duplicate rows are distinct observations.
 */
function analyzeCsvColumn(source, { operation, column, startRow = 1 } = {}) {
  assertCsvSource(source);
  if (!OPERATIONS.has(operation)) throw invalid('Unsupported CSV analysis operation', 'CSV_ANALYSIS_OPERATION_INVALID');
  if (!Number.isSafeInteger(column) || column < 1) throw invalid('CSV analysis column must be a positive 1-based integer', 'CSV_ANALYSIS_SELECTOR_INVALID');
  if (!Number.isSafeInteger(startRow) || startRow < 1) throw invalid('CSV analysis startRow must be a positive 1-based integer', 'CSV_ANALYSIS_SELECTOR_INVALID');
  if (source.rows.length > MAX_ANALYSIS_ROWS) throw invalid(`CSV analysis exceeds ${MAX_ANALYSIS_ROWS} rows`, 'CSV_ANALYSIS_LIMIT_EXCEEDED');

  const values = [];
  const sources = [];
  const ignoredEmpty = [];
  const missingRows = [];
  let maxScale = 0;
  for (let rowIndex = startRow - 1; rowIndex < source.rows.length; rowIndex += 1) {
    const cell = source.rows[rowIndex][column - 1];
    if (!cell) { missingRows.push(rowIndex + 1); continue; } // Ragged rows have no cell at this coordinate.
    if (cell.value === '') {
      ignoredEmpty.push({ row: cell.row, column: cell.column, sourceLine: cell.sourceLine, sourceColumn: cell.sourceColumn });
      continue;
    }
    const value = parseDecimal(cell.value, cell);
    values.push(value);
    sources.push({ row: cell.row, column: cell.column, sourceLine: cell.sourceLine, sourceColumn: cell.sourceColumn });
    maxScale = Math.max(maxScale, value.scale);
  }
  if (!values.length) throw invalid('CSV analysis found no numeric values in the selected range', 'CSV_ANALYSIS_NO_VALUES');

  let result;
  if (operation === 'count') result = String(values.length);
  else if (operation === 'sum') result = decimalText(values.reduce((total, value) => total + align(value, maxScale), 0n), maxScale);
  else {
    let selected = values[0];
    for (const value of values.slice(1)) {
      const comparison = align(value, maxScale) - align(selected, maxScale);
      if ((operation === 'min' && comparison < 0n) || (operation === 'max' && comparison > 0n)) selected = value;
    }
    result = decimalText(align(selected, maxScale), maxScale);
  }
  return Object.freeze({
    operation, column, startRow, result, valueCount: values.length,
    sources: Object.freeze(sources.map(Object.freeze)),
    ignoredEmpty: Object.freeze(ignoredEmpty.map(Object.freeze)),
    missingRows: Object.freeze(missingRows),
  });
}

module.exports = { MAX_ANALYSIS_ROWS, MAX_DECIMAL_DIGITS, MAX_DECIMAL_SCALE, analyzeCsvColumn };
