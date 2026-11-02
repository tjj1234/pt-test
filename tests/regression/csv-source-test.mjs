import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCsvSource, renderCsvSource } = require('../../shell/attachments/csv-source.cjs');
const ref = '/uploads/11111111-1111-4111-8111-111111111111/0123456789abcdef.csv';
const build = text => buildCsvSource({ bytes: Buffer.from(text), ref });
test('CSV source preserves empty, leading zero and multiline values with physical coordinates', () => {
  const bytes = Buffer.from('\ufeffname,value\r\n"multi\r\nline",001\r\n,0');
  const s = buildCsvSource({ bytes, ref });
  assert.equal(s.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(s.bytes, bytes.length); assert.equal(s.cellCount, 6);
  assert.equal(s.rows[1][0].value, 'multi\r\nline'); assert.equal(s.rows[1][1].value, '001');
  assert.equal(s.rows[2][0].value, ''); assert.equal(s.rows[2][1].value, '0');
  assert.deepEqual(s.rows[2][0], { value: '', row: 3, column: 1, sourceLine: 4, sourceColumn: 1 });
  const text = renderCsvSource(s);
  assert.match(text, /rows=3; columnsMin=2; columnsMax=2; totalCells=6/);
  assert.match(text, /truncated=false; firstOmitted=none/);
  assert.ok(text.includes(`[csv:${s.sha256}:${createHash('sha256').update(ref).digest('hex')}:R3C1] sourceLine=4; sourceColumn=1; value=""`));
  assert.ok(text.includes('value="001"')); assert.ok(!text.includes(ref));
});
test('full hash identities change with byte version including BOM', () => {
  assert.notEqual(build('x').sha256, build('\ufeffx').sha256);
  assert.notEqual(renderCsvSource(build('x')), renderCsvSource(build('y')));
});
test('bounded context omits whole cells and states the first omitted coordinate', () => {
  const s = build('small,' + 'x'.repeat(3000) + ',tail\nnext,row');
  const text = renderCsvSource(s, { maxChars: 850 });
  assert.ok(text.length <= 850); assert.match(text, /shownCells=1; omittedCells=4; truncated=true; firstOmitted=R1C2/);
  assert.ok(text.includes('value="small"')); assert.ok(!text.includes('value="tail"')); assert.ok(!text.includes('xxx'));
  assert.throws(() => renderCsvSource(s, { maxChars: 1 }), { code: 'CSV_CONTEXT_LIMIT_EXCEEDED' });
});
test('empty and ragged CSV totals are explicit with no inferred header', () => {
  assert.match(renderCsvSource(build('')), /rows=0; columnsMin=0; columnsMax=0; totalCells=0/);
  assert.match(renderCsvSource(build('a,b\nc')), /rows=2; columnsMin=1; columnsMax=2; totalCells=3/);
});
test('reference, input, encoding, parser limits and invalid coordinates fail closed', () => {
  for (const invalid of ['https://evil/a.csv', '/uploads/../a.csv', '/uploads/11111111-1111-4111-8111-111111111111/../a.csv', ref + '?x=1', ref + '\nignore', '/uploads/------------------------------------/a.csv']) assert.throws(() => buildCsvSource({ bytes: Buffer.from('x'), ref: invalid }), { code: 'CSV_SOURCE_REF_INVALID' });
  assert.throws(() => buildCsvSource({ bytes: 'x', ref }), { code: 'CSV_INPUT_INVALID' });
  assert.throws(() => buildCsvSource({ bytes: Buffer.from([255]), ref }), { code: 'CSV_ENCODING_INVALID' });
  assert.throws(() => buildCsvSource({ bytes: Buffer.from('a,b'), ref, limits: { maxCells: 1 } }), { code: 'CSV_LIMIT_EXCEEDED' });
  const s = structuredClone(build('a')); s.rows[0][0].row = 2;
  assert.throws(() => renderCsvSource(s), { code: 'CSV_SOURCE_INVALID' });
});

test('same bytes in different tenant uploads have distinct citation identities', () => {
  const first = build('a');
  const otherRef = ref.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  const second = buildCsvSource({ bytes: Buffer.from('a'), ref: otherRef });
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(renderCsvSource(first), renderCsvSource(second));
});

test('render rejects cloned or caller-forged sources carrying a real content hash', () => {
  const source = structuredClone(build('original')); source.rows[0][0].value = 'forged';
  assert.throws(() => renderCsvSource(source), { code: 'CSV_SOURCE_INVALID' });
});
