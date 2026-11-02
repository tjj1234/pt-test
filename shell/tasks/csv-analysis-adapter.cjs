'use strict';

const { assertCsvSource } = require('../attachments/csv-source.cjs');
const { analyzeCsvColumn } = require('../attachments/csv-analysis.cjs');

const OPERATIONS = new Set(['sum', 'count', 'min', 'max']);
const SELECTOR_FIELDS = new Set(['sourceSha256', 'operation', 'column', 'startRow']);

function invalid(code, message) {
  return Object.assign(new TypeError(message), { code });
}

/**
 * Adapt an authenticated immutable CSV source into a JSON-safe analysis result.
 * The host must authenticate the upload and select the current attachment before
 * passing its buildCsvSource result. The requested source digest prevents a
 * stale selection from silently running against a different upload. No header,
 * column name, type, date, or locale inference occurs here.
 */
function adaptCsvAnalysis({ source, selection } = {}) {
  assertCsvSource(source);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).some((key) => !SELECTOR_FIELDS.has(key))) {
    throw invalid('CSV_ANALYSIS_SELECTOR_INVALID', 'CSV selection must contain only supported fields');
  }
  const { sourceSha256, operation, column, startRow } = selection;
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw invalid('CSV_ANALYSIS_SOURCE_INVALID', 'CSV selection requires a source digest');
  }
  if (sourceSha256 !== source.sha256) {
    throw invalid('CSV_ANALYSIS_SOURCE_CHANGED', 'Selected CSV source changed');
  }
  if (!OPERATIONS.has(operation) || !Number.isSafeInteger(column) || column < 1 ||
      !Number.isSafeInteger(startRow) || startRow < 1 || startRow > source.rows.length) {
    throw invalid('CSV_ANALYSIS_SELECTOR_INVALID', 'CSV operation, column and startRow must be explicit and valid');
  }

  const analysis = analyzeCsvColumn(source, { operation, column, startRow });
  return Object.freeze({
    kind: 'csv_analysis',
    source: Object.freeze({ ref: source.ref, sha256: source.sha256 }),
    selection: Object.freeze({ operation, column, startRow }),
    result: analysis.result,
    valueCount: analysis.valueCount,
    evidence: Object.freeze({
      sources: analysis.sources,
      ignoredEmpty: analysis.ignoredEmpty,
      missingRows: analysis.missingRows,
    }),
  });
}

module.exports = { adaptCsvAnalysis };
