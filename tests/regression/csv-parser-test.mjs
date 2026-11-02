import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseCsv, DEFAULT_LIMITS } = require('../../shell/attachments/csv-parser.cjs');
const values = result => result.rows.map(row => row.map(cell => cell.value));

test('UTF-8 string, Buffer and Uint8Array retain multilingual values and byte counts', () => {
  const fixture = '\ufeff名称,値\r\n東京,😀\r\n';
  const expected = [['名称', '値'], ['東京', '😀']];
  for (const input of [fixture, Buffer.from(fixture), new Uint8Array(Buffer.from(fixture))]) {
    const result = parseCsv(input);
    assert.deepEqual(values(result), expected);
    assert.equal(result.bytes, Buffer.byteLength(fixture));
    assert.equal(result.cellCount, 4);
  }
});

test('quoted commas, escaped quotes and multiline CRLF preserve logical and physical coordinates', () => {
  const result = parseCsv('id,note,tail\r\n1,"a,b\r\nc""d",z\r\n2,😀,x');
  assert.deepEqual(values(result), [['id', 'note', 'tail'], ['1', 'a,b\r\nc"d', 'z'], ['2', '😀', 'x']]);
  assert.deepEqual(result.rows.map(row => row.map(({ row, column, sourceLine, sourceColumn }) => [row, column, sourceLine, sourceColumn])), [
    [[1, 1, 1, 1], [1, 2, 1, 4], [1, 3, 1, 9]],
    [[2, 1, 2, 1], [2, 2, 2, 3], [2, 3, 3, 7]],
    [[3, 1, 4, 1], [3, 2, 4, 3], [3, 3, 4, 6]],
  ]);
});

test('empty fields, zero strings, duplicate rows, whitespace and blank records are preserved', () => {
  const result = parseCsv('0,,0,\n0,,0,\n\n"", ,00');
  assert.deepEqual(values(result), [['0', '', '0', ''], ['0', '', '0', ''], [''], ['', ' ', '00']]);
  assert.equal(result.cellCount, 12);
  assert.deepEqual(values(parseCsv('')), []);
  assert.deepEqual(values(parseCsv('\n')), [['']]);
  assert.deepEqual(values(parseCsv('a\n')), [['a']]);
});

test('malformed quoting, bare CR, invalid UTF-8 and unsupported input fail explicitly', () => {
  for (const fixture of ['a"b', '"unclosed', '"a"x', '"a" ', 'a\rb', '"a\rb"']) {
    assert.throws(() => parseCsv(fixture), { code: 'CSV_SYNTAX_INVALID' }, JSON.stringify(fixture));
  }
  for (const fixture of [[0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xff]]) {
    assert.throws(() => parseCsv(Buffer.from(fixture)), { code: 'CSV_ENCODING_INVALID' });
  }
  for (const fixture of [null, 1, {}, ['a']]) assert.throws(() => parseCsv(fixture), { code: 'CSV_INPUT_INVALID' });
});

test('byte, logical row, column and total cell limits accept exact boundaries and reject excess', () => {
  assert.equal(parseCsv('\ufeff中', { limits: { maxBytes: 6 } }).bytes, 6);
  assert.throws(() => parseCsv('\ufeff中', { limits: { maxBytes: 5 } }), { code: 'CSV_LIMIT_EXCEEDED' });
  assert.deepEqual(values(parseCsv('"a\nb"\nc', { limits: { maxRows: 2 } })), [['a\nb'], ['c']]);
  assert.throws(() => parseCsv('"a\nb"\nc', { limits: { maxRows: 1 } }), { code: 'CSV_LIMIT_EXCEEDED' });
  assert.equal(parseCsv('a,b', { limits: { maxColumns: 2 } }).cellCount, 2);
  assert.throws(() => parseCsv('a,b,', { limits: { maxColumns: 2 } }), { code: 'CSV_LIMIT_EXCEEDED' });
  assert.equal(parseCsv('a,b\nc,d', { limits: { maxCells: 4 } }).cellCount, 4);
  assert.throws(() => parseCsv('a,b\nc,d', { limits: { maxCells: 3 } }), { code: 'CSV_LIMIT_EXCEEDED' });
});

test('invalid limits cannot disable safety ceilings', () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '1', DEFAULT_LIMITS[key] + 1]) {
      assert.throws(() => parseCsv('a', { limits: { [key]: value } }), { code: 'CSV_LIMIT_INVALID' });
    }
  }
  assert.throws(() => parseCsv('a', { limits: [] }), { code: 'CSV_LIMIT_INVALID' });
  assert.throws(() => parseCsv('a', { limits: { unknown: 1 } }), { code: 'CSV_LIMIT_INVALID' });
});

test('only the leading BOM is removed; a subsequent U+FEFF is field content for every input type', () => {
  const fixture = '\ufeff\ufeffa,b';
  for (const input of [fixture, Buffer.from(fixture), new Uint8Array(Buffer.from(fixture))]) {
    assert.deepEqual(values(parseCsv(input)), [['\ufeffa', 'b']]);
  }
});
