import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCsvSource } = require('../../shell/attachments/csv-source.cjs');
const { profileCsvColumns, renderCsvColumnProfile } = require('../../shell/attachments/csv-column-profile.cjs');
const ref = '/uploads/11111111-1111-4111-8111-111111111111/table.csv';
const source = (csv) => buildCsvSource({ bytes: Buffer.from(csv), ref });

test('profiles whole columns while examples stay bounded and missing differs from zero', () => {
  const profile = profileCsvColumns(source('0,2024-02-29,\n1,2025-01-01\n2,2026-12-31,x\n3,2027-01-01,y'));
  assert.deepEqual(profile.map((column) => column.type), ['decimal', 'iso_date', 'text']);
  assert.deepEqual(profile.map((column) => column.missing), [0, 0, 2]);
  assert.deepEqual(profile[0].samples.map((sample) => sample.value), ['0', '1', '2']);
  assert.equal(profile[0].nonempty, 4);
  assert.equal(profile[0].label, 'C1');
  assert.equal(profile[0].labelSource, 'index');
  assert.equal(profile[2].present, 3);
  assert.equal(profile[2].reason, 'untyped_text');
});

test('ambiguous and invalid dates, mixed values, and leading-zero identifiers stay text', () => {
  const profile = profileCsvColumns(source('01/02/2024,2024-02-30,001,2024-01-01\n02/03/2024,2024-03-01,002,42'));
  assert.deepEqual(profile.map((column) => column.type), ['text', 'text', 'text', 'text']);
  assert.deepEqual(profile.map((column) => column.reason), ['ambiguous_date', 'mixed', 'untyped_text', 'mixed']);
});

test('explicit names are labels, not an inferred or skipped header', () => {
  const profile = profileCsvColumns(source('amount,date\n2,2024-02-29'), { columnNames: ['金额', '日期'] });
  assert.deepEqual(profile.map((column) => column.label), ['金额', '日期']);
  assert.deepEqual(profile.map((column) => column.type), ['text', 'text']);
  assert.equal(profile[0].nonempty, 2);
  assert.throws(() => profileCsvColumns(source('x,y'), { columnNames: ['x'] }), { code: 'CSV_PROFILE_INVALID' });
});

test('long samples are codepoint bounded and cloned source cannot be profiled', () => {
  const profile = profileCsvColumns(source('😀'.repeat(100)));
  assert.equal(Array.from(profile[0].samples[0].value).length, 80);
  assert.equal(profile[0].samples[0].truncated, true);
  assert.throws(() => profileCsvColumns(structuredClone(source('1'))), { code: 'CSV_SOURCE_INVALID' });
});

test('bounded renderer escapes untrusted values and identifies omitted whole columns', () => {
  const data = source('value,"line\nbreak",1,2,3,4,5,6,7,8');
  const text = renderCsvColumnProfile(data, { maxChars: 550 });
  assert.ok(text.length <= 550);
  assert.match(text, /shownColumns=\d+; omittedColumns=\d+; truncated=true/);
  assert.ok(!text.includes('line\nbreak'));
  assert.ok(text.includes('"column":1'));
  assert.throws(() => renderCsvColumnProfile(data, { maxChars: 5 }), { code: 'CSV_PROFILE_INVALID' });
});
