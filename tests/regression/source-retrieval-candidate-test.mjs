/**
 * tests/regression/source-retrieval-candidate-test.mjs
 *
 * 单元回归测试：跨资料检索与删除失效候选 (Source Retrieval Candidate)
 *
 * 覆盖关键规范：
 * 1. buildSourceIndex 资源门禁 (Reject-before-Scan)、稀疏数组拦截、不可变冻结
 * 2. 相同 documentId 跨租户强隔离测试
 * 3. 篡改 blocks / locator / coverageHash 校验拦截
 * 4. 存活清单失效检测：删除文件失效、换版旧 SHA 失效、版本升级失效、重新导入 v2 生效
 * 5. 定位器保真度：DOCX 绝不冒充页码，XLSX 保留 sheet/cell，PPTX 保留 slide/paragraph
 * 6. 确定性检索安全：防范 ReDoS（不编译正则）、中文字词匹配、稳定排名与原文可反查
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildSourceIndex,
  querySourceIndex,
  invalidateSource,
  verifyIndexIntegrity,
  LIMITS,
} = require('../../shell/attachments/source-retrieval-candidate.cjs');

const VALID_SHA_A = 'a'.repeat(64);
const VALID_SHA_B = 'b'.repeat(64);
const VALID_SHA_C = 'c'.repeat(64);

test('Source Retrieval - buildSourceIndex 输入门禁与前置拦截 (Reject-before-Scan)', () => {
  // 1. 非法 tenantId 或 documentId
  assert.throws(
    () => buildSourceIndex({ tenantId: '', documentId: 'doc1', sourceSha256: VALID_SHA_A, blocks: [] }),
    { code: 'INDEX_TENANT_INVALID' }
  );
  assert.throws(
    () => buildSourceIndex({ tenantId: 'tenant-1', documentId: '', sourceSha256: VALID_SHA_A, blocks: [] }),
    { code: 'INDEX_DOCUMENT_ID_INVALID' }
  );
  assert.throws(
    () => buildSourceIndex({ tenantId: 'tenant-1', documentId: 'doc1', sourceSha256: 'invalid-sha', blocks: [] }),
    { code: 'INDEX_SOURCE_SHA_INVALID' }
  );
  assert.throws(
    () => buildSourceIndex({ tenantId: 'tenant-1', documentId: 'doc1', sourceSha256: VALID_SHA_A, version: 0, blocks: [] }),
    { code: 'INDEX_VERSION_INVALID' }
  );

  // 2. 稀疏数组拦截 (sparse array)
  const sparseBlocks = [];
  sparseBlocks[0] = { text: 'block 1' };
  sparseBlocks[2] = { text: 'block 3' }; // index 1 为空洞
  assert.throws(
    () => buildSourceIndex({ tenantId: 'tenant-1', documentId: 'doc1', sourceSha256: VALID_SHA_A, blocks: sparseBlocks }),
    { code: 'INDEX_BLOCKS_INVALID' }
  );

  // 3. 不连续序号拦截
  assert.throws(
    () => buildSourceIndex({
      tenantId: 'tenant-1',
      documentId: 'doc1',
      sourceSha256: VALID_SHA_A,
      blocks: [
        { index: 1, text: 'First' },
        { index: 3, text: 'Jump to 3' }, // 序号不连续
      ],
    }),
    { code: 'INDEX_SEQUENCE_DISCONTINUITY' }
  );

  // 4. 正常构建且产物被深度冻结
  const index = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'financial-report.docx',
    sourceSha256: VALID_SHA_A,
    version: 1,
    format: 'docx',
    blocks: [
      { text: '第一季度财报摘要：营收增长 15%。' },
      { text: '研发投入占比同比提高 3 个百分点。' },
    ],
  });

  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.blocks));
  assert.ok(Object.isFrozen(index.blocks[0]));
  assert.equal(index.summary.totalBlocks, 2);
  assert.equal(index.summary.nonEmptyBlocks, 2);
  assert.equal(typeof index.summary.coverageHash, 'string');
  assert.equal(index.summary.coverageHash.length, 64);
});

test('Source Retrieval - 跨租户强隔离与相同 documentId 防越权', () => {
  // 两个不同租户各自持有一个同名文档 "contracts.docx"
  const indexTenantA = buildSourceIndex({
    tenantId: 'tenant-alpha',
    documentId: 'contracts.docx',
    sourceSha256: VALID_SHA_A,
    blocks: [{ text: 'Alpha Corp Confidential Agreement Terms' }],
  });

  const indexTenantB = buildSourceIndex({
    tenantId: 'tenant-beta',
    documentId: 'contracts.docx',
    sourceSha256: VALID_SHA_B,
    blocks: [{ text: 'Beta LLC Confidential Agreement Terms' }],
  });

  const trustedSources = [
    { documentId: 'contracts.docx', tenantId: 'tenant-alpha', sourceSha256: VALID_SHA_A, version: 1 },
    { documentId: 'contracts.docx', tenantId: 'tenant-beta', sourceSha256: VALID_SHA_B, version: 1 },
  ];

  // Alpha 租户查询
  const resultAlpha = querySourceIndex({
    tenantId: 'tenant-alpha',
    query: 'Confidential Agreement',
    trustedSources,
    indexes: [indexTenantA, indexTenantB],
  });

  assert.equal(resultAlpha.returnedCount, 1);
  assert.equal(resultAlpha.results[0].documentId, 'contracts.docx');
  assert.match(resultAlpha.results[0].rawText, /Alpha Corp/);
  // Beta 的索引被明确记录为跨租户拦截
  const betaAudit = resultAlpha.coverage.audit.find((a) => a.status === 'REJECTED_CROSS_TENANT');
  assert.ok(betaAudit);
});

test('Source Retrieval - 篡改检测 (Tamper Detection) 与哈希自洽性', () => {
  const normalIndex = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'audit.docx',
    sourceSha256: VALID_SHA_A,
    blocks: [{ text: '原始数据，不可篡改' }],
  });

  assert.equal(verifyIndexIntegrity(normalIndex), true);

  // 模拟非法反序列化或恶意篡改（通过深拷贝破坏 Object.freeze）
  const tamperedIndex = JSON.parse(JSON.stringify(normalIndex));
  tamperedIndex.blocks[0].text = '被恶意修改的内容';

  assert.equal(verifyIndexIntegrity(tamperedIndex), false);

  const check = invalidateSource({ index: tamperedIndex });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'INDEX_COVERAGE_HASH_TAMPERED');

  // 查询时输入被篡改的索引，必定被前置门禁拦截拒绝
  const trustedSources = [{ tenantId: 'tenant-1', documentId: 'audit.docx', sourceSha256: VALID_SHA_A, version: 1 }];
  const queryRes = querySourceIndex({
    tenantId: 'tenant-1',
    query: '恶意修改',
    trustedSources,
    indexes: [tamperedIndex],
  });

  assert.equal(queryRes.returnedCount, 0);
  assert.equal(queryRes.coverage.rejectedDocuments, 1);
  assert.equal(queryRes.coverage.audit[0].status, 'REJECTED_CORRUPTED_INDEX');
});

test('Source Retrieval - 动态失效守卫：删除、旧SHA换版、旧版本拒绝与v2重导生效', () => {
  const indexV1 = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'spec.docx',
    sourceSha256: VALID_SHA_A,
    version: 1,
    blocks: [{ text: 'Specification Version 1.0 details.' }],
  });

  // 场景 1: 文件在可信清单中已被删除 (isDeleted: true)
  const trustedDeleted = [{ tenantId: 'tenant-1', documentId: 'spec.docx', sourceSha256: VALID_SHA_A, version: 1, isDeleted: true }];
  const resDeleted = querySourceIndex({
    tenantId: 'tenant-1',
    query: 'Specification',
    trustedSources: trustedDeleted,
    indexes: [indexV1],
  });
  assert.equal(resDeleted.returnedCount, 0);
  assert.equal(resDeleted.coverage.audit[0].status, 'REJECTED_SOURCE_DELETED');

  // 场景 2: 文件未在可信清单中登记（彻底删除/未知源）
  const resUnknown = querySourceIndex({
    tenantId: 'tenant-1',
    query: 'Specification',
    trustedSources: [],
    indexes: [indexV1],
  });
  assert.equal(resUnknown.returnedCount, 0);
  assert.equal(resUnknown.coverage.audit[0].status, 'REJECTED_DELETED_OR_UNKNOWN');

  // 场景 3: 宿主文件已被替换，SHA-256 发生改变 (旧 SHA 失效)
  const trustedUpdatedSha = [{ tenantId: 'tenant-1', documentId: 'spec.docx', sourceSha256: VALID_SHA_B, version: 1 }];
  const resOldSha = querySourceIndex({
    tenantId: 'tenant-1',
    query: 'Specification',
    trustedSources: trustedUpdatedSha,
    indexes: [indexV1],
  });
  assert.equal(resOldSha.returnedCount, 0);
  assert.equal(resOldSha.coverage.audit[0].status, 'REJECTED_SOURCE_SHA_OUTDATED');

  // 场景 4: 重新导入版本 v2 (新 SHA-256 VALID_SHA_B, version 2)
  const indexV2 = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'spec.docx',
    sourceSha256: VALID_SHA_B,
    version: 2,
    blocks: [{ text: 'Specification Version 2.0 updated details.' }],
  });

  const trustedV2 = [{ tenantId: 'tenant-1', documentId: 'spec.docx', sourceSha256: VALID_SHA_B, version: 2 }];
  const resV2 = querySourceIndex({
    tenantId: 'tenant-1',
    query: 'Specification',
    trustedSources: trustedV2,
    indexes: [indexV1, indexV2], // 同时存在新旧两份索引
  });

  // 旧 V1 被 REJECTED_SOURCE_SHA_OUTDATED 拦截，新 V2 成功返回
  assert.equal(resV2.returnedCount, 1);
  assert.equal(resV2.results[0].documentVersion, 2);
  assert.equal(resV2.results[0].sourceSha256, VALID_SHA_B);
  assert.match(resV2.results[0].rawText, /Version 2.0/);
});

test('Source Retrieval - 多格式定位器保真度 (DOCX不冒充页码, XLSX保留sheet/cell, PPTX保留slide)', () => {
  // 1. DOCX 定位器
  const docxIndex = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'manual.docx',
    sourceSha256: VALID_SHA_A,
    format: 'docx',
    blocks: [{ text: 'Section 1 paragraph' }],
  });
  assert.equal(docxIndex.locatorKind, 'extracted-text-block-not-page');
  assert.equal(docxIndex.blocks[0].locator.kind, 'extracted-text-block-not-page');
  assert.equal(docxIndex.blocks[0].locator.blockIndex, 1);

  // 2. XLSX 定位器
  const xlsxIndex = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'budget.xlsx',
    sourceSha256: VALID_SHA_B,
    format: 'xlsx',
    blocks: [
      {
        text: 'Total Revenue: 500000',
        locator: { sheet: 1, sheetName: 'Q1Summary', cell: 'C10', valueType: 'n', formula: true },
      },
    ],
  });
  assert.equal(xlsxIndex.locatorKind, 'sheet-cell-raw-value');
  assert.equal(xlsxIndex.blocks[0].locator.kind, 'sheet-cell');
  assert.equal(xlsxIndex.blocks[0].locator.sheetName, 'Q1Summary');
  assert.equal(xlsxIndex.blocks[0].locator.cell, 'C10');
  assert.equal(xlsxIndex.blocks[0].locator.formula, true);

  // 3. PPTX 定位器
  const pptxIndex = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'pitch.pptx',
    sourceSha256: VALID_SHA_C,
    format: 'pptx',
    blocks: [
      {
        text: 'Roadmap for 2027',
        locator: { slide: 3, paragraph: 2 },
      },
    ],
  });
  assert.equal(pptxIndex.locatorKind, 'slide-paragraph-text-only');
  assert.equal(pptxIndex.blocks[0].locator.kind, 'slide-paragraph');
  assert.equal(pptxIndex.blocks[0].locator.slide, 3);
  assert.equal(pptxIndex.blocks[0].locator.paragraph, 2);
});

test('Source Retrieval - 确定性词法检索、中文支持与防 ReDoS 正则灾难', () => {
  const index = buildSourceIndex({
    tenantId: 'tenant-1',
    documentId: 'knowledge.txt',
    sourceSha256: VALID_SHA_A,
    format: 'txt',
    blocks: [
      { text: '深度学习模型微调技术指南：LoRA 与 QLoRA 参数高效微调方法详解。' },
      { text: '测试特殊正则表达式输入：.*.*[a-z]+(foo|bar)$^ 以及其它转义字符。' },
      { text: '云原生架构高可用方案设计，涉及分布式事务与最终一致性保证。' },
    ],
  });

  const trustedSources = [{ tenantId: 'tenant-1', documentId: 'knowledge.txt', sourceSha256: VALID_SHA_A, version: 1 }];

  // 1. 中文多词查询
  const resZh = querySourceIndex({
    tenantId: 'tenant-1',
    query: '微调技术指南',
    trustedSources,
    indexes: [index],
  });
  assert.equal(resZh.returnedCount, 1);
  assert.match(resZh.results[0].excerpt, /微调技术指南/);
  assert.equal(resZh.results[0].blockIndex, 1);

  // 2. 传入极具危害性的正则表达式模式字符串，验证系统绝不编译正则（零崩溃、零死循环）
  const maliciousRegexQuery = '.*.*[a-z]+(foo|bar)$^';
  const t0 = Date.now();
  const resRegex = querySourceIndex({
    tenantId: 'tenant-1',
    query: maliciousRegexQuery,
    trustedSources,
    indexes: [index],
  });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 100, `Query should complete instantly, took ${elapsed}ms`);
  assert.equal(resRegex.returnedCount, 1);
  assert.equal(resRegex.results[0].blockIndex, 2);
  assert.match(resRegex.results[0].rawText, /特殊正则表达式/);
});
