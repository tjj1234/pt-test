import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderCsvExport } = require('../../shell/exports/csv.cjs');
const { renderRunUsageCsv } = require('../../shell/usage/run-usage-csv.cjs');
const { parseCsv } = require('../../shell/attachments/csv-parser.cjs');

test('typed CSV export preserves source text, decimals and ISO dates without guessing', () => {
  const csv = renderCsvExport({
    columns: ['Name', 'Amount', 'Date', 'Note'],
    rows: [
      [{ type: 'text', value: 'A, "B"' }, { type: 'decimal', value: '-12.50' }, { type: 'date', value: '2024-02-29' }, { type: 'text', value: '3/4/2024' }],
      [{ type: 'text', value: 'line\nbreak' }, { type: 'empty', value: null }, { type: 'date', value: '2025-12-31' }, { type: 'text', value: '' }],
    ],
  });
  const rows = parseCsv(csv).rows.map((row) => row.map((cell) => cell.value));
  assert.deepEqual(rows, [
    ['Name', 'Amount', 'Date', 'Note'],
    ['A, "B"', '-12.50', '2024-02-29', '3/4/2024'],
    ['line\nbreak', '', '2025-12-31', ''],
  ]);
});

test('untrusted formula-looking text remains literal, including quoted cells and headers', () => {
  const csv = renderCsvExport({
    columns: ['=header', 'safe'],
    rows: [[{ type: 'text', value: '=1+1' }, { type: 'text', value: ' \t@SUM(1,2)' }]],
  });
  const rows = parseCsv(csv).rows.map((row) => row.map((cell) => cell.value));
  assert.deepEqual(rows, [["'=header", 'safe'], ["'=1+1", "' \t@SUM(1,2)"]]);
});

test('invalid and ambiguous typed values fail instead of being converted', () => {
  const one = (cell) => renderCsvExport({ columns: ['v'], rows: [[cell]] });
  for (const value of ['2024-02-30', '03/04/2024', '2024-13-01']) {
    assert.throws(() => one({ type: 'date', value }), { code: 'CSV_CELL_INVALID' });
  }
  assert.throws(() => one({ type: 'decimal', value: '1,234' }), { code: 'CSV_CELL_INVALID' });
  assert.throws(() => one({ type: 'decimal', value: 'NaN' }), { code: 'CSV_CELL_INVALID' });
  assert.throws(() => renderCsvExport({ columns: ['x'], rows: [[{ type: 'text', value: 'x' }, { type: 'text', value: 'y' }]] }), { code: 'CSV_ROW_INVALID' });
});

test('Run usage CSV keeps unknown billing explicit and escapes untrusted model text', () => {
  const csv = renderRunUsageCsv({
    runId: '11111111-1111-4111-8111-111111111111',
    responses: [{ responseSeq: 4, selectedModel: '=DANGEROUS()', providerReportedModel: null,
      modelIdentityEvidence: 'unknown', inputTokens: 12, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
      coverage: 'partial', totalSemantics: 'unknown', cost: null, costCoverage: 'unknown',
      observedAt: '2026-10-27T00:00:00.000Z' }],
  });
  const rows = parseCsv(csv).rows.map(row => row.map(cell => cell.value));
  assert.equal(rows[1][2], "'=DANGEROUS()");
  assert.equal(rows[1][3], 'unknown');
  assert.equal(rows[1][5], '12');
  assert.equal(rows[1][6], 'unknown');
  assert.equal(rows[1][12], 'unknown');
  const pricedCsv = renderRunUsageCsv({ runId: '11111111-1111-4111-8111-111111111111', responses: [{
    responseSeq: 1, selectedModel: 'fixture', providerReportedModel: null, costBasis: 'requested_model',
    cost: 0.01, costCoverage: 'estimated', costCurrency: 'USD', priceVersion: 'fixture-v1',
  }] });
  const pricedRows = parseCsv(pricedCsv).rows.map(row => row.map(cell => cell.value));
  assert.equal(pricedRows[0][4], 'cost_basis');
  assert.equal(pricedRows[1][3], 'unknown');
  assert.equal(pricedRows[1][4], 'requested_model');
});
