'use strict';

/**
 * DOCX 提取来源索引候选 (DOCX Evidence Index Candidate)
 *
 * 核心职责：
 * 1. 接受受限 DOCX 解析器 (office-document-parser.cjs) 产出的原始 blocks、
 *    原始文件 SHA-256 (sourceSha256) 以及租户/文档所有权元数据 (tenantId, documentId)。
 * 2. 建立不可变（deepFreeze）的段落来源索引，计算：
 *    - blockIndex (从 1 起始的连续块序号)
 *    - textSha256 (提取文本规范化哈希，便于排重与逆向校验)
 *    - charStart / charEnd / charLength (基于合并文本的绝对可见字符范围切片)
 *    - 总体覆盖统计 (totalBlocks, totalChars, nonEmptyBlocks, coverageHash)
 * 3. 严格安全约束：
 *    - 明确标记 locatorKind 为 'extracted-text-block-not-page'，绝不冒充真实 DOCX 页码或字节偏移；
 *    - 严格校验 tenantId 与 documentId 所有权，防范跨租户越权关联；
 *    - 校验 SHA-256 格式与完整性，任何内容被修改或换版时索引立即失效；
 *    - 防范超限 DOS：单文档块数上限 10,000，单块文本长度上限 1MB，总字符数上限 5MB；
 *    - 防范序号断裂、前导零错乱、重复序号或缺失索引；
 *    - 纯函数设计，不持有凭据，不访问外网，不执行宏或公式。
 */

const { createHash } = require('node:crypto');

const MAX_BLOCKS_LIMIT = 10000;
const MAX_BLOCK_TEXT_BYTES = 1024 * 1024; // 1MB
const MAX_TOTAL_CHARS_LIMIT = 5 * 1024 * 1024; // 5MB
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const DOCUMENT_ID_REGEX = /^[a-zA-Z0-9_./-]{1,256}$/;

function fail(code, message) {
  const err = new Error(message || 'DOCX evidence index operation failed');
  err.code = code;
  return err;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

/**
 * 校验并构造不可变的 DOCX 提取来源索引
 *
 * @param {object} params
 * @param {string} params.tenantId - 租户标识
 * @param {string} params.documentId - 文档标识（如文件名、路径或存储键）
 * @param {string} params.sourceSha256 - 原始 DOCX 文件的 SHA-256
 * @param {Array<{ index: number, text: string }>} params.blocks - 解析器提取的 blocks
 * @param {number} [params.version] - 可选的文档版本号，默认 1
 * @returns {Readonly<object>}
 */
function buildDocxEvidenceIndex({
  tenantId,
  documentId,
  sourceSha256,
  blocks,
  version = 1,
} = {}) {
  // 1. 租户与文档所有权校验
  if (typeof tenantId !== 'string' || !TENANT_ID_REGEX.test(tenantId.trim())) {
    throw fail('INDEX_TENANT_INVALID', 'Invalid or missing tenantId');
  }
  if (typeof documentId !== 'string' || !DOCUMENT_ID_REGEX.test(documentId.trim())) {
    throw fail('INDEX_DOCUMENT_ID_INVALID', 'Invalid or missing documentId');
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw fail('INDEX_VERSION_INVALID', 'Document version must be a positive integer');
  }

  // 2. 原始源文件 SHA-256 校验
  if (typeof sourceSha256 !== 'string' || !SHA256_HEX_REGEX.test(sourceSha256)) {
    throw fail('INDEX_SOURCE_SHA_INVALID', 'Invalid source SHA-256 digest');
  }

  // 3. 块数组合法性与数量上限
  if (!Array.isArray(blocks)) {
    throw fail('INDEX_BLOCKS_INVALID', 'Blocks must be an array');
  }
  if (blocks.length > MAX_BLOCKS_LIMIT) {
    throw fail('INDEX_BLOCK_LIMIT_EXCEEDED', `Blocks count exceeds maximum limit (${MAX_BLOCKS_LIMIT})`);
  }

  const normalizedTenantId = tenantId.trim();
  const normalizedDocId = documentId.trim();
  const normalizedSourceSha = sourceSha256.toLowerCase();

  const indexedBlocks = [];
  let currentOffset = 0;
  let nonEmptyCount = 0;
  const coverageHasher = createHash('sha256');

  for (let i = 0; i < blocks.length; i++) {
    const rawBlock = blocks[i];
    if (!rawBlock || typeof rawBlock !== 'object') {
      throw fail('INDEX_BLOCK_ENTRY_INVALID', `Block at index ${i} is not an object`);
    }

    const expectedIndex = i + 1;
    // 块序号必须严格匹配 1, 2, 3 ...
    if (rawBlock.index !== expectedIndex) {
      throw fail(
        'INDEX_SEQUENCE_DISCONTINUITY',
        `Discontinuous block index: expected ${expectedIndex}, got ${rawBlock.index}`
      );
    }

    if (typeof rawBlock.text !== 'string') {
      throw fail('INDEX_BLOCK_TEXT_INVALID', `Block text at index ${expectedIndex} must be a string`);
    }

    const text = rawBlock.text;
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > MAX_BLOCK_TEXT_BYTES) {
      throw fail(
        'INDEX_BLOCK_TEXT_TOO_LARGE',
        `Block at index ${expectedIndex} exceeds maximum text size (${MAX_BLOCK_TEXT_BYTES} bytes)`
      );
    }

    const charLength = text.length;
    const charStart = currentOffset;
    const charEnd = currentOffset + charLength;
    currentOffset = charEnd;

    if (currentOffset > MAX_TOTAL_CHARS_LIMIT) {
      throw fail(
        'INDEX_TOTAL_TEXT_TOO_LARGE',
        `Total document text exceeds maximum allowed character limit (${MAX_TOTAL_CHARS_LIMIT})`
      );
    }

    const isNonEmpty = text.trim().length > 0;
    if (isNonEmpty) nonEmptyCount++;

    const textHash = sha256(text);
    coverageHasher.update(`${expectedIndex}:${textHash}\n`);

    indexedBlocks.push({
      blockIndex: expectedIndex,
      textSha256: textHash,
      charStart,
      charEnd,
      charLength,
      text,
      isEmpty: !isNonEmpty,
    });
  }

  const coverageHash = coverageHasher.digest('hex');

  const indexRecord = {
    schemaVersion: 1,
    locatorKind: 'extracted-text-block-not-page', // 显式标识非页码
    tenantId: normalizedTenantId,
    documentId: normalizedDocId,
    documentVersion: version,
    sourceSha256: normalizedSourceSha,
    summary: {
      totalBlocks: indexedBlocks.length,
      nonEmptyBlocks: nonEmptyCount,
      totalChars: currentOffset,
      coverageHash,
    },
    blocks: indexedBlocks,
  };

  return deepFreeze(indexRecord);
}

/**
 * 验证某个来源索引是否依然与当前待比对的所有权、源文件 SHA 或版本相匹配
 * 支持换版或删除失效检测
 *
 * @param {object} indexRecord - 索引记录
 * @param {object} target - { tenantId, documentId, sourceSha256, version }
 * @returns {boolean}
 */
function verifyDocxEvidenceIndex(indexRecord, target) {
  if (!indexRecord || typeof indexRecord !== 'object' || !target || typeof target !== 'object') {
    return false;
  }
  if (indexRecord.schemaVersion !== 1 || indexRecord.locatorKind !== 'extracted-text-block-not-page') {
    return false;
  }
  if (indexRecord.tenantId !== target.tenantId) {
    return false; // 严防跨租户
  }
  if (indexRecord.documentId !== target.documentId) {
    return false;
  }
  if (typeof target.sourceSha256 === 'string' &&
      indexRecord.sourceSha256 !== target.sourceSha256.toLowerCase()) {
    return false; // 文件已换版或内容被修改
  }
  if (target.version !== undefined && indexRecord.documentVersion !== target.version) {
    return false;
  }
  return true;
}

/**
 * 根据块序号在索引中检索具体段落信息（只读）
 *
 * @param {object} indexRecord
 * @param {number} blockIndex (从 1 起始)
 * @returns {object|null}
 */
function lookupBlockEvidence(indexRecord, blockIndex) {
  if (!indexRecord || !Array.isArray(indexRecord.blocks)) return null;
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 1 || blockIndex > indexRecord.blocks.length) {
    return null;
  }
  const block = indexRecord.blocks[blockIndex - 1];
  if (block.blockIndex !== blockIndex) return null;
  return block;
}

module.exports = {
  buildDocxEvidenceIndex,
  verifyDocxEvidenceIndex,
  lookupBlockEvidence,
  MAX_BLOCKS_LIMIT,
  MAX_BLOCK_TEXT_BYTES,
  MAX_TOTAL_CHARS_LIMIT,
};
