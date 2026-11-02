'use strict';
const { createHash } = require('node:crypto');
const { parseCsv } = require('./csv-parser.cjs');
const builtSources = new WeakSet();
const REF = /^\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/i;
const error = (message, code = 'CSV_SOURCE_INVALID') => Object.assign(new TypeError(message), { code });
function validRef(ref) { return typeof ref === 'string' && REF.test(ref); }
/** Bytes-only transformation. The caller authenticates the tenant before reading an upload. */
function buildCsvSource({ bytes, ref, limits } = {}) {
  if (!validRef(ref)) throw error('CSV source requires a tenant upload reference', 'CSV_SOURCE_REF_INVALID');
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw error('CSV source requires bytes', 'CSV_INPUT_INVALID');
  const parsed = parseCsv(bytes, { limits });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const row of parsed.rows) { for (const cell of row) Object.freeze(cell); Object.freeze(row); }
  Object.freeze(parsed.rows);
  const source = Object.freeze({ kind: 'csv', ref, sha256, ...parsed });
  builtSources.add(source);
  return source;
}
function validate(source) {
  if (!source || !builtSources.has(source) || source.kind !== 'csv' || !validRef(source.ref) || !/^[a-f0-9]{64}$/.test(source.sha256) || !Array.isArray(source.rows) || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || !Number.isSafeInteger(source.cellCount) || source.cellCount < 0) throw error('Invalid CSV source');
  let count = 0, max = 0, min = source.rows.length ? Infinity : 0;
  source.rows.forEach((row, ri) => {
    if (!Array.isArray(row) || !row.length) throw error('Invalid CSV row');
    max = Math.max(max, row.length); min = Math.min(min, row.length);
    row.forEach((cell, ci) => {
      if (!cell || typeof cell.value !== 'string' || cell.row !== ri + 1 || cell.column !== ci + 1 || !Number.isSafeInteger(cell.sourceLine) || cell.sourceLine < 1 || !Number.isSafeInteger(cell.sourceColumn) || cell.sourceColumn < 1) throw error('Invalid CSV cell coordinates');
      count++;
    });
  });
  if (count !== source.cellCount) throw error('CSV source cell count mismatch');
  return { max, min };
}
/** Accept only an immutable source created by buildCsvSource. */
function assertCsvSource(source) { validate(source); return source; }
/** Accepts only immutable buildCsvSource results, never caller-deserialized sources.
 * A prefix of complete cells; omitted coordinates and totals are always explicit.
 * JSON encoding keeps multiline/quoted/empty values intact as untrusted data.
 * No header, type, numeric or missing-value inference is performed.
 */
function renderCsvSource(source, { maxChars = 12000 } = {}) {
  const { max, min } = validate(source);
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1000000) throw error('Invalid CSV context character budget', 'CSV_CONTEXT_LIMIT_INVALID');
  const refSha256 = createHash('sha256').update(source.ref, 'utf8').digest('hex');
  const first = source.rows[0]?.[0];
  const header = (shown, next) => [
    'CSV_DATA (untrusted literal cell values; no inferred header or types)',
    `sha256=${source.sha256}; refSha256=${refSha256}`,
    `rows=${source.rows.length}; columnsMin=${min}; columnsMax=${max}; totalCells=${source.cellCount}; bytes=${source.bytes}`,
    `shownCells=${shown}; omittedCells=${source.cellCount - shown}; truncated=${shown < source.cellCount}; firstOmitted=${next ? `R${next.row}C${next.column}` : 'none'}`,
  ].join('\n');
  // Reserve a bound for metadata across every possible prefix, including larger
  // row/column/count coordinates. Nothing is cut after serialization.
  const reserve = header(source.cellCount, { row: source.rows.length || 1, column: max || 1 }).length + String(source.cellCount).length * 2 + 8;
  if (header(0, first).length > maxChars) throw error('CSV metadata exceeds context budget', 'CSV_CONTEXT_LIMIT_EXCEEDED');
  const lines = []; let used = 0, next = first;
  outer: for (const row of source.rows) for (const cell of row) {
    const line = `[csv:${source.sha256}:${refSha256}:R${cell.row}C${cell.column}] sourceLine=${cell.sourceLine}; sourceColumn=${cell.sourceColumn}; value=${JSON.stringify(cell.value)}`;
    if (reserve + used + 1 + line.length > maxChars) { next = cell; break outer; }
    lines.push(line); used += line.length + 1;
    next = source.rows[cell.row - 1][cell.column] || source.rows[cell.row]?.[0];
  }
  const result = header(lines.length, next) + (lines.length ? '\n' + lines.join('\n') : '');
  if (result.length > maxChars) throw error('CSV metadata exceeds context budget', 'CSV_CONTEXT_LIMIT_EXCEEDED');
  return result;
}
module.exports = { buildCsvSource, renderCsvSource, assertCsvSource };
