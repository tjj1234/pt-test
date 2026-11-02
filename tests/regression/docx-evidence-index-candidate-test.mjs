import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildDocxEvidenceIndex,
  verifyDocxEvidenceIndex,
  lookupBlockEvidence,
  MAX_BLOCKS_LIMIT,
  MAX_BLOCK_TEXT_BYTES,
  MAX_TOTAL_CHARS_LIMIT,
} = require("../../shell/attachments/docx-evidence-index-candidate.cjs");

const DUMMY_SHA = "a".repeat(64);

test("DOCX Evidence Index - Basic construction and immutability", () => {
  const blocks = [
    { index: 1, text: "段落一：北极星多租户文档。" },
    { index: 2, text: "Paragraph two: leading 000123 text test." },
    { index: 3, text: "" },
    { index: 4, text: "=SUM(A1:B2) is raw text, not formula." },
  ];

  const index = buildDocxEvidenceIndex({
    tenantId: "tenant-acme",
    documentId: "docs/specs.docx",
    sourceSha256: DUMMY_SHA,
    blocks,
    version: 2,
  });

  assert.equal(index.schemaVersion, 1);
  assert.equal(index.locatorKind, "extracted-text-block-not-page");
  assert.equal(index.tenantId, "tenant-acme");
  assert.equal(index.documentId, "docs/specs.docx");
  assert.equal(index.documentVersion, 2);
  assert.equal(index.sourceSha256, DUMMY_SHA);

  // Summary checks
  assert.equal(index.summary.totalBlocks, 4);
  assert.equal(index.summary.nonEmptyBlocks, 3);
  assert.ok(index.summary.totalChars > 0);
  assert.equal(typeof index.summary.coverageHash, "string");
  assert.equal(index.summary.coverageHash.length, 64);

  // Immutability checks
  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.summary));
  assert.ok(Object.isFrozen(index.blocks));
  assert.ok(Object.isFrozen(index.blocks[0]));
  assert.throws(() => { index.tenantId = "other"; });

  // Lookup checks
  const b1 = lookupBlockEvidence(index, 1);
  assert.equal(b1.blockIndex, 1);
  assert.equal(b1.text, "段落一：北极星多租户文档。");
  assert.equal(b1.charStart, 0);
  assert.equal(b1.charEnd, b1.charLength);

  const b2 = lookupBlockEvidence(index, 2);
  assert.equal(b2.charStart, b1.charEnd);

  // Out of range lookup
  assert.equal(lookupBlockEvidence(index, 0), null);
  assert.equal(lookupBlockEvidence(index, 5), null);
});

test("DOCX Evidence Index - Input validation and boundary enforcement", () => {
  const validBlocks = [{ index: 1, text: "valid" }];

  // Invalid tenantId
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "", documentId: "d", sourceSha256: DUMMY_SHA, blocks: validBlocks }), { code: "INDEX_TENANT_INVALID" });
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "tenant/slash", documentId: "d", sourceSha256: DUMMY_SHA, blocks: validBlocks }), { code: "INDEX_TENANT_INVALID" });

  // Invalid documentId
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "t", documentId: "", sourceSha256: DUMMY_SHA, blocks: validBlocks }), { code: "INDEX_DOCUMENT_ID_INVALID" });

  // Invalid version
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "t", documentId: "d", sourceSha256: DUMMY_SHA, blocks: validBlocks, version: 0 }), { code: "INDEX_VERSION_INVALID" });

  // Invalid SHA
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "t", documentId: "d", sourceSha256: "not-a-sha", blocks: validBlocks }), { code: "INDEX_SOURCE_SHA_INVALID" });

  // Blocks not array
  assert.throws(() => buildDocxEvidenceIndex({ tenantId: "t", documentId: "d", sourceSha256: DUMMY_SHA, blocks: null }), { code: "INDEX_BLOCKS_INVALID" });

  // Discontinuous sequence
  assert.throws(() => buildDocxEvidenceIndex({
    tenantId: "t",
    documentId: "d",
    sourceSha256: DUMMY_SHA,
    blocks: [{ index: 1, text: "a" }, { index: 3, text: "b" }],
  }), { code: "INDEX_SEQUENCE_DISCONTINUITY" });

  // Non-object block
  assert.throws(() => buildDocxEvidenceIndex({
    tenantId: "t",
    documentId: "d",
    sourceSha256: DUMMY_SHA,
    blocks: [null],
  }), { code: "INDEX_BLOCK_ENTRY_INVALID" });

  // Non-string block text
  assert.throws(() => buildDocxEvidenceIndex({
    tenantId: "t",
    documentId: "d",
    sourceSha256: DUMMY_SHA,
    blocks: [{ index: 1, text: 123 }],
  }), { code: "INDEX_BLOCK_TEXT_INVALID" });
});

test("DOCX Evidence Index - Capacity & DOS protections", () => {
  // Max blocks exceeded
  const tooManyBlocks = Array.from({ length: MAX_BLOCKS_LIMIT + 1 }, (_, i) => ({
    index: i + 1,
    text: "x",
  }));
  assert.throws(() => buildDocxEvidenceIndex({
    tenantId: "t",
    documentId: "d",
    sourceSha256: DUMMY_SHA,
    blocks: tooManyBlocks,
  }), { code: "INDEX_BLOCK_LIMIT_EXCEEDED" });

  // Single block text too large (>1MB)
  const hugeBlock = [{ index: 1, text: "a".repeat(MAX_BLOCK_TEXT_BYTES + 10) }];
  assert.throws(() => buildDocxEvidenceIndex({
    tenantId: "t",
    documentId: "d",
    sourceSha256: DUMMY_SHA,
    blocks: hugeBlock,
  }), { code: "INDEX_BLOCK_TEXT_TOO_LARGE" });
});

test("DOCX Evidence Index - Verification, tenant isolation and revocation on version change", () => {
  const index = buildDocxEvidenceIndex({
    tenantId: "tenant-1",
    documentId: "specs.docx",
    sourceSha256: DUMMY_SHA,
    blocks: [{ index: 1, text: "content v1" }],
    version: 1,
  });

  // 1. Matches exactly
  assert.equal(verifyDocxEvidenceIndex(index, {
    tenantId: "tenant-1",
    documentId: "specs.docx",
    sourceSha256: DUMMY_SHA,
    version: 1,
  }), true);

  // 2. Cross-tenant attempt fails
  assert.equal(verifyDocxEvidenceIndex(index, {
    tenantId: "tenant-2",
    documentId: "specs.docx",
    sourceSha256: DUMMY_SHA,
    version: 1,
  }), false);

  // 3. Different documentId fails
  assert.equal(verifyDocxEvidenceIndex(index, {
    tenantId: "tenant-1",
    documentId: "other.docx",
    sourceSha256: DUMMY_SHA,
    version: 1,
  }), false);

  // 4. File content modified (SHA mismatch) -> Index revoked/invalid
  assert.equal(verifyDocxEvidenceIndex(index, {
    tenantId: "tenant-1",
    documentId: "specs.docx",
    sourceSha256: "b".repeat(64),
    version: 1,
  }), false);

  // 5. Version bumped -> Index invalid
  assert.equal(verifyDocxEvidenceIndex(index, {
    tenantId: "tenant-1",
    documentId: "specs.docx",
    sourceSha256: DUMMY_SHA,
    version: 2,
  }), false);
});
