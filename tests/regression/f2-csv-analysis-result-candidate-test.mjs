import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCsvSource } = require('../../shell/attachments/csv-source.cjs');
const { analyzeCsvColumn } = require('../../shell/attachments/csv-analysis.cjs');
const { parseCsv } = require('../../shell/attachments/csv-parser.cjs');
const { renderCsvAnalysisResultCandidate } = require('../../shell/exports/csv-analysis-result-candidate.cjs');
const ref = '/uploads/11111111-1111-4111-8111-111111111111/table.csv';
const source = value => buildCsvSource({ bytes: Buffer.from(value), ref });
const parsed = value => parseCsv(value).rows.map(row => row.map(cell => cell.value));

test('exports exact result, source hash, row coordinates and original zero-padded values', () => {
  const csvSource = source('label,value\na,0003\nb,0.25');
  const analysis = analyzeCsvColumn(csvSource, { operation: 'sum', column: 2, startRow: 2 });
  const rows = parsed(renderCsvAnalysisResultCandidate({ source: csvSource, analysis }));
  assert.deepEqual(rows[0], [
    'record_type', 'source_sha256', 'operation', 'selected_column', 'start_row',
    'result', 'source_row', 'source_coordinate', 'source_value_or_count',
  ]);
  assert.deepEqual(rows[1], ['summary', csvSource.sha256, 'sum', '2', '2', '3.25', '', '', '2']);
  assert.deepEqual(rows[2], ['included', csvSource.sha256, 'sum', '2', '2', '', '2', 'L2C3', '0003']);
  assert.deepEqual(rows[3], ['included', csvSource.sha256, 'sum', '2', '2', '', '3', 'L3C3', '0.25']);
});

test('zero and duplicate rows remain distinct; empty cell and ragged missing row differ', () => {
  const csvSource = source('0,x\n0\n\n0,x\n2,x');
  const analysis = analyzeCsvColumn(csvSource, { operation: 'sum', column: 1 });
  const rows = parsed(renderCsvAnalysisResultCandidate({ source: csvSource, analysis }));
  assert.deepEqual(rows.slice(1).map(row => [row[0], row[6], row[8]]), [
    ['summary', '', '4'], ['included', '1', '0'], ['included', '2', '0'],
    ['empty', '3', ''], ['included', '4', '0'], ['included', '5', '2'],
  ]);

  const ragged = source('1,10\n2\n3,30');
  const raggedAnalysis = analyzeCsvColumn(ragged, { operation: 'sum', column: 2 });
  const raggedRows = parsed(renderCsvAnalysisResultCandidate({ source: ragged, analysis: raggedAnalysis }));
  assert.deepEqual(raggedRows[3].slice(0, 1), ['missing']);
  assert.deepEqual(raggedRows[3].slice(6), ['2', '', '']);
});

test('substituted result, changed provenance or different source are rejected', () => {
  const csvSource = source('1\n2');
  const analysis = analyzeCsvColumn(csvSource, { operation: 'sum', column: 1 });
  const bad = [
    { ...analysis, result: '999' },
    { ...analysis, sources: [{ ...analysis.sources[0], sourceLine: 99 }, analysis.sources[1]] },
    { ...analysis, ignoredEmpty: [{ row: 9, column: 1 }] },
  ];
  for (const forged of bad) assert.throws(
    () => renderCsvAnalysisResultCandidate({ source: csvSource, analysis: forged }),
    { code: 'CSV_ANALYSIS_RESULT_MISMATCH' },
  );
  assert.throws(() => renderCsvAnalysisResultCandidate({ source: source('3\n4'), analysis }),
    { code: 'CSV_ANALYSIS_RESULT_MISMATCH' });
});

test('analysis selector and immutable-source validation still fail closed', () => {
  const csvSource = source('1\n2');
  const analysis = analyzeCsvColumn(csvSource, { operation: 'sum', column: 1 });
  assert.throws(() => renderCsvAnalysisResultCandidate({ source: structuredClone(csvSource), analysis }),
    { code: 'CSV_SOURCE_INVALID' });
  assert.throws(() => renderCsvAnalysisResultCandidate({ source: csvSource, analysis: { ...analysis, column: 0 } }),
    { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
  assert.throws(() => renderCsvAnalysisResultCandidate({ source: csvSource, analysis: null }),
    { code: 'CSV_ANALYSIS_RESULT_MISMATCH' });
});
