import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCsvSource } = require('../../shell/attachments/csv-source.cjs');
const { adaptCsvAnalysis } = require('../../shell/tasks/csv-analysis-adapter.cjs');
const ref = '/uploads/11111111-1111-4111-8111-111111111111/values.csv';
const source = (text) => buildCsvSource({ bytes: Buffer.from(text), ref });
const select = (csv, overrides = {}) => ({ sourceSha256: csv.sha256, operation: 'sum', column: 2, startRow: 2, ...overrides });

test('explicit CSV analysis returns exact result and source coordinates without raw cells', () => {
  const csv = source('label,value\na,0.10\nb,0.20\nc,\nd,0');
  const result = adaptCsvAnalysis({ source: csv, selection: select(csv) });
  assert.equal(result.result, '0.3');
  assert.equal(result.valueCount, 3);
  assert.deepEqual(result.source, { ref, sha256: csv.sha256 });
  assert.deepEqual(result.selection, { operation: 'sum', column: 2, startRow: 2 });
  assert.deepEqual(result.evidence.sources.map((cell) => [cell.row, cell.column]), [[2, 2], [3, 2], [5, 2]]);
  assert.deepEqual(result.evidence.ignoredEmpty.map((cell) => cell.row), [4]);
  assert.equal(JSON.stringify(result).includes('label'), false);
  assert.equal(Object.isFrozen(result.evidence), true);
});

test('digest mismatch and deserialized source fail closed', () => {
  const csv = source('label,value\na,1');
  assert.throws(() => adaptCsvAnalysis({ source: csv, selection: select(csv, { sourceSha256: '0'.repeat(64) }) }), { code: 'CSV_ANALYSIS_SOURCE_CHANGED' });
  assert.throws(() => adaptCsvAnalysis({ source: structuredClone(csv), selection: select(csv) }), { code: 'CSV_SOURCE_INVALID' });
});

test('operation and 1-based column/start row require explicit safe selectors', () => {
  const csv = source('label,value\na,1');
  for (const override of [
    { operation: 'average' }, { operation: undefined }, { column: 0 }, { column: '2' },
    { startRow: 0 }, { startRow: 3 }, { startRow: '2' },
  ]) {
    assert.throws(() => adaptCsvAnalysis({ source: csv, selection: select(csv, override) }), { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
  }
  const missingStart = select(csv); delete missingStart.startRow;
  assert.throws(() => adaptCsvAnalysis({ source: csv, selection: missingStart }), { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
  assert.throws(() => adaptCsvAnalysis({ source: csv, selection: select(csv, { headerName: 'value' }) }), { code: 'CSV_ANALYSIS_SELECTOR_INVALID' });
});

test('ambiguous value rejects with source coordinate and no implicit coercion', () => {
  const csv = source('label,value\na,"1,000"');
  assert.throws(() => adaptCsvAnalysis({ source: csv, selection: select(csv) }), (error) => {
    assert.equal(error.code, 'CSV_ANALYSIS_VALUE_INVALID');
    assert.match(error.message, /R2C2/);
    return true;
  });
});
