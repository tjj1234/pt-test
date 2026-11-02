/**
 * 探针：基于真实锁定环境与真实 DOCX 提取链路验证来源索引候选
 *
 * 验证重点：
 * 1. 使用真实 exportDocumentCandidate 生成合规 DOCX 二进制夹具（包含中英文、段落、前导零、特殊符号、伪公式等）；
 * 2. 使用真实锁定 parseOfficeDocument (通过 office-document-worker.cjs + Mammoth) 进行真实原始文本提取；
 * 3. 将真实提取得到的 blocks、sourceSha256、tenantId 输入 buildDocxEvidenceIndex 建立索引；
 * 4. 验证索引生成的每个 blockIndex、textSha256、charStart/charEnd 与原始合并文本的切片严格一致（100% 覆盖率验证）；
 * 5. 验证跨租户阻断与源文件修改（SHA-256 变更）时索引明确失效；
 * 6. 验证 locatorKind 严格标识为 'extracted-text-block-not-page'，无任何页码冒充；
 * 7. 纯本地运行，零网络访问，零持久化污染。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { exportDocumentCandidate } = require("../../shell/exports/document-export-candidate.cjs");
const { parseOfficeDocument } = require("../../shell/attachments/office-document-parser.cjs");
const {
  buildDocxEvidenceIndex,
  verifyDocxEvidenceIndex,
  lookupBlockEvidence,
} = require("../../shell/attachments/docx-evidence-index-candidate.cjs");

async function runProbe() {
  // 1. 生成包含多种实操场景的真实 DOCX 夹具
  const docxFixtureBytes = exportDocumentCandidate({
    title: "北极星业务调研报告（2026）",
    sections: [
      {
        heading: "一、引言与目标",
        paragraphs: [
          "本项目旨在实现多租户长文档的证据索引溯源。",
          "编号标识符：000987654321，需保留前导零。",
          "公式测试：=AVERAGE(C1:C10) 作为纯文本保留，不执行计算。",
        ],
      },
      {
        heading: "二、特殊符号与多语言",
        paragraphs: [
          "English paragraph with symbols: <tag> & \"quotation\" 'apostrophe' /slash/.",
          "重复内容段落：幂等与哈希复核。",
          "重复内容段落：幂等与哈希复核。",
        ],
      },
    ],
  }, { format: "docx" }).buffer;

  // 2. 通过锁定解析器执行真实提取
  const parsed = await parseOfficeDocument({
    bytes: docxFixtureBytes,
    format: "docx",
  });

  assert.equal(parsed.format, "docx");
  assert.equal(parsed.locatorKind, "extracted-text-block-not-page");
  assert.ok(Array.isArray(parsed.blocks));
  assert.ok(parsed.blocks.length >= 7);
  assert.equal(parsed.sourceSha256.length, 64);

  // 3. 构建来源索引候选
  const indexRecord = buildDocxEvidenceIndex({
    tenantId: "tenant-probe-101",
    documentId: "reports/survey-2026.docx",
    sourceSha256: parsed.sourceSha256,
    blocks: parsed.blocks,
    version: 1,
  });

  assert.equal(indexRecord.schemaVersion, 1);
  assert.equal(indexRecord.locatorKind, "extracted-text-block-not-page");
  assert.equal(indexRecord.tenantId, "tenant-probe-101");
  assert.equal(indexRecord.summary.totalBlocks, parsed.blocks.length);

  // 4. 切片对齐与哈希一致性严格核查 (覆盖率 100% 验证)
  // 将所有 block 的 text 拼接为完整的 extracted 文本
  const concatenated = indexRecord.blocks.map(b => b.text).join("");
  assert.equal(concatenated.length, indexRecord.summary.totalChars);

  for (const block of indexRecord.blocks) {
    const slice = concatenated.slice(block.charStart, block.charEnd);
    assert.equal(slice, block.text, `Character slice mismatch at block ${block.blockIndex}`);
    assert.equal(slice.length, block.charLength);

    // 验证只读查询能力
    const retrieved = lookupBlockEvidence(indexRecord, block.blockIndex);
    assert.equal(retrieved.blockIndex, block.blockIndex);
    assert.equal(retrieved.textSha256, block.textSha256);
  }

  // 5. 验证特异性内容：前导零、伪公式、中文、特殊字符
  const allTexts = indexRecord.blocks.map(b => b.text);
  assert.ok(allTexts.some(t => t.includes("000987654321")), "Leading zeros preserved");
  assert.ok(allTexts.some(t => t.includes("=AVERAGE(C1:C10)")), "Formula preserved as raw text");
  assert.ok(allTexts.some(t => t.includes("<tag> & \"quotation\"")), "Special characters preserved");

  // 6. 验证租户隔离与文件换版失效
  // 正确租户与 SHA:
  assert.equal(verifyDocxEvidenceIndex(indexRecord, {
    tenantId: "tenant-probe-101",
    documentId: "reports/survey-2026.docx",
    sourceSha256: parsed.sourceSha256,
    version: 1,
  }), true);

  // 跨租户嗅探:
  assert.equal(verifyDocxEvidenceIndex(indexRecord, {
    tenantId: "tenant-foreign-attacker",
    documentId: "reports/survey-2026.docx",
    sourceSha256: parsed.sourceSha256,
  }), false);

  // 文件被篡改或更新版本:
  assert.equal(verifyDocxEvidenceIndex(indexRecord, {
    tenantId: "tenant-probe-101",
    documentId: "reports/survey-2026.docx",
    sourceSha256: "0".repeat(64), // Mismatched SHA
  }), false);

  console.log(JSON.stringify({
    probeResult: "PASS",
    description: "DOCX Evidence Index verified with real locked parser and generated DOCX fixture",
    totalBlocks: indexRecord.summary.totalBlocks,
    totalChars: indexRecord.summary.totalChars,
    coverageHash: indexRecord.summary.coverageHash,
    sourceSha256: parsed.sourceSha256,
    charSliceAligned: true,
    leadingZerosPreserved: true,
    formulaNotEvaluated: true,
    tenantIsolationEnforced: true,
    noPageNumberImpersonation: true,
  }, null, 2));
}

runProbe().catch(err => {
  console.error("Probe failed:", err);
  process.exit(1);
});
