import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCsvSource } = require('../../shell/attachments/csv-source.cjs');
const { analyzeCsvColumn, MAX_ANALYSIS_ROWS, MAX_DECIMAL_DIGITS, MAX_DECIMAL_SCALE } = require('../../shell/attachments/csv-analysis.cjs');
const ref = '/uploads/11111111-1111-4111-8111-111111111111/table.csv';
const source = text => buildCsvSource({ bytes: Buffer.from(text), ref });

test('explicit sum uses exact decimal arithmetic and returns every input cell source', () => {
  const csv = source('name,amount\na,0.10\nb,0.20');
  const result = analyzeCsvColumn(csv, { operation: 'sum', column: 2, startRow: 2 });
  assert.equal(result.result, '0.3');
  assert.equal(result.valueCount, 2);
  assert.deepEqual(result.sources, [
    { row: 2, column: 2, sourceLine: 2, sourceColumn: 3 },
    { row: 3, column: 2, sourceLine: 3, sourceColumn: 3 },
  ]);
  assert.equal(result.ignoredEmpty.length, 0);
  assert.equal(csv.rows[0][0].value, 'name'); // The caller explicitly skipped the header; no inference occurs.
});

test('empty cells are skipped, zero and duplicate rows are retained as distinct inputs', () => {
  const result = analyzeCsvColumn(source('x\n0\n\n0\n2'), { operation: 'sum', column: 1, startRow: 2 });
  assert.equal(result.result, '2');
  assert.equal(result.valueCount, 3);
  assert.deepEqual(result.sources.map(x => x.row), [2, 4, 5]);
  assert.deepEqual(result.ignoredEmpty, [{ row: 3, column: 1, sourceLine: 3, sourceColumn: 1 }]);
  assert.throws(() => analyzeCsvColumn(source('x\n\n'), { operation: 'sum', column: 1, startRow: 2 }), { code: 'CSV_ANALYSIS_NO_VALUES' });
});

test('count, minimum and maximum are deterministic and include signed values', () => {
  const csv = source('-12.50\n0\n+0.125\n-12.5');
  assert.equal(analyzeCsvColumn(csv, { operation: 'count', column: 1 }).result, '4');
  assert.equal(analyzeCsvColumn(csv, { operation: 'min', column: 1 }).result, '-12.5');
  assert.equal(analyzeCsvColumn(csv, { operation: 'max', column: 1 }).result, '0.125');
});

test('explicit numeric selection treats preserved leading zeroes as decimal digits', () => {
  const csv = source('0003\n0.25');
  const result = analyzeCsvColumn(csv, { operation: 'sum', column: 1 });
  assert.equal(result.result, '3.25');
  assert.equal(csv.rows[0][0].value, '0003');
});

test('ragged rows are missing observations; non-empty non-decimals fail with source coordinate', () => {
  const csv = source('1,10\n2\n3,30');
  const result = analyzeCsvColumn(csv, { operation: 'sum', column: 2 });
  assert.equal(result.result, '40');
  assert.deepEqual(result.sources.map(x => x.row), [1, 3]);
  assert.deepEqual(result.missingRows, [2]);
  // User-selected T09 rule A: do not infer units/currency, date order, or
  // locale separators from values; wait for real trial files before extending.
  for (const value of ['USD 5', '5 EUR', '$5', '€5', '5 kg', '5%', '5°C', '1,000', '1,25', '1.234,56', '1 234,56', '1.234', '12.345', '123.456', '+1.234', '-12.345', '2026-10-22', '2026/10/22', '2026.10.22', '01/02/2026', '1e3', ' 2', '2 ']) {
    const csvValue = value.includes(',') ? `"${value}"` : value;
    assert.throws(() => analyzeCsvColumn(source(`value\n${csvValue}`), { operation: 'sum', column: 1, startRow: 2 }), error => {
      assert.equal(error.code, 'CSV_ANALYSIS_VALUE_INVALID');
      assert.match(error.message, /R2C1/, `rejection should identify the source cell for ${value}`);
      return true;
    });
  }
  for (const value of ['0.125', '1234.567', '-1234.567']) {
    assert.equal(analyzeCsvColumn(source(value), { operation: 'sum', column: 1 }).result, value);
  }
});

test('unsupported selectors and empty ranges fail explicitly', () => {
  const csv = source('1');
  for (const operation of ['average', 'median', null]) assert.throws(() => analyzeCsvColumn(csv, { operation, column: 1 }), { code: 'CSV_ANALYSIS_OPERATION_INVALID' });
  for (const column of [0, -1, 1.5, '1']) assert.throws(() => analyzeCsvColumn(csv, { operation: 'sum', column }), { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
  for (const startRow of [0, -1, 1.5, '1']) assert.throws(() => analyzeCsvColumn(csv, { operation: 'sum', column: 1, startRow }), { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
  assert.throws(() => analyzeCsvColumn(csv, { operation: 'sum', column: 1, startRow: 2 }), { code: 'CSV_ANALYSIS_NO_VALUES' });
});

test('decimal precision and row processing have explicit safety ceilings', () => {
  assert.throws(() => analyzeCsvColumn(source(`1.${'1'.repeat(MAX_DECIMAL_SCALE + 1)}`), { operation: 'sum', column: 1 }), { code: 'CSV_ANALYSIS_VALUE_INVALID' });
  assert.throws(() => analyzeCsvColumn(source('1'.repeat(MAX_DECIMAL_DIGITS + 1)), { operation: 'sum', column: 1 }), { code: 'CSV_ANALYSIS_VALUE_INVALID' });
  const manyRows = Array.from({ length: MAX_ANALYSIS_ROWS + 1 }, () => '1').join('\n');
  assert.throws(() => analyzeCsvColumn(source(manyRows), { operation: 'sum', column: 1 }), { code: 'CSV_ANALYSIS_LIMIT_EXCEEDED' });
});

test('analysis rejects caller-forged/deserialized source objects', () => {
  const forged = structuredClone(source('1'));
  assert.throws(() => analyzeCsvColumn(forged, { operation: 'sum', column: 1 }), { code: 'CSV_SOURCE_INVALID' });
});
