import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {parseOfficeDocument} = require('../../shell/attachments/office-document-parser.cjs');
const {spreadsheet, presentation} = require('../helpers/office-structured-fixtures.cjs');
test('XLSX preserves sheet/cell identity, original serials and formula text without evaluation', async () => {
  const r = await parseOfficeDocument({bytes: spreadsheet(), format: 'xlsx'});
  assert.equal(r.blocks[0].text, '编号00123中文');
  assert.deepEqual(r.blocks[0].locator, {kind: 'sheet-cell', sheet: 1, sheetName: '资料', cell: 'A1', valueType: 's', formula: false});
  assert.equal(r.blocks[1].text, '45292');
  assert.equal(r.blocks[2].text, 'FORMULA_TEXT=SUM(B1:B2); CACHED_VALUE=10');
  assert.equal(r.blocks[2].locator.formula, true);
  assert.equal(r.blocks[3].text, '=IMPORTXML(private)');
  assert.match(r.limitations, /no formula evaluation/);
  assert.equal(r.sourceSha256.length, 64);
});
test('PPTX uses presentation order and original slide/paragraph locations with non-numeric filenames', async () => {
  const r = await parseOfficeDocument({bytes: presentation(), format: 'pptx'});
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].text, '中文演示第一段');
  assert.deepEqual(r.blocks[1].locator, {kind: 'slide-paragraph', slide: 1, paragraph: 2});
  assert.match(r.limitations, /images/);
});
test('Office relationship escapes, external parts, false extensions and XML entities fail closed', async () => {
  for (const bytes of [spreadsheet({target: '../../../private.xml'}), spreadsheet({target: 'https://private.test/file', external: true}), spreadsheet({sharedXml: '<!DOCTYPE sst [<!ENTITY private SYSTEM "file:///etc/passwd">]><sst/>'})]) {
    await assert.rejects(parseOfficeDocument({bytes, format: 'xlsx'}), e => e.code.startsWith('OFFICE_') && !e.message.includes('passwd'));
  }
  await assert.rejects(parseOfficeDocument({bytes: presentation(), format: 'xlsx'}), {code: 'OFFICE_FORMAT_MISMATCH'});
  const invalidCells = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1" t="s"><v>99</v></c></worksheet>';
  await assert.rejects(parseOfficeDocument({bytes: spreadsheet({sheetXml: invalidCells}), format: 'xlsx'}), {code: 'OFFICE_SHARED_STRING_INVALID'});
});
