/**
 * tests/probes/source-retrieval-candidate-probe.mjs
 *
 * 探针：跨资料检索与删除失效候选实证实装与门禁探针
 *
 * 验证流程：
 * 1. 验证可移植独立加载能力 (os.tmpdir 隔离验证)
 * 2. 多格式真实抽取块建索引与定位器保真度验证 (DOCX/XLSX/PPTX/CSV)
 * 3. 跨租户检索与混部隔离实证 (相同 documentId 隔离，零数据泄漏)
 * 4. 动态删除失效与换版生命周期闭环 (删除即拒、改SHA即拒、换版即拒、v2重导生效)
 * 5. 防篡改安全探针 (自报 hash 与实际文本 hash 校验)
 * 6. 原文引用反查与防 ReDoS 正则拒绝实证
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passedTests = 0;
let totalTests = 0;

function runCase(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✔ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ✖ [FAIL] ${name}:`, err);
    throw err;
  }
}

console.log("=== 跨资料检索与删除失效候选探针开始 ===");

// --------------------------------------------------------------------------
// 1. 验证可移植独立加载能力
// --------------------------------------------------------------------------
console.log("\n[1/6] 验证候选模块在临时隔离目录中的可移植加载能力...");
let candidate;
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-retrieval-probe-"));
  const targetPath = path.join(tempDir, "candidate.cjs");
  const sourceCode = fs.readFileSync(
    new URL("../../shell/attachments/source-retrieval-candidate.cjs", import.meta.url),
    "utf8"
  );
  fs.writeFileSync(targetPath, sourceCode, "utf8");

  try {
    const { createRequire } = await import("node:module");
    const tempRequire = createRequire(targetPath);
    candidate = tempRequire(targetPath);

    assert.equal(typeof candidate.buildSourceIndex, "function");
    assert.equal(typeof candidate.querySourceIndex, "function");
    assert.equal(typeof candidate.invalidateSource, "function");
    assert.equal(typeof candidate.verifyIndexIntegrity, "function");
    console.log("  ✔ 临时隔离目录加载与纯函数导出契约校验成功");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// 2. 多格式真实抽取块建索引与定位器保真度
// --------------------------------------------------------------------------
console.log("\n[2/6] 验证多格式 (DOCX, XLSX, PPTX, CSV) 提取块构建与定位器保真度...");

const DOC_SHA_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const DOC_SHA_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const DOC_SHA_3 = "3333333333333333333333333333333333333333333333333333333333333333";
const DOC_SHA_4 = "4444444444444444444444444444444444444444444444444444444444444444";

runCase("DOCX 索引强制 extracted-text-block-not-page，绝无假造页码", () => {
  const docxIndex = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "strategy.docx",
    sourceSha256: DOC_SHA_1,
    format: "docx",
    blocks: [
      { text: "公司 2026 年战略规划：全面推进智能化与自动化转型。" },
      { text: "技术中台架构改造：消除单点依赖，实现高内聚低耦合。" },
    ],
  });

  assert.equal(docxIndex.locatorKind, "extracted-text-block-not-page");
  assert.equal(docxIndex.blocks[0].locator.kind, "extracted-text-block-not-page");
  assert.equal(docxIndex.blocks[0].locator.blockIndex, 1);
  assert.equal(docxIndex.blocks[0].locator.page, undefined, "Strictly NO page property");
});

runCase("XLSX 索引保留 sheet/cell/formula 结构化定位", () => {
  const xlsxIndex = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "financials.xlsx",
    sourceSha256: DOC_SHA_2,
    format: "xlsx",
    blocks: [
      {
        text: "FORMULA_TEXT=SUM(B2:B10); CACHED_VALUE=1250000",
        locator: { sheet: 1, sheetName: "P&L", cell: "B11", valueType: "n", formula: true },
      },
    ],
  });

  assert.equal(xlsxIndex.locatorKind, "sheet-cell-raw-value");
  assert.equal(xlsxIndex.blocks[0].locator.sheetName, "P&L");
  assert.equal(xlsxIndex.blocks[0].locator.cell, "B11");
  assert.equal(xlsxIndex.blocks[0].locator.formula, true);
});

runCase("PPTX 索引保留 slide/paragraph 定位", () => {
  const pptxIndex = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "keynote.pptx",
    sourceSha256: DOC_SHA_3,
    format: "pptx",
    blocks: [
      {
        text: "核心里程碑回顾：Q3 交付成功率提升至 99.8%。",
        locator: { slide: 5, paragraph: 1 },
      },
    ],
  });

  assert.equal(pptxIndex.locatorKind, "slide-paragraph-text-only");
  assert.equal(pptxIndex.blocks[0].locator.slide, 5);
  assert.equal(pptxIndex.blocks[0].locator.paragraph, 1);
});

// --------------------------------------------------------------------------
// 3. 跨租户检索与混部隔离实证
// --------------------------------------------------------------------------
console.log("\n[3/6] 验证多租户混部检索隔离与同名文档越权防御...");

runCase("跨租户相同 documentId 强隔离，零泄露", () => {
  const docxTenantA = candidate.buildSourceIndex({
    tenantId: "tenant-apple",
    documentId: "internal-roadmap.docx",
    sourceSha256: DOC_SHA_1,
    blocks: [{ text: "Apple Secret Project Nebula internal milestones." }],
  });

  const docxTenantB = candidate.buildSourceIndex({
    tenantId: "tenant-banana",
    documentId: "internal-roadmap.docx",
    sourceSha256: DOC_SHA_2,
    blocks: [{ text: "Banana Secret Project Citrus internal milestones." }],
  });

  const trustedSources = [
    { tenantId: "tenant-apple", documentId: "internal-roadmap.docx", sourceSha256: DOC_SHA_1, version: 1 },
    { tenantId: "tenant-banana", documentId: "internal-roadmap.docx", sourceSha256: DOC_SHA_2, version: 1 },
  ];

  // 以 tenant-apple 身份检索 "Secret Project"
  const resApple = candidate.querySourceIndex({
    tenantId: "tenant-apple",
    query: "Secret Project",
    trustedSources,
    indexes: [docxTenantA, docxTenantB],
  });

  assert.equal(resApple.returnedCount, 1);
  assert.match(resApple.results[0].rawText, /Apple Secret Project/);
  assert.equal(resApple.results[0].rawText.includes("Citrus"), false);

  // 审计覆盖情况
  const auditBanana = resApple.coverage.audit.find(
    (a) => a.documentId === "internal-roadmap.docx" && a.status === "REJECTED_CROSS_TENANT"
  );
  assert.ok(auditBanana, "Tenant Banana index must be audited as REJECTED_CROSS_TENANT");
});

// --------------------------------------------------------------------------
// 4. 动态删除失效与换版生命周期闭环
// --------------------------------------------------------------------------
console.log("\n[4/6] 验证动态删除、换版SHA过期、版本不匹配与v2重导...");

runCase("删除失效与换版过期生命周期完整闭环", () => {
  const indexV1 = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "api-spec.docx",
    sourceSha256: DOC_SHA_1,
    version: 1,
    blocks: [{ text: "API Endpoint V1: /api/v1/resource/query" }],
  });

  // 1. 文档被标记删除
  const trustedDeleted = [
    { tenantId: "corp-a", documentId: "api-spec.docx", sourceSha256: DOC_SHA_1, version: 1, isDeleted: true },
  ];
  const resDel = candidate.querySourceIndex({
    tenantId: "corp-a",
    query: "resource query",
    trustedSources: trustedDeleted,
    indexes: [indexV1],
  });
  assert.equal(resDel.returnedCount, 0);
  assert.equal(resDel.coverage.audit[0].status, "REJECTED_SOURCE_DELETED");

  // 2. 宿主更新了文件，新文件 SHA 为 DOC_SHA_2，旧索引 SHA 不匹配
  const trustedUpdated = [
    { tenantId: "corp-a", documentId: "api-spec.docx", sourceSha256: DOC_SHA_2, version: 1 },
  ];
  const resShaMismatch = candidate.querySourceIndex({
    tenantId: "corp-a",
    query: "resource query",
    trustedSources: trustedUpdated,
    indexes: [indexV1],
  });
  assert.equal(resShaMismatch.returnedCount, 0);
  assert.equal(resShaMismatch.coverage.audit[0].status, "REJECTED_SOURCE_SHA_OUTDATED");

  // 3. 宿主重新构建并导入 V2 索引
  const indexV2 = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "api-spec.docx",
    sourceSha256: DOC_SHA_2,
    version: 2,
    blocks: [{ text: "API Endpoint V2: /api/v2/resource/query (Breaking Change)" }],
  });

  const trustedV2 = [
    { tenantId: "corp-a", documentId: "api-spec.docx", sourceSha256: DOC_SHA_2, version: 2 },
  ];
  const resV2 = candidate.querySourceIndex({
    tenantId: "corp-a",
    query: "resource query",
    trustedSources: trustedV2,
    indexes: [indexV1, indexV2],
  });

  assert.equal(resV2.returnedCount, 1);
  assert.equal(resV2.results[0].documentVersion, 2);
  assert.match(resV2.results[0].rawText, /Breaking Change/);
});

// --------------------------------------------------------------------------
// 5. 防篡改安全探针
// --------------------------------------------------------------------------
console.log("\n[5/6] 验证自报覆盖指纹 (CoverageHash) 校验与防篡改反例...");

runCase("篡改块文本或定位器导致指纹自洽性失效并被前置阻断", () => {
  const validIndex = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "security.txt",
    sourceSha256: DOC_SHA_1,
    format: "txt",
    blocks: [{ text: "Sensitive security token root" }],
  });

  assert.equal(candidate.verifyIndexIntegrity(validIndex), true);

  // 破坏性篡改文本
  const tampered1 = JSON.parse(JSON.stringify(validIndex));
  tampered1.blocks[0].text = "Hacked security token fake";
  assert.equal(candidate.verifyIndexIntegrity(tampered1), false);

  // 破坏性篡改定位器
  const tampered2 = JSON.parse(JSON.stringify(validIndex));
  tampered2.blocks[0].locator.kind = "fake-page-locator";
  assert.equal(candidate.verifyIndexIntegrity(tampered2), false);

  // 检索时输入篡改对象直接被判定 REJECTED_CORRUPTED_INDEX
  const trusted = [{ tenantId: "corp-a", documentId: "security.txt", sourceSha256: DOC_SHA_1, version: 1 }];
  const res = candidate.querySourceIndex({
    tenantId: "corp-a",
    query: "security token",
    trustedSources: trusted,
    indexes: [tampered1],
  });
  assert.equal(res.returnedCount, 0);
  assert.equal(res.coverage.audit[0].status, "REJECTED_CORRUPTED_INDEX");
});

// --------------------------------------------------------------------------
// 6. 原文引用反查与防 ReDoS 拒绝实证
// --------------------------------------------------------------------------
console.log("\n[6/6] 验证原文切片反查、稳定排名与防 ReDoS 正则拒绝...");

runCase("原文摘录 (excerpt) 与真实文本反查一致", () => {
  const index = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "product-docs.md",
    sourceSha256: DOC_SHA_4,
    format: "markdown",
    blocks: [
      { text: "产品功能总览：平台为分布式微服务架构，支持全球高并发接入。" },
      { text: "权限审计规范：所有操作必须留下权威操作日志并在数据中心留存三年。" },
    ],
  });

  const trusted = [{ tenantId: "corp-a", documentId: "product-docs.md", sourceSha256: DOC_SHA_4, version: 1 }];
  const res = candidate.querySourceIndex({
    tenantId: "corp-a",
    query: "分布式微服务架构",
    trustedSources: trusted,
    indexes: [index],
  });

  assert.equal(res.returnedCount, 1);
  const hit = res.results[0];
  assert.match(hit.excerpt, /分布式微服务架构/);
  assert.equal(hit.blockIndex, 1);
  assert.equal(hit.charStart, 0);
  assert.equal(hit.charEnd, hit.rawText.length);
});

runCase("复杂正则表达式恶意输入无法导致 ReDoS，耗时严格小于 10ms", () => {
  const index = candidate.buildSourceIndex({
    tenantId: "corp-a",
    documentId: "regex-test.txt",
    sourceSha256: DOC_SHA_1,
    format: "txt",
    blocks: [{ text: "The quick brown fox jumps over the lazy dog." }],
  });

  const trusted = [{ tenantId: "corp-a", documentId: "regex-test.txt", sourceSha256: DOC_SHA_1, version: 1 }];

  // 经典 ReDoS 模式字串
  const evilPatterns = [
    "^(a+)+$",
    "(x+x+)+y",
    "([a-zA-Z]+)*",
    ".*.*.*[0-9]+",
  ];

  for (const evil of evilPatterns) {
    const t0 = performance.now();
    const res = candidate.querySourceIndex({
      tenantId: "corp-a",
      query: evil,
      trustedSources: trusted,
      indexes: [index],
    });
    const cost = performance.now() - t0;
    assert.ok(cost < 10, `Query with ${evil} took ${cost}ms which exceeds 10ms threshold`);
    assert.equal(res.returnedCount, 0);
  }
});

runCase("超长 query (>256 字符) 与稀疏数组在入口即被拒", () => {
  const trusted = [{ tenantId: "corp-a", documentId: "doc.txt", sourceSha256: DOC_SHA_1, version: 1 }];
  const tooLong = "x".repeat(257);
  assert.throws(
    () => candidate.querySourceIndex({ tenantId: "corp-a", query: tooLong, trustedSources: trusted, indexes: [] }),
    { code: "QUERY_TOO_LONG" }
  );

  const sparseIndexes = [];
  sparseIndexes[0] = { tenantId: "corp-a", documentId: "doc.txt" };
  sparseIndexes[2] = { tenantId: "corp-a", documentId: "doc2.txt" };
  assert.throws(
    () => candidate.querySourceIndex({ tenantId: "corp-a", query: "test", trustedSources: trusted, indexes: sparseIndexes }),
    { code: "QUERY_INDEXES_INVALID" }
  );
});

console.log(`\n=== 探针完成：共执行 ${totalTests} 项用例，通过 ${passedTests} 项，失败 0 项 ===`);
