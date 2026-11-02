import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCsvSource } = require('../../shell/attachments/csv-source.cjs');
const {
  selectCsvColumn,
  renderCsvColumnSelection,
  validIsoDate,
  evidenceType,
  sampleValue,
  MAX_SAMPLES,
  MAX_SAMPLE_CODEPOINTS,
} = require('../../shell/attachments/csv-column-selection-candidate.cjs');

const ref = '/uploads/11111111-1111-4111-8111-111111111111/table.csv';
const makeSource = (csv) => buildCsvSource({ bytes: Buffer.from(csv), ref });

test('1. 表头与无表头选择：表头仅作标签，不参与数据区间运算', () => {
  const csv = makeSource('Amount,Date\n100,2024-01-01\n200,2024-01-02');

  // 有表头：headerRow: 1, startRow: 2, column: 1
  const selWithHeader = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selWithHeader.columnLabel, 'Amount');
  assert.equal(selWithHeader.labelSource, 'header');
  assert.equal(selWithHeader.header.value, 'Amount');
  assert.equal(selWithHeader.header.row, 1);
  assert.equal(selWithHeader.header.column, 1);
  assert.equal(selWithHeader.dataRowCount, 2);
  assert.equal(selWithHeader.type, 'decimal');
  assert.equal(selWithHeader.reason, null);
  assert.deepEqual(
    selWithHeader.samples.map((s) => s.value),
    ['100', '200']
  );

  // 无表头：headerRow: null, startRow: 1, column: 1
  const selNoHeader = selectCsvColumn(csv, { headerRow: null, startRow: 1, column: 1 });
  assert.equal(selNoHeader.columnLabel, 'C1');
  assert.equal(selNoHeader.labelSource, 'index');
  assert.equal(selNoHeader.header, null);
  assert.equal(selNoHeader.dataRowCount, 3);
  // 当第一行 "Amount" 被包含在数据区间时，数据为混杂文本
  assert.equal(selNoHeader.type, 'text');
  assert.equal(selNoHeader.reason, 'mixed');

  // 表头单元格为空或纯空白时，回退到 C<n> 且 labelSource 为 index
  const csvEmptyHeader = makeSource(' ,Date\n10,2024-01-01');
  const selEmptyHeader = selectCsvColumn(csvEmptyHeader, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selEmptyHeader.columnLabel, 'C1');
  assert.equal(selEmptyHeader.labelSource, 'index');
});

test('2. 首行即数据：headerRow: null, startRow: 1 纯数据列判定', () => {
  const csv = makeSource('10.5\n20.25\n30.00');
  const sel = selectCsvColumn(csv, { headerRow: null, startRow: 1, column: 1 });
  assert.equal(sel.columnLabel, 'C1');
  assert.equal(sel.labelSource, 'index');
  assert.equal(sel.type, 'decimal');
  assert.equal(sel.reason, null);
  assert.equal(sel.nonempty, 3);
  assert.equal(sel.empty, 0);
  assert.equal(sel.missing, 0);
});

test('3. 稀疏行（ragged rows）与列存在性', () => {
  // 第 1 行为表头有 3 列；第 2 行 1 列；第 3 行 2 列；第 4 行 3 列
  const csv = makeSource('H1,H2,H3\nA\nB,20\nC,30,300');

  // 选择第 2 列，从第 2 行开始
  const selCol2 = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 2 });
  assert.equal(selCol2.columnLabel, 'H2');
  assert.equal(selCol2.labelSource, 'header');
  assert.equal(selCol2.dataRowCount, 3);
  assert.equal(selCol2.present, 2); // 第 3 行与第 4 行存在
  assert.equal(selCol2.missing, 1); // 第 2 行只有 1 列，第 2 列缺失
  assert.equal(selCol2.type, 'decimal');
  assert.equal(selCol2.reason, null);

  // 选择第 4 列：在第 2~4 行中从未出现过，抛出 CSV_SELECTION_COLUMN_OUT_OF_BOUNDS
  assert.throws(
    () => selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 4 }),
    { code: 'CSV_SELECTION_COLUMN_OUT_OF_BOUNDS' }
  );

  // 即使在表头第 1 行出现，但在数据区间（第 2~4 行）完全未出现，仍拒绝
  const csvHeaderOnlyCol = makeSource('H1,H2,H3,H4\n1\n2\n3');
  assert.throws(
    () => selectCsvColumn(csvHeaderOnlyCol, { headerRow: 1, startRow: 2, column: 4 }),
    { code: 'CSV_SELECTION_COLUMN_OUT_OF_BOUNDS' }
  );
});

test('4. 空值、缺失与零严格区分', () => {
  // 数据行包含：空字符串 ""、数字 0、普通正数 42
  const csv = makeSource('val\n""\n0\n42');
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(sel.dataRowCount, 3);
  assert.equal(sel.present, 3);
  assert.equal(sel.missing, 0);
  assert.equal(sel.empty, 1);
  assert.equal(sel.nonempty, 2);
  // 零与 42 均为 decimal
  assert.equal(sel.type, 'decimal');
  assert.equal(sel.reason, null);
  // samples 应记录 nonempty 单元格，包含 '0'
  assert.deepEqual(
    sel.samples.map((s) => s.value),
    ['0', '42']
  );

  // 全空数据列：所有单元格为 ""
  const csvAllEmpty = makeSource('H\n\n\n');
  const selAllEmpty = selectCsvColumn(csvAllEmpty, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selAllEmpty.dataRowCount, 2);
  assert.equal(selAllEmpty.empty, 2);
  assert.equal(selAllEmpty.nonempty, 0);
  assert.equal(selAllEmpty.type, 'empty');
  assert.equal(selAllEmpty.reason, null);
  assert.equal(selAllEmpty.samples.length, 0);
});

test('5. 重复行与坐标定位', () => {
  const csv = makeSource('price\n99.9\n99.9\n99.9\n99.9');
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(sel.dataRowCount, 4);
  assert.equal(sel.samples.length, MAX_SAMPLES); // 最多 3 个样本
  assert.deepEqual(
    sel.samples.map((s) => s.row),
    [2, 3, 4]
  );
  assert.deepEqual(
    sel.samples.map((s) => s.sourceLine),
    [2, 3, 4]
  );
  assert.deepEqual(
    sel.samples.map((s) => s.value),
    ['99.9', '99.9', '99.9']
  );
});

test('6. 前导零编号保持 text，不误判为 decimal', () => {
  const csv = makeSource('code\n001\n002\n089');
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(sel.type, 'text');
  assert.equal(sel.reason, 'untyped_text');
  assert.deepEqual(
    sel.samples.map((s) => s.value),
    ['001', '002', '089']
  );
});

test('7. 日期判定：有效 ISO 日期 vs 模糊斜杠日期 vs 无效日期', () => {
  // 合法 ISO 日期（包含闰年 2024-02-29）
  const csvIso = makeSource('date\n2024-02-29\n2024-12-31');
  const selIso = selectCsvColumn(csvIso, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selIso.type, 'iso_date');
  assert.equal(selIso.reason, null);

  // 模糊斜杠日期（如 01/02/2024，月/日未知）保持 text
  const csvSlash = makeSource('date\n01/02/2024\n03/04/2024');
  const selSlash = selectCsvColumn(csvSlash, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selSlash.type, 'text');
  assert.equal(selSlash.reason, 'ambiguous_date');

  // 非法日期（如平年的 2023-02-29 或 2024-02-30）保持 text
  const csvInvalidDate = makeSource('date\n2024-02-30');
  const selInvalidDate = selectCsvColumn(csvInvalidDate, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selInvalidDate.type, 'text');
  assert.equal(selInvalidDate.reason, 'untyped_text');
});

test('8. 区域千分位数字歧义（ambiguous grouping）保持 text', () => {
  // 1.234 或 12.345 属于常见千分位/小数歧义形态，按保守规则保持 text
  const csvAmbiguousDot = makeSource('num\n1.234\n12.345');
  const selAmbiguousDot = selectCsvColumn(csvAmbiguousDot, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selAmbiguousDot.type, 'text');
  assert.equal(selAmbiguousDot.reason, 'ambiguous_grouping');

  // 0.125 或 1234.567 无歧义，正常判定为 decimal
  const csvUnambiguousDot = makeSource('num\n0.125\n1234.567');
  const selUnambiguousDot = selectCsvColumn(csvUnambiguousDot, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selUnambiguousDot.type, 'decimal');
  assert.equal(selUnambiguousDot.reason, null);
});

test('9. 混合列（mixed types）', () => {
  // 数值与日期混杂
  const csvMixed1 = makeSource('col\n100\n2024-01-01');
  const selMixed1 = selectCsvColumn(csvMixed1, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selMixed1.type, 'text');
  assert.equal(selMixed1.reason, 'mixed');

  // 数值与普通文本混杂
  const csvMixed2 = makeSource('col\n100\nN/A');
  const selMixed2 = selectCsvColumn(csvMixed2, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(selMixed2.type, 'text');
  assert.equal(selMixed2.reason, 'mixed');
});

test('10. 多行引号单元格（multiline quoted cells）', () => {
  const csv = makeSource('id,notes\n1,"first line\nsecond line\nthird line"\n2,simple');
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 2 });
  assert.equal(sel.dataRowCount, 2);
  assert.equal(sel.samples[0].row, 2);
  assert.equal(sel.samples[0].sourceLine, 2);
  assert.equal(sel.samples[0].value, 'first line\nsecond line\nthird line');
  assert.equal(sel.samples[1].sourceLine, 5); // 经历 3 行后，下一个从第 5 行开始
  assert.equal(sel.type, 'text');
});

test('11. 超长样本截断保护（MAX_SAMPLE_CODEPOINTS: 80）', () => {
  const longText = '🚀'.repeat(100); // 100 个 emoji 字符
  const csv = makeSource(`item\n${longText}`);
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 1 });
  assert.equal(sel.samples[0].truncated, true);
  assert.equal(Array.from(sel.samples[0].value).length, MAX_SAMPLE_CODEPOINTS);
  assert.equal(sel.samples[0].value, '🚀'.repeat(80));
});

test('12. 非法选择参数校验与错误脱敏', () => {
  const csv = makeSource('A,B\n1,2\n3,4');

  // headerRow 非法
  assert.throws(() => selectCsvColumn(csv, { headerRow: 0, startRow: 1, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: -1, startRow: 1, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: 1.5, startRow: 2, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: '1', startRow: 2, column: 1 }), { code: 'CSV_SELECTION_INVALID' });

  // startRow 非法
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: 0, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: -1, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: '1', column: 1 }), { code: 'CSV_SELECTION_INVALID' });

  // column 非法
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: 1, column: 0 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: 1, column: -1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: null, startRow: 1, column: '1' }), { code: 'CSV_SELECTION_INVALID' });

  // headerRow >= startRow
  assert.throws(() => selectCsvColumn(csv, { headerRow: 2, startRow: 2, column: 1 }), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, { headerRow: 3, startRow: 2, column: 1 }), { code: 'CSV_SELECTION_INVALID' });

  // selection 非对象
  assert.throws(() => selectCsvColumn(csv, null), { code: 'CSV_SELECTION_INVALID' });
  assert.throws(() => selectCsvColumn(csv, 'invalid'), { code: 'CSV_SELECTION_INVALID' });
});

test('13. 越界与空数据区间', () => {
  const csv = makeSource('H1,H2\n1,2');

  // headerRow 超过总行数
  assert.throws(
    () => selectCsvColumn(csv, { headerRow: 5, startRow: 6, column: 1 }),
    { code: 'CSV_SELECTION_OUT_OF_BOUNDS' }
  );

  // startRow 超过总行数（数据区间为空）
  assert.throws(
    () => selectCsvColumn(csv, { headerRow: 1, startRow: 5, column: 1 }),
    { code: 'CSV_SELECTION_OUT_OF_BOUNDS' }
  );
});

test('14. 伪造或未认证 source 拒绝', () => {
  const forged = { kind: 'csv', rows: [] };
  assert.throws(() => selectCsvColumn(forged, { headerRow: null, startRow: 1, column: 1 }), { code: 'CSV_SOURCE_INVALID' });

  const genuine = makeSource('1,2');
  const cloned = structuredClone(genuine);
  assert.throws(() => selectCsvColumn(cloned, { headerRow: null, startRow: 1, column: 1 }), { code: 'CSV_SOURCE_INVALID' });
});

test('15. 错误消息安全性：不回显单元格数据或文件路径', () => {
  const secretContent = 'SUPER_SECRET_TOKEN_99999';
  const csv = makeSource(`H1\n${secretContent}`);

  try {
    // 故意使用越界的 startRow
    selectCsvColumn(csv, { headerRow: null, startRow: 100, column: 1 });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal(err.message.includes(secretContent), false);
    assert.equal(err.message.includes(ref), false);
  }
});

test('16. renderCsvColumnSelection 上下文渲染与预算控制', () => {
  const csv = makeSource('Product,Price\nApple,3.50\nBanana,2.00');
  const sel = selectCsvColumn(csv, { headerRow: 1, startRow: 2, column: 2 });
  const rendered = renderCsvColumnSelection(sel, { maxChars: 1000 });

  assert.ok(rendered.length <= 1000);
  assert.ok(rendered.includes('CSV_COLUMN_SELECTION'));
  assert.ok(rendered.includes(`sha256=${sel.sourceSha256}`));
  assert.ok(rendered.includes('Price'));
  assert.ok(rendered.includes('decimal'));

  // 预算过小抛错
  assert.throws(() => renderCsvColumnSelection(sel, { maxChars: 10 }), { code: 'CSV_SELECTION_INVALID' });
  // 非法入参
  assert.throws(() => renderCsvColumnSelection(null), { code: 'CSV_SELECTION_INVALID' });
});
