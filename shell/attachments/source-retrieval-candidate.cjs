'use strict';

/**
 * 跨资料检索与删除失效候选 (Source Retrieval Candidate)
 *
 * 核心架构原则：
 * 1. 纯函数设计：buildSourceIndex / querySourceIndex / invalidateSource。
 *    不持有凭据，不访问磁盘或网络，不自建文档解析器，只接收宿主已验证的文本块。
 * 2. 严格多租户隔离与所有权绑定：
 *    - 索引绑定 tenantId, documentId, sourceSha256, version, blocks 及其原始定位。
 *    - 校验 coverageHash（确定性内容覆盖指纹），防止自报篡改。
 * 3. 动态删除失效与版本检验 (Dynamic Invalidation & Freshness Guard)：
 *    - 查询必须携带可信当前源清单 (trustedSources) 与调用者 tenantId。
 *    - 跨租户、已删除、旧 SHA、旧版本的派生索引一律静默排除或拒绝，绝不返回过期/越权内容。
 * 4. 定位器保真度 (Locator Fidelity)：
 *    - DOCX: 强制标记 extracted-text-block-not-page，严禁冒充页码。
 *    - XLSX: 保留 sheet/sheetName/cell/formula 等结构化定位。
 *    - PPTX: 保留 slide/paragraph 等结构化定位。
 *    - 结果提供真实原文精确切片 (exact excerpt)，摘要不可替代原文引用。
 * 5. 安全防御与确定性中文匹配：
 *    - 拒绝用户正则（绝对不使用 new RegExp 动态编译用户输入，防范 ReDoS）。
 *    - 前置 Reject-before-Scan：拦截稀疏数组、超长文本、超大块数量。
 *    - 确定性中文/英文词法搜索与稳定排名，输出包含 coverage 与 truncated 声明。
 */

const { createHash } = require('node:crypto');
const {isDeepStrictEqual}=require('node:util');

// 资源上限常量 (DoS 防御与前置拦截)
const LIMITS = Object.freeze({
  MAX_DOCUMENTS: 64,
  MAX_BLOCKS_PER_DOC: 10000,
  MAX_BLOCK_TEXT_CHARS: 500000, // 500KB per block
  MAX_TOTAL_DOC_CHARS: 5 * 1024 * 1024, // 5MB total per doc
  MAX_QUERY_CHARS: 256,
  MAX_RESULTS_LIMIT: 50,
  DEFAULT_RESULTS: 10,
  EXCERPT_CONTEXT_CHARS: 100, // 命中前后摘录上下文长度
});

const REGEX = Object.freeze({
  TENANT_ID: /^[a-zA-Z0-9_-]{1,128}$/,
  DOCUMENT_ID: /^[a-zA-Z0-9_./-]{1,256}$/,
  SHA256_HEX: /^[0-9a-f]{64}$/i,
  SUPPORTED_FORMATS: /^(docx|xlsx|pptx|pdf|doc|xls|ppt|zip|csv|txt|markdown)$/,
});

function fail(code, message) {
  const err = new Error(message || 'Source retrieval operation failed');
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

function isDenseArray(arr) {
  if (!Array.isArray(arr)) return false;
  // 检查是否为稀疏数组 (sparse array)
  if (arr.length>LIMITS.MAX_BLOCKS_PER_DOC)return false;
  for(let i=0;i<arr.length;i++)if(!Object.hasOwn(arr,i))return false;
  return true;
}

/**
 * 计算索引的内容覆盖指纹 (Coverage Hash)
 * 注意：对各 block 的 text 实时重新计算 sha256(b.text)，确保内容一旦被篡改指纹必定不一致
 */
function computeCoverageHash({ tenantId, documentId, sourceSha256, version, format, blocks }) {
  const hasher = createHash('sha256');
  hasher.update(`HEADER:${tenantId}:${documentId}:${sourceSha256}:${version}:${format}\n`);
  let runningOffset = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const actualTextHash = sha256(typeof b.text === 'string' ? b.text : '');
    const charLen = typeof b.text === 'string' ? b.text.length : 0;
    const start = runningOffset;
    const end = start + charLen;
    runningOffset = end;
    const locStr = b.locator ? JSON.stringify(b.locator) : '';
    hasher.update(`B:${i + 1}:${actualTextHash}:${start}:${end}:${locStr}\n`);
  }
  return hasher.digest('hex');
}

/**
 * 校验块定位器并规范化
 */
function normalizeLocator(rawLocator, format, blockIndex) {
  if(format==='zip'){
    const x=rawLocator;
    if(!x||typeof x.member!=='string'||!x.member||x.member.length>512||/[\\\x00-\x1f\x7f]/.test(x.member)||x.member.startsWith('/')||x.member.split('/').some(p=>!p||p==='.'||p==='..')||!REGEX.SHA256_HEX.test(x.memberSha256||'')||!['txt','md','csv','docx','xlsx','pptx','pdf','doc','xls','ppt'].includes(x.memberFormat)||!Number.isSafeInteger(x.memberBlock)||x.memberBlock<1||x.memberBlock>10000)throw fail('LOCATOR_INVALID','ZIP requires member and content fingerprints');
    return {kind:'archive-member',member:x.member,memberSha256:x.memberSha256,memberFormat:x.memberFormat,memberBlock:x.memberBlock,inner:normalizeLocator(x.inner,x.memberFormat==='md'?'markdown':x.memberFormat,x.memberBlock)};
  }
  if(format==='xls'){
    const x=rawLocator;if(!x||!Number.isSafeInteger(x.sheet)||x.sheet<1||x.sheet>1024||!Number.isSafeInteger(x.row)||x.row<1||!Number.isSafeInteger(x.column)||x.column<1)throw fail('LOCATOR_INVALID','Legacy XLS requires exported cell coordinates');
    return {kind:'legacy-sheet-export-cell',sheet:x.sheet,row:x.row,column:x.column};
  }
  if(format==='doc'||format==='ppt'){
    if(!rawLocator||!Number.isSafeInteger(rawLocator.segment)||rawLocator.segment<1||rawLocator.segment>10000)throw fail('LOCATOR_INVALID','Legacy text requires an extracted segment');
    return {kind:'legacy-extracted-segment-not-page',segment:rawLocator.segment};
  }
  if(format==='pdf'){
    if(!rawLocator||!Number.isSafeInteger(rawLocator.page)||rawLocator.page<1||rawLocator.page>200)throw fail('LOCATOR_INVALID','PDF requires a real page locator');
    return {kind:'pdf-page',page:rawLocator.page};
  }
  if (format === 'docx') {
    // DOCX 必须明确声明不是页码
    return {
      kind: 'extracted-text-block-not-page',
      blockIndex,
    };
  }

  if (format === 'xlsx') {
    if(!rawLocator||!Number.isSafeInteger(rawLocator.sheet)||rawLocator.sheet<1||typeof rawLocator.cell!=='string'||!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(rawLocator.cell))throw fail('LOCATOR_INVALID','XLSX requires a real sheet/cell locator');
    if (!rawLocator || typeof rawLocator !== 'object') {
      return { kind: 'sheet-cell-raw-value', sheet: 1, cell: `R${blockIndex}C1` };
    }
    return {
      kind: 'sheet-cell',
      sheet: Number.isSafeInteger(rawLocator.sheet) ? rawLocator.sheet : 1,
      sheetName: typeof rawLocator.sheetName === 'string' ? rawLocator.sheetName.slice(0, 128) : null,
      cell: typeof rawLocator.cell === 'string' ? rawLocator.cell : `R${blockIndex}C1`,
      valueType: typeof rawLocator.valueType === 'string' ? rawLocator.valueType : 'n',
      formula: Boolean(rawLocator.formula),
    };
  }

  if (format === 'pptx') {
    if(!rawLocator||!Number.isSafeInteger(rawLocator.slide)||rawLocator.slide<1||!Number.isSafeInteger(rawLocator.paragraph)||rawLocator.paragraph<1)throw fail('LOCATOR_INVALID','PPTX requires a real slide/paragraph locator');
    if (!rawLocator || typeof rawLocator !== 'object') {
      return { kind: 'slide-paragraph-text-only', slide: 1, paragraph: blockIndex };
    }
    return {
      kind: 'slide-paragraph',
      slide: Number.isSafeInteger(rawLocator.slide) ? rawLocator.slide : 1,
      paragraph: Number.isSafeInteger(rawLocator.paragraph) ? rawLocator.paragraph : blockIndex,
    };
  }

  if (format === 'csv') {
    if(!rawLocator||!Number.isSafeInteger(rawLocator.row)||rawLocator.row<1||!Number.isSafeInteger(rawLocator.column)||rawLocator.column<1)throw fail('LOCATOR_INVALID','CSV requires a real row/column locator');
    if (!rawLocator || typeof rawLocator !== 'object') {
      return { kind: 'csv-cell', row: blockIndex, column: 1 };
    }
    return {
      kind: 'csv-cell',
      row: Number.isSafeInteger(rawLocator.row) ? rawLocator.row : blockIndex,
      column: Number.isSafeInteger(rawLocator.column) ? rawLocator.column : 1,
      sourceLine: Number.isSafeInteger(rawLocator.sourceLine) ? rawLocator.sourceLine : null,
      sourceColumn: Number.isSafeInteger(rawLocator.sourceColumn) ? rawLocator.sourceColumn : null,
    };
  }

  // 通用文本
  return {
    kind: 'text-block',
    blockIndex,
  };
}

/**
 * 构建规范化的单文档来源索引 (buildSourceIndex)
 *
 * @param {object} params
 * @param {string} params.tenantId - 租户标识
 * @param {string} params.documentId - 文档标识
 * @param {string} params.sourceSha256 - 宿主已验证的原始源文件 SHA-256
 * @param {number} [params.version=1] - 文档版本
 * @param {string} [params.format='docx'] - 文档格式 ('docx'|'xlsx'|'pptx'|'csv'|'txt'|'markdown')
 * @param {Array<{ index?: number, text: string, locator?: object }>} params.blocks - 提取块
 * @returns {Readonly<object>} 不可变来源索引
 */
function buildSourceIndex({
  tenantId,
  documentId,
  sourceSha256,
  version = 1,
  format = 'docx',
  blocks,
} = {}) {
  // 1. 前置参数基础校验
  if (typeof tenantId !== 'string' || !REGEX.TENANT_ID.test(tenantId.trim())) {
    throw fail('INDEX_TENANT_INVALID', 'Invalid or missing tenantId');
  }
  if (typeof documentId !== 'string' || !REGEX.DOCUMENT_ID.test(documentId.trim())) {
    throw fail('INDEX_DOCUMENT_ID_INVALID', 'Invalid or missing documentId');
  }
  if (typeof sourceSha256 !== 'string' || !REGEX.SHA256_HEX.test(sourceSha256)) {
    throw fail('INDEX_SOURCE_SHA_INVALID', 'Invalid sourceSha256 digest');
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw fail('INDEX_VERSION_INVALID', 'Document version must be a positive integer');
  }
  const normFormat = typeof format === 'string' ? format.trim().toLowerCase() : '';
  if (!REGEX.SUPPORTED_FORMATS.test(normFormat)) {
    throw fail('INDEX_FORMAT_UNSUPPORTED', `Unsupported format: ${format}`);
  }

  // 2. 块数组密集与上限校验 (Reject-before-Scan)
  if(Array.isArray(blocks)&&blocks.length>LIMITS.MAX_BLOCKS_PER_DOC)throw fail('INDEX_BLOCK_LIMIT_EXCEEDED','Too many blocks');
  if (!isDenseArray(blocks)) {
    throw fail('INDEX_BLOCKS_INVALID', 'Blocks must be a dense array');
  }
  if (blocks.length > LIMITS.MAX_BLOCKS_PER_DOC) {
    throw fail(
      'INDEX_BLOCK_LIMIT_EXCEEDED',
      `Block count (${blocks.length}) exceeds maximum limit (${LIMITS.MAX_BLOCKS_PER_DOC})`
    );
  }

  const normTenantId = tenantId.trim();
  const normDocId = documentId.trim();
  const normSha256 = sourceSha256.toLowerCase();

  const indexedBlocks = [];
  let currentOffset = 0;
  let nonEmptyCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const rawBlock = blocks[i];
    if (!rawBlock || typeof rawBlock !== 'object') {
      throw fail('INDEX_BLOCK_ENTRY_INVALID', `Block at index ${i} is not a valid object`);
    }

    const blockIndex = i + 1;
    // 若原块传入了 index，必须严格匹配连续正整数
    if (rawBlock.index !== undefined && rawBlock.index !== blockIndex) {
      throw fail(
        'INDEX_SEQUENCE_DISCONTINUITY',
        `Discontinuous block index: expected ${blockIndex}, got ${rawBlock.index}`
      );
    }

    if (typeof rawBlock.text !== 'string') {
      throw fail('INDEX_BLOCK_TEXT_INVALID', `Block text at index ${blockIndex} must be a string`);
    }

    const text = rawBlock.text;
    const charLen = text.length;
    if (charLen > LIMITS.MAX_BLOCK_TEXT_CHARS) {
      throw fail(
        'INDEX_BLOCK_TEXT_TOO_LARGE',
        `Block at index ${blockIndex} exceeds character limit (${LIMITS.MAX_BLOCK_TEXT_CHARS})`
      );
    }

    const charStart = currentOffset;
    const charEnd = currentOffset + charLen;
    currentOffset = charEnd;

    if (currentOffset > LIMITS.MAX_TOTAL_DOC_CHARS) {
      throw fail(
        'INDEX_TOTAL_TEXT_TOO_LARGE',
        `Total document text exceeds limit (${LIMITS.MAX_TOTAL_DOC_CHARS})`
      );
    }

    const isNonEmpty = text.trim().length > 0;
    if (isNonEmpty) nonEmptyCount++;

    const textHash = sha256(text);
    const locator = normalizeLocator(rawBlock.locator, normFormat, blockIndex);

    indexedBlocks.push({
      blockIndex,
      textSha256: textHash,
      charStart,
      charEnd,
      charLength: charLen,
      text,
      isEmpty: !isNonEmpty,
      locator,
    });
  }

  const coverageHash = computeCoverageHash({
    tenantId: normTenantId,
    documentId: normDocId,
    sourceSha256: normSha256,
    version,
    format: normFormat,
    blocks: indexedBlocks,
  });

  const indexRecord = {
    schemaVersion: 1,
    tenantId: normTenantId,
    documentId: normDocId,
    documentVersion: version,
    sourceSha256: normSha256,
    format: normFormat,
    locatorKind:
      normFormat === 'pdf' ? 'pdf-page' : normFormat === 'docx'
        ? 'extracted-text-block-not-page'
        : normFormat === 'xlsx'
        ? 'sheet-cell-raw-value'
        : normFormat === 'pptx'
        ? 'slide-paragraph-text-only'
        : `${normFormat}-source-block`,
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
 * 校验来源索引的完整性与自洽性 (recompute verification)
 */
function verifyIndexIntegrity(indexRecord) {
  try {
    if(!indexRecord||indexRecord.schemaVersion!==1||!Array.isArray(indexRecord.blocks)||indexRecord.blocks.length>LIMITS.MAX_BLOCKS_PER_DOC)return false;
    const rebuilt=buildSourceIndex({tenantId:indexRecord.tenantId,documentId:indexRecord.documentId,sourceSha256:indexRecord.sourceSha256,version:indexRecord.documentVersion,format:indexRecord.format,
      blocks:indexRecord.blocks.map(block=>({index:block.blockIndex,text:block.text,locator:block.locator}))});
    return isDeepStrictEqual(indexRecord,rebuilt);
  }catch{return false;}

}

/**
 * 显式校验或使索引失效 (invalidateSource)
 *
 * @param {object} params
 * @param {object} params.index - 来源索引对象
 * @param {string} [params.reason] - 失效原因说明
 * @param {object} [params.target] - 目标源真实状态 { tenantId, documentId, sourceSha256, version, isDeleted }
 * @returns {{ valid: boolean, reason?: string }}
 */
function invalidateSource({ index, reason, target } = {}) {
  if (!index || typeof index !== 'object') {
    return { valid: false, reason: 'INDEX_INVALID' };
  }

  // 1. 验证索引自身哈希自洽性（防内部篡改）
  if (!verifyIndexIntegrity(index)) {
    return { valid: false, reason: 'INDEX_COVERAGE_HASH_TAMPERED' };
  }

  // 2. 若提供了显式失效原因
  if (reason) {
    return { valid: false, reason };
  }

  // 3. 若提供了宿主当前目标状态对比
  if (target) {
    if(typeof target.tenantId!=='string'||typeof target.documentId!=='string'||typeof target.sourceSha256!=='string'||!REGEX.SHA256_HEX.test(target.sourceSha256)||!Number.isSafeInteger(target.version)||target.version<1)return {valid:false,reason:'TARGET_SPEC_INVALID'};
    if(target.coverageHash!==undefined&&target.coverageHash!==index.summary.coverageHash)return {valid:false,reason:'EXTRACTION_CHANGED'};
    if (typeof target !== 'object') {
      return { valid: false, reason: 'TARGET_SPEC_INVALID' };
    }
    if (target.tenantId && target.tenantId !== index.tenantId) {
      return { valid: false, reason: 'CROSS_TENANT_VIOLATION' };
    }
    if (target.documentId && target.documentId !== index.documentId) {
      return { valid: false, reason: 'DOCUMENT_MISMATCH' };
    }
    if (target.isDeleted === true) {
      return { valid: false, reason: 'SOURCE_DELETED' };
    }
    if (target.sourceSha256 && target.sourceSha256.toLowerCase() !== index.sourceSha256.toLowerCase()) {
      return { valid: false, reason: 'SOURCE_SHA_OUTDATED' };
    }
    if (target.version !== undefined && target.version !== index.documentVersion) {
      return { valid: false, reason: 'VERSION_MISMATCH' };
    }
  }

  return { valid: true };
}

/**
 * 确定性词法分词与子串解析 (无正则编译，安全防范 ReDoS)
 */
function tokenizeQuery(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  const tokens = [];

  // 英文按空白与标点切分
  const words = q.split(/[\s,.;:!?_(){}\[\]"']+/).filter(Boolean);
  for (const w of words) {
    if (w.length > 0) tokens.push(w);
  }

  // 中文分词策略：收集所有连续的中文字符串，并生成双字 ngram
  const cjkMatches = q.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const segment of cjkMatches) {
    if (segment.length <= 2) {
      if (!tokens.includes(segment)) tokens.push(segment);
    } else {
      // 包含完整中文段
      if (!tokens.includes(segment)) tokens.push(segment);
      // 提取双字 ngram 保证部分匹配能力
      for (let i = 0; i < segment.length - 1; i++) {
        const bi = segment.slice(i, i + 2);
        if (!tokens.includes(bi)) tokens.push(bi);
      }
    }
  }

  return tokens.slice(0, 16); // 限制最大 token 数量
}

/**
 * 提取命中上下文切片 (Exact Excerpt)
 */
function createExcerpt(text, matchIndex, matchLength, contextChars = LIMITS.EXCERPT_CONTEXT_CHARS) {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLength + contextChars);

  let prefix = start > 0 ? '...' : '';
  let suffix = end < text.length ? '...' : '';

  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * 跨资料检索查询纯函数 (querySourceIndex)
 *
 * @param {object} params
 * @param {string} params.tenantId - 调用方经认证的租户标识
 * @param {string} params.query - 检索文本（字面量匹配，绝不编译正则）
 * @param {Map<string, object>|Array<object>} params.trustedSources - 宿主提供的当前有效且存活的源清单
 * @param {Array<object>} params.indexes - 预建的来源索引集合
 * @param {object} [params.options] - 选项 { maxResults, formatFilter }
 * @returns {object} { query, tenantId, totalMatches, returnedResults, truncated, coverage, results }
 */
function querySourceIndex({
  tenantId,
  query,
  trustedSources,
  indexes,
  options = {},
} = {}) {
  // 1. 前置安全门禁
  if (typeof tenantId !== 'string' || !REGEX.TENANT_ID.test(tenantId.trim())) {
    throw fail('QUERY_TENANT_INVALID', 'Invalid or missing query tenantId');
  }
  if (typeof query !== 'string') {
    throw fail('QUERY_TEXT_INVALID', 'Query must be a string');
  }
  if(query.length>LIMITS.MAX_QUERY_CHARS)throw fail('QUERY_TOO_LONG','Query exceeds character limit');
  const cleanQuery = query.trim();
  if (cleanQuery.length === 0) {
    throw fail('QUERY_EMPTY', 'Query text cannot be empty');
  }
  if (cleanQuery.length > LIMITS.MAX_QUERY_CHARS) {
    throw fail('QUERY_TOO_LONG', `Query exceeds maximum character limit (${LIMITS.MAX_QUERY_CHARS})`);
  }

  if (!isDenseArray(indexes)) {
    throw fail('QUERY_INDEXES_INVALID', 'Indexes must be a dense array');
  }
  if (indexes.length > LIMITS.MAX_DOCUMENTS) {
    throw fail('QUERY_DOCUMENT_LIMIT_EXCEEDED', `Indexes count exceeds limit (${LIMITS.MAX_DOCUMENTS})`);
  }

  const normTenantId = tenantId.trim();

  // 2. 规范化可信源清单 (trustedSources)
  // 支持按 tenantId + documentId 多租户联合索引及纯 documentId 检索
  if((trustedSources instanceof Map?trustedSources.size:Array.isArray(trustedSources)?trustedSources.length:0)>LIMITS.MAX_DOCUMENTS)throw fail('QUERY_TRUSTED_SOURCES_INVALID','Too many trusted sources');
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['maxResults','formatFilter'].includes(key))||(options.maxResults!==undefined&&(!Number.isSafeInteger(options.maxResults)||options.maxResults<1||options.maxResults>LIMITS.MAX_RESULTS_LIMIT)))throw fail('QUERY_OPTIONS_INVALID','Invalid search limits');
  const trustedMap = new Map();
  if (trustedSources instanceof Map) {
    for (const [k, v] of trustedSources.entries()) trustedMap.set(k, v);
  } else if (Array.isArray(trustedSources)) {
    for (const item of trustedSources) {
      if (item && item.documentId) {
        if (item.tenantId) {
          trustedMap.set(`${item.tenantId}:${item.documentId}`, item);
        }
        // 若当前未被同名不同租户占用，或自身就是该租户，保留单 documentId 索引
        if (!trustedMap.has(item.documentId) || item.tenantId === normTenantId) {
          trustedMap.set(item.documentId, item);
        }
      }
    }
  } else {
    throw fail('QUERY_TRUSTED_SOURCES_INVALID', 'trustedSources must be a Map or Array');
  }

  const maxResults = Math.min(
    Math.max(1, Number.isSafeInteger(options.maxResults) ? options.maxResults : LIMITS.DEFAULT_RESULTS),
    LIMITS.MAX_RESULTS_LIMIT
  );
  const formatFilter = options.formatFilter ? String(options.formatFilter).toLowerCase() : null;

  const queryTokens = tokenizeQuery(cleanQuery);
  const lowerQuery = cleanQuery.toLowerCase();

  const candidates = [];
  let totalMatches = 0;
  let evaluatedDocsCount = 0;
  let admittedDocsCount = 0;
  let rejectedDocsCount = 0;
  const coverageAudit = [];

  // 3. 遍历各索引并严格执行失效与跨租户门禁
  for (const idx of indexes) {
    evaluatedDocsCount++;

    // 门禁 A: 租户强隔离
    if (!idx || idx.tenantId !== normTenantId) {
      rejectedDocsCount++;
      coverageAudit.push({ status: 'REJECTED_CROSS_TENANT' });
      continue;
    }

    // 门禁 B: 索引哈希自洽性校验（防御外部传入伪造篡改的索引）
    if (!verifyIndexIntegrity(idx)) {
      rejectedDocsCount++;
      coverageAudit.push({ documentId: idx.documentId, status: 'REJECTED_CORRUPTED_INDEX' });
      continue;
    }

    // 门禁 C: 格式过滤器
    if (formatFilter && idx.format !== formatFilter) {
      continue;
    }

    // 门禁 D: 可信存活源清单校验 (Freshness & Non-Deleted Check)
    const trustedTarget = trustedMap.get(`${normTenantId}:${idx.documentId}`) || trustedMap.get(idx.documentId);
    if (!trustedTarget) {
      // 在当前清单中不存在（已被删除或未被许可）
      rejectedDocsCount++;
      coverageAudit.push({ documentId: idx.documentId, status: 'REJECTED_DELETED_OR_UNKNOWN' });
      continue;
    }

    const check = invalidateSource({ index: idx, target: trustedTarget });
    if (!check.valid) {
      // 旧 SHA、旧版本、或被显式标记已删除
      rejectedDocsCount++;
      coverageAudit.push({ documentId: idx.documentId, status: `REJECTED_${check.reason}` });
      continue;
    }

    admittedDocsCount++;
    coverageAudit.push({ documentId: idx.documentId, status: 'ADMITTED' });

    // 4. 在有效文档的 blocks 中执行确定性字面量与分词检索
    for (let bi = 0; bi < idx.blocks.length; bi++) {
      const block = idx.blocks[bi];
      if (block.isEmpty) continue;

      const lowerText = block.text.toLowerCase();
      let matchScore = 0;
      let primaryMatchIndex = -1;
      let primaryMatchLen = 0;

      // 策略 1: 完整 query 精确包含（最高权重）
      const fullIdx = lowerText.indexOf(lowerQuery);
      if (fullIdx !== -1) {
        matchScore += 100;
        primaryMatchIndex = fullIdx;
        primaryMatchLen = cleanQuery.length;
      }

      // 策略 2: 分词匹配计分
      let tokenHitCount = 0;
      for (const t of queryTokens) {
        const tIdx = lowerText.indexOf(t);
        if (tIdx !== -1) {
          tokenHitCount++;
          matchScore += 10;
          if (primaryMatchIndex === -1) {
            primaryMatchIndex = tIdx;
            primaryMatchLen = t.length;
          }
        }
      }

      // 若未命中任何分词或子串，跳过
      if (matchScore === 0) continue;

      // 奖励：完整命中覆盖率
      if (queryTokens.length > 0 && tokenHitCount === queryTokens.length) {
        matchScore += 25;
      }

      const excerpt = createExcerpt(block.text, primaryMatchIndex, primaryMatchLen);

      totalMatches++;
      candidates.push({
        documentId: idx.documentId,
        documentVersion: idx.documentVersion,
        sourceSha256: idx.sourceSha256,
        format: idx.format,
        blockIndex: block.blockIndex,
        locatorKind: block.locator.kind,
        locator: block.locator,
        textSha256: block.textSha256,
        score: matchScore,
        exactMatch: fullIdx !== -1,
        tokenCoverage: queryTokens.length > 0 ? tokenHitCount / queryTokens.length : 0,
        charStart: block.charStart,
        charEnd: block.charEnd,
        excerpt,
        rawText: block.text,
      });

      candidates.sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.blockIndex-b.blockIndex);
      if(candidates.length>maxResults)candidates.pop();
    }
  }

  // 5. 稳定排名计算：按得分降序；得分相同时按 (documentId 字典序, blockIndex 升序) 确定性排列
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const docCmp = a.documentId.localeCompare(b.documentId);
    if (docCmp !== 0) return docCmp;
    return a.blockIndex - b.blockIndex;
  });

  const returnedResults = candidates.slice(0, maxResults);
  const truncated = totalMatches > maxResults;

  return {
    schemaVersion: 1,
    query: cleanQuery,
    tenantId: normTenantId,
    totalMatches,
    returnedCount: returnedResults.length,
    truncated,
    coverage: {
      evaluatedDocuments: evaluatedDocsCount,
      admittedDocuments: admittedDocsCount,
      rejectedDocuments: rejectedDocsCount,
      audit: coverageAudit,
    },
    results: returnedResults,
  };
}

module.exports = {
  buildSourceIndex,
  querySourceIndex,
  invalidateSource,
  verifyIndexIntegrity,
  LIMITS,
};
