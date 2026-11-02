'use strict';

// Deterministic output for an explicitly typed table. CSV has no cell types:
// date cells are emitted as ISO date text; an XLSX writer needs a separate
// numeric date cell and number format contract.
const MAX_CELLS = 100_000;
const MAX_BYTES = 20 * 1024 * 1024;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(code) { return Object.assign(new TypeError(code), { code }); }

function validDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function safeText(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid('CSV_TEXT_INVALID');
  // Spreadsheet importers may execute formula-looking CSV fields even when
  // they are quoted. The leading apostrophe makes an untrusted text cell literal.
  return /^[\s\uFEFF]*[=+\-@]/u.test(value) ? "'" + value : value;
}

function cellText(cell) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw invalid('CSV_CELL_INVALID');
  const { type, value } = cell;
  if (type === 'empty' && value === null) return '';
  if (type === 'text') return safeText(value);
  if (type === 'decimal' && typeof value === 'string' && DECIMAL.test(value)) return value;
  if (type === 'date' && typeof value === 'string' && validDate(value)) return value;
  throw invalid('CSV_CELL_INVALID');
}

function quote(value) { return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value; }

function renderCsvExport({ columns, rows } = {}) {
  if (!Array.isArray(columns) || !columns.length || columns.length > 16_384 ||
      !columns.every((name) => typeof name === 'string' && name.length && !name.includes('\0')) ||
      !Array.isArray(rows) || rows.length * columns.length > MAX_CELLS) throw invalid('CSV_TABLE_INVALID');
  const lines = [columns.map((name) => quote(safeText(name))) .join(',')];
  let bytes = Buffer.byteLength(lines[0], 'utf8') + 2;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw invalid('CSV_ROW_INVALID');
    const line = row.map((cell) => quote(cellText(cell))).join(',');
    bytes += Buffer.byteLength(line, 'utf8') + 2;
    if (bytes > MAX_BYTES) throw invalid('CSV_EXPORT_LIMIT_EXCEEDED');
    lines.push(line);
  }
  if (bytes > MAX_BYTES) throw invalid('CSV_EXPORT_LIMIT_EXCEEDED');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { renderCsvExport };
