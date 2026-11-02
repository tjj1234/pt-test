import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  guardStructuredDocumentInput,
  DEFAULT_INPUT_LIMITS,
  HARD_INPUT_LIMITS,
  DOC_INPUT_ERROR_CODES,
  countCodePoints,
  resolveLimits,
} = require('../../shell/exports/document-input-guard-candidate.cjs');

test('paragraph count, cell type and serialized byte size are bounded before export', () => {
  assert.throws(() => guardStructuredDocumentInput({ title: 'x', sections: [{ paragraphs: ['a', 'b', 'c'] }] },
    { maxParagraphs: 2 }), { code: 'DOC_PARAGRAPHS_LIMIT_EXCEEDED' });
  assert.throws(() => guardStructuredDocumentInput({ title: 'x', table: { headers: ['flag'], rows: [[true]] } }),
    { code: 'DOC_INVALID_TYPE' });
  const guarded = guardStructuredDocumentInput({ title: 'x', sections: [{ paragraphs: ['\u0000'] }] });
  assert.equal(guarded.diagnostics.totalBytes,
    Buffer.byteLength(JSON.stringify(guarded.normalized), 'utf8'));
});

function makeValidDoc() {
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
          12345, // 支持有限数字段落
        ],
        table: {
          headers: ['渠道名称', '投放消耗 (USD)', '转化人数', 'ROAS', '是否推荐'],
          rows: [
            ['Meta Ads', 7500, 1820, 2.45, '是'],
            ['Google Ads', 5800, 1310, 2.18, '是'],
            ['X Ads', 1900, 290, 1.85, '否'],
            ['Organic / Direct', 0, 450, null, null],
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

test('1. 基础合法结构化文档输入校验与深冻结规范化副本', () => {
  const originalInput = makeValidDoc();
  const res = guardStructuredDocumentInput(originalInput);

  assert.ok(res.normalized, '返回 normalized 对象');
  assert.ok(res.diagnostics, '返回 diagnostics 对象');

  // 1. 字段映射完整
  assert.equal(res.normalized.title, originalInput.title);
  assert.equal(res.normalized.author, originalInput.author);
  assert.equal(res.normalized.date, originalInput.date);
  assert.equal(res.normalized.sections.length, 2);
  assert.equal(res.normalized.sections[0].paragraphs.length, 3);
  assert.equal(res.normalized.sections[0].table.rows.length, 4);

  // 2. 深冻结验证
  assert.ok(Object.isFrozen(res.normalized));
  assert.ok(Object.isFrozen(res.normalized.sections));
  assert.ok(Object.isFrozen(res.normalized.sections[0]));
  assert.ok(Object.isFrozen(res.normalized.sections[0].paragraphs));
  assert.ok(Object.isFrozen(res.normalized.sections[0].table));
  assert.ok(Object.isFrozen(res.normalized.sections[0].table.headers));
  assert.ok(Object.isFrozen(res.normalized.sections[0].table.rows));
  assert.ok(Object.isFrozen(res.normalized.sections[0].table.rows[0]));
  assert.ok(Object.isFrozen(res.diagnostics));

  // 冻结对象不可修改
  assert.throws(() => {
    'use strict';
    res.normalized.title = '篡改标题';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    res.normalized.sections[0].paragraphs.push('新段落');
  }, TypeError);

  // 3. 原始入参保持未冻结且未修改
  assert.equal(Object.isFrozen(originalInput), false);
  assert.equal(Object.isFrozen(originalInput.sections), false);
  assert.equal(Object.isFrozen(originalInput.sections[0].paragraphs), false);
  originalInput.sections[0].paragraphs.push('可以原地修改原始入参');
  assert.equal(res.normalized.sections[0].paragraphs.length, 3, '规范化副本不受原始入参后续变更影响');

  // 4. 诊断信息纯计数指标
  assert.ok(res.diagnostics.totalBytes > 0);
  assert.equal(res.diagnostics.sectionCount, 2);
  assert.equal(res.diagnostics.tableCount, 1);
  assert.equal(res.diagnostics.rowCount, 4);
  assert.equal(res.diagnostics.cellCount, 25); // 表头 5 + 4 行 * 5 列 = 25
  assert.ok(res.diagnostics.maxDepth >= 5);
});

test('2. 中文与多字节 Emoji UTF-8 字节数与 Unicode Code Point 统计', () => {
  // '你好'：2 个 code point，UTF-8 为 6 字节
  // '🚀🎉'：2 个 code point，UTF-16 长度为 4 (两个代理项对)，UTF-8 为 8 字节
  const emojiStr = '🚀🎉';
  assert.equal(emojiStr.length, 4);
  assert.equal(countCodePoints(emojiStr), 2);
  assert.equal(Buffer.byteLength(emojiStr, 'utf8'), 8);

  // 校验 code point 上限限制
  const doc = {
    title: 'Emoji 测试',
    sections: [
      {
        paragraphs: ['🎉'.repeat(10)], // 10 个 emoji code points
      },
    ],
  };

  // 允许 10 个 code points
  const okRes = guardStructuredDocumentInput(doc, { maxCodePointsPerField: 10 });
  assert.equal(okRes.normalized.sections[0].paragraphs[0], '🎉'.repeat(10));

  // 超限 11 个 code points
  const exceedDoc = {
    title: 'Emoji 超限',
    sections: [
      {
        paragraphs: ['🎉'.repeat(11)],
      },
    ],
  };
  assert.throws(
    () => guardStructuredDocumentInput(exceedDoc, { maxCodePointsPerField: 10 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.CODEPOINTS_LIMIT_EXCEEDED
  );

  // 标题专用 code point 边界
  assert.throws(
    () => guardStructuredDocumentInput({ title: 'A'.repeat(6) }, { maxTitleCodePoints: 5 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.CODEPOINTS_LIMIT_EXCEEDED
  );
});

test('3. 增量 UTF-8 字节超限立即阻断', () => {
  // 设置极小 maxBytes (例如 120 字节)
  const smallLimit = { maxBytes: 120 };

  const validSmall = {
    title: 'Short',
    author: 'Bob',
  };
  const ok = guardStructuredDocumentInput(validSmall, smallLimit);
  assert.ok(ok.diagnostics.totalBytes <= 120);

  const exceedSmall = {
    title: 'Short',
    author: 'A'.repeat(150),
  };
  assert.throws(
    () => guardStructuredDocumentInput(exceedSmall, smallLimit),
    (err) => {
      assert.equal(err.code, DOC_INPUT_ERROR_CODES.BYTES_LIMIT_EXCEEDED);
      assert.match(err.message, /DOC_BYTES_LIMIT_EXCEEDED/);
      // 确保错误信息不暴露具体字符内容
      assert.ok(!err.message.includes('AAA'));
      return true;
    }
  );
});

test('4. 极长无表格纯段落文档合法性', () => {
  const paragraphs = [];
  for (let i = 0; i < 200; i++) {
    paragraphs.push(`这是第 ${i + 1} 个分析段落内容，说明大盘宏观指标走势。`);
  }

  const doc = {
    title: '无表格纯文本分析长文',
    sections: [
      {
        heading: '正文概要',
        paragraphs,
      },
    ],
  };

  const res = guardStructuredDocumentInput(doc);
  assert.equal(res.diagnostics.tableCount, 0);
  assert.equal(res.diagnostics.rowCount, 0);
  assert.equal(res.diagnostics.cellCount, 0);
  assert.equal(res.diagnostics.sectionCount, 1);
  assert.equal(res.normalized.sections[0].paragraphs.length, 200);
});

test('5. 非有限数 (NaN, Infinity, -Infinity) 严格阻断', () => {
  // 单元格包含 NaN
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: 'NaN 单元格测试',
        table: {
          headers: ['指标', '数值'],
          rows: [['转化率', NaN]],
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.NON_FINITE_NUMBER
  );

  // 单元格包含 Infinity
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: 'Infinity 单元格测试',
        table: {
          headers: ['指标', '数值'],
          rows: [['最大开销', Infinity]],
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.NON_FINITE_NUMBER
  );

  // 段落包含 -Infinity
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '段落 -Infinity 测试',
        sections: [
          {
            paragraphs: ['正常段落', -Infinity],
          },
        ],
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.NON_FINITE_NUMBER
  );

  // 合法有限数必须全部通过
  const res = guardStructuredDocumentInput({
    title: '有限数测试',
    table: {
      headers: ['A', 'B', 'C', 'D'],
      rows: [[0, -99.5, 3.14159, 1000000]],
    },
  });
  assert.equal(res.normalized.table.rows[0][1], -99.5);
});

test('6. 公式样字符串原样保留为文本', () => {
  const formulaStrings = [
    '=SUM(A1:B10)',
    '+123456',
    '-cmd|"/C calc"!A0',
    '@HYPERLINK("http://evil.com")',
    '\tTabIndented',
    '\rReturnPrefixed',
  ];

  const doc = {
    title: '公式文本保留测试',
    table: {
      headers: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
      rows: [formulaStrings],
    },
  };

  const res = guardStructuredDocumentInput(doc);
  assert.deepEqual(res.normalized.table.rows[0], formulaStrings);
  // 确认类型仍为 string，且未被转义或剔除
  for (let i = 0; i < formulaStrings.length; i++) {
    assert.equal(typeof res.normalized.table.rows[0][i], 'string');
    assert.equal(res.normalized.table.rows[0][i], formulaStrings[i]);
  }
});

test('7. 表格行列失配与空表头 Fail-Closed', () => {
  // 缺列 (表头 3 列，行仅 2 列)
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '缺列测试',
        table: {
          headers: ['A', 'B', 'C'],
          rows: [
            ['1', '2', '3'],
            ['4', '5'], // 少一列
          ],
        },
      });
    },
    (err) => {
      assert.equal(err.code, DOC_INPUT_ERROR_CODES.ROW_LENGTH_MISMATCH);
      assert.match(err.message, /has 2 columns, expected 3/);
      return true;
    }
  );

  // 多列 (表头 2 列，行有 3 列)
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '多列测试',
        table: {
          headers: ['A', 'B'],
          rows: [['1', '2', '3']],
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.ROW_LENGTH_MISMATCH
  );

  // 空表头
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '空表头测试',
        table: {
          headers: [],
          rows: [],
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.INVALID_INPUT
  );
});

test('8. 未知字段与数组自身属性污染拦截', () => {
  // 顶层未知字段
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '未知字段测试',
        maliciousMetadata: 'secret',
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD
  );

  // 章节内部未知字段
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '章节未知字段',
        sections: [
          {
            heading: '正常标题',
            extraSecretField: 42,
          },
        ],
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD
  );

  // 表格内部未知字段
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '表格未知字段',
        table: {
          headers: ['A'],
          rows: [['1']],
          injectedConfig: true,
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD
  );

  // 数组挂载非索引属性
  const pollutedRows = [['1']];
  pollutedRows.sneaky = 'polluted';
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '数组污染测试',
        table: {
          headers: ['A'],
          rows: pollutedRows,
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.UNKNOWN_FIELD
  );
});

test('9. 原型篡改与危险属性拦截', () => {
  // 自身含有 __proto__
  const evilProtoObj = JSON.parse('{"title":"test","__proto__":{"polluted":true}}');
  // 如果引擎将 __proto__ 当作自身属性
  if (Object.prototype.hasOwnProperty.call(evilProtoObj, '__proto__')) {
    assert.throws(
      () => guardStructuredDocumentInput(evilProtoObj),
      (err) => err.code === DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION
    );
  }

  // 自身含有 constructor
  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: 'Constructor 污染',
        constructor: 'evil',
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION
  );

  // 自定义类原型
  class CustomReport {
    constructor() {
      this.title = 'Custom Class';
    }
  }
  assert.throws(
    () => guardStructuredDocumentInput(new CustomReport()),
    (err) => err.code === DOC_INPUT_ERROR_CODES.PROTOTYPE_POLLUTION
  );
});

test('10. 循环引用与跨分支共享可变对象阻断', () => {
  // 1. 循环引用
  const circularDoc = { title: '循环引用测试' };
  circularDoc.sections = [{ heading: 'H1' }];
  circularDoc.sections[0].loop = circularDoc; // 自身形成闭环 (或在允许字段内闭环)

  const circularAllowed = {
    title: '循环章节',
    sections: [],
  };
  const evilSec = { heading: 'Evil' };
  evilSec.table = {
    headers: ['A'],
    rows: [],
  };
  // 制造循环
  evilSec.table.rows.push(evilSec);
  circularAllowed.sections.push(evilSec);

  assert.throws(
    () => guardStructuredDocumentInput(circularAllowed),
    (err) => err.code === DOC_INPUT_ERROR_CODES.CIRCULAR_REFERENCE || err.code === DOC_INPUT_ERROR_CODES.SHARED_REFERENCE
  );

  // 2. 跨分支共享表格对象
  const sharedTable = {
    headers: ['渠道', '指标'],
    rows: [['A', 1]],
  };
  const sharedTableDoc = {
    title: '共享表格测试',
    sections: [
      { heading: '章节 1', table: sharedTable },
      { heading: '章节 2', table: sharedTable },
    ],
  };
  assert.throws(
    () => guardStructuredDocumentInput(sharedTableDoc),
    (err) => err.code === DOC_INPUT_ERROR_CODES.SHARED_REFERENCE
  );

  // 3. 共享行数组
  const sharedRow = ['X', 'Y'];
  const sharedRowDoc = {
    title: '共享行测试',
    table: {
      headers: ['Col1', 'Col2'],
      rows: [sharedRow, sharedRow],
    },
  };
  assert.throws(
    () => guardStructuredDocumentInput(sharedRowDoc),
    (err) => err.code === DOC_INPUT_ERROR_CODES.SHARED_REFERENCE
  );
});

test('11. Getter, Setter 与 Proxy 陷阱拦截', () => {
  // 1. Getter 属性探测阻断
  let getterRan = false;
  const getterDoc = {
    get title() {
      getterRan = true;
      return 'Evil Getter Title';
    },
  };
  assert.throws(
    () => guardStructuredDocumentInput(getterDoc),
    (err) => err.code === DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED
  );
  assert.equal(getterRan, false, '门禁不得触发执行 getter 逻辑');

  // 2. 数组索引 Getter 阻断
  const evilRows = [];
  let rowGetterRan = false;
  Object.defineProperty(evilRows, '0', {
    get() {
      rowGetterRan = true;
      return ['val'];
    },
    enumerable: true,
  });
  evilRows.length = 1;

  assert.throws(
    () => {
      guardStructuredDocumentInput({
        title: '数组 Getter 测试',
        table: {
          headers: ['H1'],
          rows: evilRows,
        },
      });
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED
  );
  assert.equal(rowGetterRan, false, '门禁不得触发执行数组索引 getter 逻辑');

  // 3. Proxy 抛错陷阱拦截
  const throwingProxy = new Proxy(
    { title: 'Normal Title' },
    {
      getOwnPropertyDescriptor() {
        throw new Error('Proxy 恶意抛错');
      },
    }
  );
  assert.throws(
    () => guardStructuredDocumentInput(throwingProxy),
    (err) => err.code === DOC_INPUT_ERROR_CODES.GETTER_PROHIBITED
  );
});

test('12. 错误信息脱敏：绝不回显用户单元格内容或敏感文件路径', () => {
  const sensitiveUserPath = '/Users/secret_agent/keys/private.pem';
  const sensitiveCellText = 'CONFIDENTIAL_CUSTOMER_SSN_987-65-4321';

  // 单元格类型非法
  try {
    guardStructuredDocumentInput({
      title: '脱敏测试',
      table: {
        headers: ['安全字段'],
        rows: [[{ secretPath: sensitiveUserPath }]], // 非法对象单元格
      },
    });
    assert.fail('应当抛出错误');
  } catch (err) {
    assert.equal(err.code, DOC_INPUT_ERROR_CODES.INVALID_TYPE);
    assert.ok(!err.message.includes(sensitiveUserPath), '错误信息严禁携带路径字符串');
    assert.ok(!err.message.includes('secretPath'), '错误信息严禁携带对象键名');
  }

  // 超过 code point 限制
  try {
    guardStructuredDocumentInput(
      {
        title: 'CodePoint 脱敏测试',
        table: {
          headers: ['Col'],
          rows: [[sensitiveCellText]],
        },
      },
      { maxCodePointsPerField: 5 }
    );
    assert.fail('应当抛出错误');
  } catch (err) {
    assert.equal(err.code, DOC_INPUT_ERROR_CODES.CODEPOINTS_LIMIT_EXCEEDED);
    assert.ok(!err.message.includes(sensitiveCellText), '错误信息严禁包含用户单元格文本');
    assert.match(err.message, /limit exceeded at root\.table\.rows\[0\]\[0\]/);
  }
});

test('13. 资源边界上限与不可突破硬上限', () => {
  // 1. 用户配置超过硬上限必须直接拒绝
  assert.throws(
    () => resolveLimits({ maxBytes: HARD_INPUT_LIMITS.maxBytes + 1 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.LIMIT_EXCEEDS_CEILING
  );
  assert.throws(
    () => resolveLimits({ maxRows: HARD_INPUT_LIMITS.maxRows + 1 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.LIMIT_EXCEEDS_CEILING
  );
  assert.throws(
    () => resolveLimits({ maxDepth: HARD_INPUT_LIMITS.maxDepth + 1 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.LIMIT_EXCEEDS_CEILING
  );

  // 2. 非法配置项拒绝
  assert.throws(
    () => resolveLimits({ maxBytes: -10 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID
  );
  assert.throws(
    () => resolveLimits({ unknownOptionKey: 100 }),
    (err) => err.code === DOC_INPUT_ERROR_CODES.LIMIT_OPTION_INVALID
  );

  // 3. 最大章节数阻断
  assert.throws(
    () => {
      guardStructuredDocumentInput(
        {
          title: '章节超限',
          sections: new Array(5).fill(0).map((_, i) => ({ heading: `Sec ${i}` })),
        },
        { maxSections: 3 }
      );
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.SECTIONS_LIMIT_EXCEEDED
  );

  // 4. 最大总行数阻断
  assert.throws(
    () => {
      guardStructuredDocumentInput(
        {
          title: '行数超限',
          table: {
            headers: ['A'],
            rows: [['1'], ['2'], ['3'], ['4']],
          },
        },
        { maxRows: 3 }
      );
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.ROWS_LIMIT_EXCEEDED
  );

  // 5. 最大列数阻断
  assert.throws(
    () => {
      guardStructuredDocumentInput(
        {
          title: '列数超限',
          table: {
            headers: ['A', 'B', 'C', 'D'],
            rows: [],
          },
        },
        { maxColumnsPerTable: 3 }
      );
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.COLUMNS_LIMIT_EXCEEDED
  );

  // 6. 嵌套层级阻断
  assert.throws(
    () => {
      guardStructuredDocumentInput(
        makeValidDoc(),
        { maxDepth: 4 } // 正常包含 table 的文档深度至少 6-7
      );
    },
    (err) => err.code === DOC_INPUT_ERROR_CODES.DEPTH_LIMIT_EXCEEDED
  );
});


test('untrusted limits and document proxies are rejected without running traps or exposing keys', () => {
  let executions = 0;
  const options = Object.defineProperty({}, 'maxBytes', { enumerable: true, get() { executions++; throw Error('secret'); } });
  assert.throws(() => resolveLimits(options), { code: 'DOC_LIMIT_OPTION_INVALID' });
  const traps = { get() { executions++; throw Error('secret'); }, ownKeys() { executions++; throw Error('secret'); },
    getPrototypeOf() { executions++; throw Error('secret'); }, getOwnPropertyDescriptor() { executions++; throw Error('secret'); } };
  assert.throws(() => resolveLimits(new Proxy({}, traps)), { code: 'DOC_LIMIT_OPTION_INVALID' });
  for (const value of [new Proxy({ title: 'x' }, traps), { title: 'x', sections: new Proxy([], traps) },
    { title: 'x', table: new Proxy({ headers: ['a'], rows: [] }, traps) }]) {
    assert.throws(() => guardStructuredDocumentInput(value), { code: 'DOC_GETTER_PROHIBITED' });
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.throws(() => guardStructuredDocumentInput(revoked.proxy), { code: 'DOC_GETTER_PROHIBITED' });
  assert.throws(() => resolveLimits(revoked.proxy), { code: 'DOC_LIMIT_OPTION_INVALID' });
  for (const value of [{ title: 'x', sections: [revoked.proxy] }, { title: 'x', table: revoked.proxy },
    { title: 'x', sections: [{ table: revoked.proxy }] }, { title: 'x', sections: revoked.proxy }]) {
    assert.throws(() => guardStructuredDocumentInput(value), { code: 'DOC_GETTER_PROHIBITED' });
  }
  assert.equal(executions, 0);
  const secret = '/private/secret-key-name';
  for (const invoke of [() => resolveLimits({ [secret]: 1 }),
    () => guardStructuredDocumentInput({ title: 'x', [secret]: 1 }),
    () => guardStructuredDocumentInput({ title: 'x', sections: Object.assign([], { [secret]: 1 }) })]) {
    assert.throws(invoke, error => typeof error.code === 'string' && !error.message.includes(secret));
  }
  assert.throws(() => resolveLimits({ [Symbol('secret')]: 1 }), { code: 'DOC_LIMIT_OPTION_INVALID' });
  assert.throws(() => resolveLimits(Object.create({ maxBytes: 1 })), { code: 'DOC_LIMIT_OPTION_INVALID' });
});

test('oversized strings are rejected before JSON escaping allocates a copy', () => {
  const original = JSON.stringify;
  const long = 'x'.repeat(1000000);
  let serializedLargeValue = false;
  JSON.stringify = function (value, ...args) {
    if (value === long) serializedLargeValue = true;
    return original.call(this, value, ...args);
  };
  try {
    assert.throws(() => guardStructuredDocumentInput({ title: 'x', sections: [{ paragraphs: [long] }] }),
      { code: 'DOC_CODEPOINTS_LIMIT_EXCEEDED' });
    assert.equal(serializedLargeValue, false);
  } finally { JSON.stringify = original; }
});
