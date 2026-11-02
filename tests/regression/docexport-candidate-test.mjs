import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  exportDocumentCandidate,
  DEFAULT_LIMITS,
  HARD_CEILINGS,
  SUPPORTED_FORMATS,
  FORMULA_INJECTION_REGEX,
} = require('../../shell/exports/document-export-candidate.cjs');

const fflate = require('../../shell/node_modules/fflate');
const XLSX = require(path.resolve(__dirname, '../../analytics/node_modules/xlsx'));

// 标准样本文档数据
function makeSampleDoc() {
  return {
    title: 'Q3 社媒增长与归因分析报告',
    author: '北极星增长 Agent',
    date: '2026-10-26',
    sections: [
      {
        heading: '1. 渠道大盘总览',
        paragraphs: [
          '本季度多渠道累计投放消耗 15,200 美元，带来总计 3,420 次有效转化。',
          'Meta 与 Google 仍为主力增长引擎，X 渠道在特定区域展现出较高的 ROI 弹性。',
        ],
        table: {
          headers: ['渠道名称', '投放消耗 (USD)', '转化人数', 'ROAS'],
          rows: [
            ['Meta Ads', 7500, 1820, 2.45],
            ['Google Ads', 5800, 1310, 2.18],
            ['X Ads', 1900, 290, 1.85],
          ],
        },
      },
      {
        heading: '2. 优化建议',
        paragraphs: [
          '建议加大对高 ROI 素材的预算倾斜，对低转化创意进行下线或重新编排。',
        ],
      },
    ],
  };
}

test('1. Word (.docx) 生成真实有效性与结构完整性', () => {
  const doc = makeSampleDoc();
  const res = exportDocumentCandidate(doc, { format: 'docx' });

  assert.equal(res.format, 'docx');
  assert.equal(res.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(Buffer.isBuffer(res.buffer));
  assert.ok(res.byteCount > 0);
  assert.equal(res.buffer.length, res.byteCount);
  assert.match(res.sha256, /^[a-f0-9]{64}$/);

  // 验证 ZIP 归档魔数 (PK\x03\x04)
  assert.equal(res.buffer[0], 0x50);
  assert.equal(res.buffer[1], 0x4b);
  assert.equal(res.buffer[2], 0x03);
  assert.equal(res.buffer[3], 0x04);

  // 解包验证 OOXML 标准组成
  const unzipped = fflate.unzipSync(new Uint8Array(res.buffer));
  const files = Object.keys(unzipped);

  assert.ok(files.includes('[Content_Types].xml'));
  assert.ok(files.includes('_rels/.rels'));
  assert.ok(files.includes('word/document.xml'));
  assert.ok(files.includes('word/styles.xml'));
  assert.ok(files.includes('word/settings.xml'));

  // 验证 document.xml 包含正文与表格内容
  const docXml = fflate.strFromU8(unzipped['word/document.xml']);
  assert.ok(docXml.includes('Q3 社媒增长与归因分析报告'));
  assert.ok(docXml.includes('Meta Ads'));
  assert.ok(docXml.includes('Google Ads'));
  assert.ok(docXml.includes('<w:tbl>'));

  // 验证绝无宏或可执行文件
  assert.ok(!files.some((f) => f.includes('vba') || f.endsWith('.bin') || f.endsWith('.exe')));
});

test('2. Excel (.xlsx) 生成真实有效性与表格反读验证', () => {
  const doc = makeSampleDoc();
  const res = exportDocumentCandidate(doc, { format: 'xlsx' });

  assert.equal(res.format, 'xlsx');
  assert.equal(res.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(Buffer.isBuffer(res.buffer));
  assert.ok(res.byteCount > 0);
  assert.match(res.sha256, /^[a-f0-9]{64}$/);

  // 验证 ZIP 魔数
  assert.equal(res.buffer[0], 0x50);
  assert.equal(res.buffer[1], 0x4b);

  // 使用 XLSX 库反读，证明文件真实有效不报错
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('概览'));
  assert.ok(wb.SheetNames.includes('1. 渠道大盘总览'));

  const overviewSheet = wb.Sheets['概览'];
  const overviewData = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 });
  assert.equal(overviewData[0][0], '标题');
  assert.equal(overviewData[0][1], 'Q3 社媒增长与归因分析报告');

  const tableSheet = wb.Sheets['1. 渠道大盘总览'];
  const tableData = XLSX.utils.sheet_to_json(tableSheet, { header: 1 });
  assert.deepEqual(tableData[0], ['渠道名称', '投放消耗 (USD)', '转化人数', 'ROAS']);
  assert.equal(tableData[1][0], 'Meta Ads');
  assert.equal(tableData[1][1], 7500);
});

test('3. PDF (.pdf) 生成真实有效性与 ISO 32000-1 规范校验', () => {
  const doc = makeSampleDoc();
  const res = exportDocumentCandidate(doc, { format: 'pdf' });

  assert.equal(res.format, 'pdf');
  assert.equal(res.mime, 'application/pdf');
  assert.ok(Buffer.isBuffer(res.buffer));
  assert.ok(res.byteCount > 0);
  assert.match(res.sha256, /^[a-f0-9]{64}$/);

  const pdfStr = res.buffer.toString('latin1');
  // 必须以 %PDF-1.4 开头
  assert.ok(pdfStr.startsWith('%PDF-1.4'));
  // 包含 xref、trailer、startxref 和 %%EOF
  assert.ok(pdfStr.includes('xref'));
  assert.ok(pdfStr.includes('trailer'));
  assert.ok(pdfStr.includes('startxref'));
  assert.ok(pdfStr.endsWith('%%EOF'));

  // 包含 Catalog、Pages、Font 资源
  assert.ok(pdfStr.includes('/Type /Catalog'));
  assert.ok(pdfStr.includes('/Type /Pages'));
  assert.ok(pdfStr.includes('/Type /Font'));

  // 包含标题与文本（ASCII 文本直接以小括号包含，Unicode 文本以 <feff...> hex 字符串标准编码）
  assert.ok(pdfStr.includes('<feff00510033')); // 'Q3' UTF-16BE BOM 编码
  assert.ok(pdfStr.includes('(Meta Ads)'));

  // 严格安全审查：绝无 JavaScript / Launch 等动态执行动作
  assert.ok(!pdfStr.includes('/JavaScript'));
  assert.ok(!pdfStr.includes('/JS'));
  assert.ok(!pdfStr.includes('/Launch'));
  assert.ok(!pdfStr.includes('/EmbeddedFiles'));
});

test('4. PDF 分页机制与多页渲染验证', () => {
  // 构造包含 60 行数据的长表格，触发 PDF 自动分页
  const longRows = Array.from({ length: 60 }, (_, i) => [
    `Row Item ${i + 1}`,
    (i + 1) * 10,
    `Status ${i + 1}`,
  ]);

  const longDoc = {
    title: 'Multi-Page Export Test',
    table: {
      headers: ['Index', 'Score', 'Status'],
      rows: longRows,
    },
  };

  const res = exportDocumentCandidate(longDoc, { format: 'pdf' });
  const pdfStr = res.buffer.toString('latin1');

  // 断言生成了多页 (/Count >= 2)
  const match = pdfStr.match(/\/Type \/Pages \/Kids \[([^\]]+)\] \/Count (\d+)/);
  assert.ok(match, '必须包含标准的 Pages 节点');
  const pageCount = Number(match[2]);
  assert.ok(pageCount >= 2, `长文档应自动分页，实际生成页数: ${pageCount}`);
});

test('5. 严格 Fail-Closed：数据缺失与字段异常校验', () => {
  // 缺失标题
  assert.throws(
    () => exportDocumentCandidate({}, { format: 'docx' }),
    { code: 'DOC_TITLE_REQUIRED' }
  );
  assert.throws(
    () => exportDocumentCandidate({ title: '   ' }, { format: 'docx' }),
    { code: 'DOC_TITLE_EMPTY' }
  );

  // sections 不是数组
  assert.throws(
    () => exportDocumentCandidate({ title: 'Test', sections: 'invalid' }, { format: 'docx' }),
    { code: 'DOC_INPUT_INVALID' }
  );

  // 段落类型异常
  assert.throws(
    () =>
      exportDocumentCandidate(
        { title: 'Test', sections: [{ paragraphs: [{ object: 'invalid' }] }] },
        { format: 'docx' }
      ),
    { code: 'DOC_INVALID_TYPE' }
  );

  // 表头缺失或为空
  assert.throws(
    () =>
      exportDocumentCandidate(
        { title: 'Test', table: { headers: [], rows: [] } },
        { format: 'xlsx' }
      ),
    { code: 'DOC_INPUT_INVALID' }
  );

  // 表格行与表头列数不一致（第一行 3 列，实际 2 列 -> 必须 fail-closed 拒收）
  assert.throws(
    () =>
      exportDocumentCandidate(
        {
          title: 'Test',
          table: {
            headers: ['A', 'B', 'C'],
            rows: [
              ['val1', 'val2', 'val3'],
              ['mismatch1', 'mismatch2'], // 缺 1 列
            ],
          },
        },
        { format: 'xlsx' }
      ),
    { code: 'DOC_TABLE_ROW_LENGTH_MISMATCH' }
  );

  // 不支持的格式
  assert.throws(
    () => exportDocumentCandidate({ title: 'Test' }, { format: 'exe' }),
    { code: 'DOC_FORMAT_UNSUPPORTED' }
  );
});

test('6. 资源边界控制：行数、单元格数、文件大小与参数越界', () => {
  // 单表格行数超限测试
  const bigRows = Array.from({ length: 50 }, (_, i) => [`Item ${i}`, i]);
  assert.throws(
    () =>
      exportDocumentCandidate(
        {
          title: 'Big Table',
          table: { headers: ['Name', 'Value'], rows: bigRows },
        },
        { format: 'xlsx', maxRows: 30 } // 限制 30 行，提供 50 行
      ),
    { code: 'DOC_ROWS_LIMIT_EXCEEDED' }
  );

  // 单元格数超限测试
  assert.throws(
    () =>
      exportDocumentCandidate(
        {
          title: 'Many Cells',
          table: {
            headers: ['A', 'B', 'C', 'D'],
            rows: [
              [1, 2, 3, 4],
              [5, 6, 7, 8],
            ],
          },
        },
        { format: 'xlsx', maxCells: 10 } // 限制 10 单元格，总计 4 + 8 = 12
      ),
    { code: 'DOC_CELLS_LIMIT_EXCEEDED' }
  );

  // 资源参数超出硬上限
  assert.throws(
    () =>
      exportDocumentCandidate(
        { title: 'Test' },
        { format: 'docx', maxRows: HARD_CEILINGS.maxRows + 1 }
      ),
    { code: 'DOC_OPTION_EXCEEDS_CEILING' }
  );
  assert.throws(
    () =>
      exportDocumentCandidate(
        { title: 'Test' },
        { format: 'docx', maxRows: -1 }
      ),
    { code: 'DOC_OPTION_INVALID' }
  );

  // 文件体积超限拦截
  assert.throws(
    () =>
      exportDocumentCandidate(
        makeSampleDoc(),
        { format: 'docx', maxBytes: 100 } // 设 100 字节，实际几 KB
      ),
    { code: 'DOC_BYTES_LIMIT_EXCEEDED' }
  );
});

test('7. 专项测试：Excel 公式注入防御（CSV/Spreadsheet Formula Injection）', () => {
  const dangerousDoc = {
    title: 'Security Formula Test',
    table: {
      headers: ['User', 'Input Payload'],
      rows: [
        ['Alice', '=cmd|\' /C calc\'!A0'],
        ['Bob', '-1+1'],
        ['Charlie', '+12345'],
        ['David', '@SUM(A1:A10)'],
        ['Eve', '\t=2+2'],
        ['Frank', 'Normal Text'],
        ['Grace', -99], // 纯数字，非公式注入字符串
      ],
    },
  };

  const res = exportDocumentCandidate(dangerousDoc, { format: 'xlsx' });
  assert.ok(res.degradations.length >= 5);

  // 验证 degradations 明确记录了被转义的单元格位置
  const escapedTypes = res.degradations.filter((d) => d.type === 'formula_injection_escaped');
  assert.ok(escapedTypes.length >= 5);

  // 读取生成的 Excel 内容，断言前导单引号保护
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const ws = wb.Sheets['数据明细'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Alice 的内容被加上单引号前缀: "'=cmd|' /C calc'!A0"
  assert.equal(data[1][1], '\'=cmd|\' /C calc\'!A0');
  // Bob: "'-1+1"
  assert.equal(data[2][1], '\'-1+1');
  // Charlie: "'+12345"
  assert.equal(data[3][1], '\'+12345');
  // David: "'@SUM(A1:A10)"
  assert.equal(data[4][1], '\'@SUM(A1:A10)');
  // Frank 正常文本不被转义
  assert.equal(data[6][1], 'Normal Text');
  // Grace 真实负数保持原样
  assert.equal(data[7][1], -99);
});

test('8. 顶层独立表格与空值/Null 容错测试', () => {
  const tableDoc = {
    title: 'Stand-Alone Table',
    table: {
      headers: ['Col 1', 'Col 2', 'Col 3'],
      rows: [
        ['val', null, null],
        ['', 0, '否'],
      ],
    },
  };

  for (const fmt of ['docx', 'xlsx', 'pdf']) {
    const res = exportDocumentCandidate(tableDoc, { format: fmt });
    assert.ok(res.byteCount > 0);
    assert.equal(res.format, fmt);
  }
});

test('input guard runs before any format generator and rejects unsafe structure', () => {
  let getterCalls = 0;
  const accessor = { title: 'safe' };
  Object.defineProperty(accessor, 'sections', { enumerable: true, get() { getterCalls++; throw Error('secret'); } });
  assert.throws(() => exportDocumentCandidate(accessor, { format: 'docx' }), { code: 'DOC_GETTER_PROHIBITED' });
  assert.equal(getterCalls, 0);
  assert.throws(() => exportDocumentCandidate({ title: 'safe', sections: [{ paragraphs: Array(10_001).fill('') }] },
    { format: 'pdf' }), { code: 'DOC_PARAGRAPHS_LIMIT_EXCEEDED' });
  assert.throws(() => exportDocumentCandidate({ title: 'safe', table: { headers: ['flag'], rows: [[true]] } },
    { format: 'xlsx' }), { code: 'DOC_INVALID_TYPE' });
});


test('XLSX sheet names are legal and unique without losing tables', () => {
  const headings = ['概览', 'DATA', 'data', 'bad:/\\?*[]name', "''", 'L'.repeat(40), 'L'.repeat(40), 'x'.repeat(30) + '🙂'];
  const doc = { title: 'Sheet naming fixture', sections: headings.map((heading, i) => ({ heading,
    table: { headers: ['value'], rows: [[i]] } })) };
  const result = exportDocumentCandidate(doc, { format: 'xlsx' });
  const wb = XLSX.read(result.buffer, { type: 'buffer' });
  assert.equal(wb.SheetNames.length, headings.length + 1);
  assert.equal(new Set(wb.SheetNames.map(name => name.toLowerCase())).size, wb.SheetNames.length);
  for (const [index, name] of wb.SheetNames.slice(1).entries()) {
    assert.ok(name.length > 0 && name.length <= 31);
    assert.doesNotMatch(name, /[\[\]\\/?*:\x00-\x1f\x7f]/);
    assert.doesNotMatch(name, /[\uD800-\uDBFF]$/);
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 })[1][0], index);
  }
  assert.ok(result.degradations.some(item => item.type === 'sheet_name_normalized'));
});
