'use strict';

const { isDeepStrictEqual } = require('node:util');
const { analyzeCsvColumn } = require('../attachments/csv-analysis.cjs');
const { renderCsvExport } = require('./csv.cjs');

const COLUMNS = Object.freeze([
  'record_type', 'source_sha256', 'operation', 'selected_column', 'start_row',
  'result', 'source_row', 'source_coordinate', 'source_value_or_count',
]);

function invalid() {
  return Object.assign(new TypeError('CSV analysis result does not match the selected source'), {
    code: 'CSV_ANALYSIS_RESULT_MISMATCH',
  });
}

const text = value => ({ type: 'text', value });
const decimal = value => ({ type: 'decimal', value: String(value) });
const empty = () => ({ type: 'empty', value: null });

/**
 * Candidate export table for one explicitly selected calculation. Recompute
 * against the authenticated immutable source so a caller cannot substitute a
 * result or provenance from a different attachment. Preserve source values as
 * text: leading zeroes are evidence, not an instruction to coerce a cell.
 */
function buildCsvAnalysisResultTable({ source, analysis } = {}) {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) throw invalid();
  const checked = analyzeCsvColumn(source, {
    operation: analysis.operation,
    column: analysis.column,
    startRow: analysis.startRow,
  });
  if (!isDeepStrictEqual(analysis, checked)) throw invalid();

  const rows = [[
    text('summary'), text(source.sha256), text(checked.operation),
    decimal(checked.column), decimal(checked.startRow), decimal(checked.result),
    empty(), empty(), decimal(checked.valueCount),
  ]];
  for (let index = checked.startRow - 1; index < source.rows.length; index += 1) {
    const row = source.rows[index];
    const cell = row[checked.column - 1];
    const kind = !cell ? 'missing' : cell.value === '' ? 'empty' : 'included';
    rows.push([
      text(kind), text(source.sha256), text(checked.operation),
      decimal(checked.column), decimal(checked.startRow), empty(),
      decimal(index + 1), cell ? text(`L${cell.sourceLine}C${cell.sourceColumn}`) : empty(),
      cell ? text(cell.value) : empty(),
    ]);
  }
  return { columns: COLUMNS, rows };
}

function renderCsvAnalysisResultCandidate(input) {
  return renderCsvExport(buildCsvAnalysisResultTable(input));
}

module.exports = { COLUMNS, buildCsvAnalysisResultTable, renderCsvAnalysisResultCandidate };
