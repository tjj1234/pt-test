'use strict';
/**
 * shell/exports/document-export-candidate.cjs
 * ============================================================================
 * F2 文档导出候选模块（Word / PDF / Excel）
 * 契约规范：docs/refactor/GEMINI-DOCEXPORT-CANDIDATE-PACKAGE-20261026.md
 *
 * 职责：
 *   接收结构化数据（title, author, date, sections [heading, paragraphs, table]），
 *   生成 Word (.docx)、PDF (.pdf)、Excel (.xlsx) 三种格式的合法文件。
 *   纯生成能力，不接入对话流程，不访问数据库，不发起网络请求。
 *
 * 核心安全与工程约束：
 *   1. 宽松许可证纯 JS 依赖（xlsx: Apache-2.0, fflate: MIT，零系统级编译依赖）。
 *   2. 严格 Fail-Closed：数据缺失、字段类型异常、表格行列不一致时拒绝生成并返回明确错误。
 *   3. 资源上限保护：可配置且设硬上限（maxRows, maxCells, maxBytes, timeoutMs），超限立即拒绝。
 *   4. Excel 公式注入防御：针对以 `=+\-@\t\r` 开头的字符串自动转义单引号，记录于 degradations。
 *   5. 零可执行内容：绝无 VBA/宏、无 PDF JavaScript/Launch 动作、无外部自动加载链接。
 *   6. 真实有效性：生成标准 OOXML 与 ISO 32000-1 PDF 格式，支持双向解析校验。
 * ============================================================================
 */

const { createHash } = require('node:crypto');
const path = require('node:path');
const { guardStructuredDocumentInput } = require('./document-input-guard-candidate.cjs');

// 1. 尝试安全解析 fflate（用于 docx/xlsx OPC 压缩，MIT 协议）
let _fflate = null;
function getFflate() {
  if (_fflate) return _fflate;
  try { _fflate = require('fflate'); return _fflate; } catch {}
  try {
    const p = require.resolve('fflate', { paths: [path.resolve(__dirname, '..'), path.resolve(__dirname, '../..')] });
    _fflate = require(p);
    return _fflate;
  } catch {}
  throw new Error('fflate library is required for packaging document files');
}

// 2. 尝试安全解析 xlsx（SheetJS，Apache-2.0 协议）
let _xlsx = null;
function getXlsx() {
  if (_xlsx) return _xlsx;
  try { _xlsx = require('xlsx'); return _xlsx; } catch {}
  try {
    const p = require.resolve('xlsx', {
      paths: [
        __dirname,
        path.resolve(__dirname, '../../analytics'),
        path.resolve(__dirname, '../../business/attribution'),
      ],
    });
    _xlsx = require(p);
    return _xlsx;
  } catch {}
  return null;
}

// 默认与硬上限资源边界
const DEFAULT_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxCells: 100_000,
  maxBytes: 20 * 1024 * 1024, // 20 MB
  timeoutMs: 30_000,          // 30 s
});

const HARD_CEILINGS = Object.freeze({
  maxRows: 50_000,
  maxCells: 500_000,
  maxBytes: 50 * 1024 * 1024, // 50 MB
  timeoutMs: 300_000,         // 5 min
});

const SUPPORTED_FORMATS = new Set(['docx', 'pdf', 'xlsx']);

// 公式注入匹配正则（开头的 =、+、-、@、制表符、回车，含 BOM 及前导空白）
const FORMULA_INJECTION_REGEX = /^[\s\uFEFF]*[=+\-@\t\r]/;

function docError(message, code = 'DOC_EXPORT_INVALID') {
  return Object.assign(new TypeError(`[DOC_EXPORT] ${code}: ${message}`), { code });
}

function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 校验并提取生效的资源限制配置
 */
function resolveLimits(options = {}) {
  const result = {};
  for (const [key, defaultVal] of Object.entries(DEFAULT_LIMITS)) {
    const userVal = options[key];
    if (userVal === undefined) {
      result[key] = defaultVal;
      continue;
    }
    if (typeof userVal !== 'number' || !Number.isFinite(userVal) || !Number.isSafeInteger(userVal) || userVal <= 0) {
      throw docError(`Invalid option ${key}: must be a positive safe integer`, 'DOC_OPTION_INVALID');
    }
    const ceiling = HARD_CEILINGS[key];
    if (userVal > ceiling) {
      throw docError(`Option ${key} (${userVal}) exceeds hard ceiling (${ceiling})`, 'DOC_OPTION_EXCEEDS_CEILING');
    }
    result[key] = userVal;
  }
  return result;
}

/**
 * 严格校验输入结构化数据
 */
function validateStructuredDocument(docData, limits) {
  if (!docData || typeof docData !== 'object' || Array.isArray(docData)) {
    throw docError('Document data must be a non-null object', 'DOC_DATA_INVALID');
  }

  // 1. 必填标题
  if (typeof docData.title !== 'string' || !docData.title.trim()) {
    throw docError('Document title is required and must be a non-empty string', 'DOC_TITLE_REQUIRED');
  }

  // 2. 统计行数与单元格数
  let totalRows = 0;
  let totalCells = 0;

  function checkTable(table, location) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw docError(`Table at ${location} must be an object`, 'DOC_TABLE_INVALID');
    }
    if (!Array.isArray(table.headers) || table.headers.length === 0) {
      throw docError(`Table at ${location} must have a non-empty headers array`, 'DOC_TABLE_HEADERS_REQUIRED');
    }
    for (let i = 0; i < table.headers.length; i++) {
      if (typeof table.headers[i] !== 'string') {
        throw docError(`Table header at ${location} index ${i} must be a string`, 'DOC_TABLE_HEADER_INVALID');
      }
    }
    const colCount = table.headers.length;
    totalCells += colCount;

    if (!Array.isArray(table.rows)) {
      throw docError(`Table rows at ${location} must be an array`, 'DOC_TABLE_ROWS_INVALID');
    }

    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      totalRows++;
      if (!Array.isArray(row)) {
        throw docError(`Table row ${r + 1} at ${location} must be an array`, 'DOC_TABLE_ROW_INVALID');
      }
      // 严格 Fail-Closed：列数不一致直接拒绝
      if (row.length !== colCount) {
        throw docError(
          `Table row ${r + 1} at ${location} has ${row.length} columns, expected ${colCount}`,
          'DOC_TABLE_ROW_LENGTH_MISMATCH'
        );
      }
      totalCells += row.length;
    }
  }

  // 校验段落与表格
  if (docData.sections !== undefined) {
    if (!Array.isArray(docData.sections)) {
      throw docError('Document sections must be an array', 'DOC_SECTIONS_INVALID');
    }
    for (let s = 0; s < docData.sections.length; s++) {
      const sec = docData.sections[s];
      if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
        throw docError(`Section at index ${s} must be an object`, 'DOC_SECTION_INVALID');
      }
      if (sec.paragraphs !== undefined) {
        if (!Array.isArray(sec.paragraphs)) {
          throw docError(`Paragraphs in section ${s + 1} must be an array`, 'DOC_PARAGRAPHS_INVALID');
        }
        for (let p = 0; p < sec.paragraphs.length; p++) {
          const item = sec.paragraphs[p];
          if (typeof item !== 'string' && typeof item !== 'number') {
            throw docError(`Paragraph ${p + 1} in section ${s + 1} must be a string or number`, 'DOC_PARAGRAPH_INVALID');
          }
        }
      }
      if (sec.table !== undefined) {
        checkTable(sec.table, `section ${s + 1}`);
      }
    }
  }

  // 支持顶层 table
  if (docData.table !== undefined) {
    checkTable(docData.table, 'root');
  }

  // 3. 资源边界校验
  if (totalRows > limits.maxRows) {
    throw docError(`Total table rows (${totalRows}) exceeds maxRows limit (${limits.maxRows})`, 'DOC_ROWS_LIMIT_EXCEEDED');
  }
  if (totalCells > limits.maxCells) {
    throw docError(`Total cells (${totalCells}) exceeds maxCells limit (${limits.maxCells})`, 'DOC_CELLS_LIMIT_EXCEEDED');
  }

  return { totalRows, totalCells };
}

/**
 * 生成 Word (.docx) 文档
 */
function generateDocx(docData, limits, degradations) {
  const fflate = getFflate();

  let bodyXml = '';

  // 标题
  bodyXml += `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="2B579A"/></w:rPr><w:t>${escapeXml(docData.title)}</w:t></w:r></w:p>`;

  // 元信息（作者 / 日期）
  const metaParts = [];
  if (docData.author) metaParts.push(`作者: ${docData.author}`);
  if (docData.date) metaParts.push(`日期: ${docData.date}`);
  if (metaParts.length > 0) {
    bodyXml += `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr><w:r><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="20"/></w:rPr><w:t>${escapeXml(metaParts.join('  |  '))}</w:t></w:r></w:p>`;
  }

  function appendTableXml(table) {
    bodyXml += '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="none"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="none"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/><w:insideV w:val="none"/></w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr>';

    // 表头
    bodyXml += '<w:tr><w:trPr><w:tblHeader/></w:trPr>';
    for (const h of table.headers) {
      bodyXml += `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="333333"/></w:rPr><w:t>${escapeXml(h)}</w:t></w:r></w:p></w:tc>`;
    }
    bodyXml += '</w:tr>';

    // 数据行
    for (const row of table.rows) {
      bodyXml += '<w:tr>';
      for (const cell of row) {
        const textVal = cell === null || cell === undefined ? '' : String(cell);
        bodyXml += `<w:tc><w:p><w:r><w:t>${escapeXml(textVal)}</w:t></w:r></w:p></w:tc>`;
      }
      bodyXml += '</w:tr>';
    }
    bodyXml += '</w:tbl>';
    bodyXml += '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>';
  }

  // 章节
  if (docData.sections) {
    for (const sec of docData.sections) {
      if (sec.heading) {
        bodyXml += `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="333333"/></w:rPr><w:t>${escapeXml(sec.heading)}</w:t></w:r></w:p>`;
      }
      if (sec.paragraphs) {
        for (const p of sec.paragraphs) {
          bodyXml += `<w:p><w:pPr><w:spacing w:after="160"/><w:ind w:firstLine="420"/></w:pPr><w:r><w:sz w:val="22"/><w:t>${escapeXml(String(p))}</w:t></w:r></w:p>`;
        }
      }
      if (sec.table) {
        appendTableXml(sec.table);
      }
    }
  }

  if (docData.table) {
    appendTableXml(docData.table);
  }

  // 页面配置
  bodyXml += '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:color w:val="333333"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;

  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/></w:settings>`;

  const zipFiles = {
    '[Content_Types].xml': fflate.strToU8(contentTypesXml),
    '_rels/.rels': fflate.strToU8(rootRelsXml),
    'word/_rels/document.xml.rels': fflate.strToU8(docRelsXml),
    'word/document.xml': fflate.strToU8(documentXml),
    'word/styles.xml': fflate.strToU8(stylesXml),
    'word/settings.xml': fflate.strToU8(settingsXml),
  };

  const zipped = fflate.zipSync(zipFiles);
  const buffer = Buffer.from(zipped);

  if (buffer.length > limits.maxBytes) {
    throw docError(`Generated DOCX file size (${buffer.length}) exceeds maxBytes (${limits.maxBytes})`, 'DOC_BYTES_LIMIT_EXCEEDED');
  }

  return {
    format: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer,
    byteCount: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    degradations,
  };
}

/**
 * 生成 Excel (.xlsx) 文档（严格防范公式注入）
 */
function generateXlsx(docData, limits, degradations) {
  const XLSX = getXlsx();
  if (!XLSX) {
    throw docError('XLSX engine is unavailable', 'XLSX_ENGINE_UNAVAILABLE');
  }

  const wb = XLSX.utils.book_new();

  // 公式注入转义处理
  function sanitizeCell(val, coordinate) {
    if (typeof val === 'string' && FORMULA_INJECTION_REGEX.test(val)) {
      degradations.push({
        type: 'formula_injection_escaped',
        coordinate,
        originalPrefix: val.slice(0, 4),
      });
      return "'" + val;
    }
    return val;
  }

  // 1. 汇总 Sheet
  const summaryRows = [
    ['标题', sanitizeCell(docData.title, 'A1')],
  ];
  if (docData.author) summaryRows.push(['作者', sanitizeCell(docData.author, 'A2')]);
  if (docData.date) summaryRows.push(['日期', sanitizeCell(docData.date, 'A3')]);

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, '概览');

  // 2. 表格 Sheet
  let tableIndex = 1;

  function appendTableSheet(table, sheetTitle) {
    const sheetData = [];
    // 表头
    sheetData.push(table.headers.map((h, ci) => sanitizeCell(h, `R1C${ci + 1}`)));
    // 数据行
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      sheetData.push(row.map((c, ci) => sanitizeCell(c, `R${r + 2}C${ci + 1}`)));
    }
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    const index = tableIndex++;
    const originalTitle = sheetTitle || `数据表${index}`;
    const truncate = (text, length) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
    const baseTitle = originalTitle.replace(/[\[\]\\/?*:\x00-\x1f\x7f]/g, ' ').trim().replace(/^'+|'+$/g, '').trim() || `数据表${index}`;
    let safeTitle = truncate(baseTitle, 31);
    // Excel treats sheet names case-insensitively. Reserve room for a suffix
    // before truncation so duplicate long headings remain valid as well.
    const usedNames = new Set(wb.SheetNames.map(name => name.toLowerCase()));
    for (let suffix = 2; usedNames.has(safeTitle.toLowerCase()); suffix++) {
      const ending = ` (${suffix})`;
      safeTitle = truncate(baseTitle, 31 - ending.length) + ending;
    }
    XLSX.utils.book_append_sheet(wb, ws, safeTitle);
    if (safeTitle !== originalTitle) degradations.push({ type: 'sheet_name_normalized', tableIndex: index });
  }

  if (docData.sections) {
    for (const sec of docData.sections) {
      if (sec.table) {
        appendTableSheet(sec.table, sec.heading || null);
      }
    }
  }

  if (docData.table) {
    appendTableSheet(docData.table, '数据明细');
  }

  const outputBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const buffer = Buffer.isBuffer(outputBuf) ? outputBuf : Buffer.from(outputBuf);

  if (buffer.length > limits.maxBytes) {
    throw docError(`Generated XLSX file size (${buffer.length}) exceeds maxBytes (${limits.maxBytes})`, 'DOC_BYTES_LIMIT_EXCEEDED');
  }

  return {
    format: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
    byteCount: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    degradations,
  };
}

/**
 * 生成 PDF (.pdf) 文档（ISO 32000-1 规范，纯 JS 渲染）
 */
function generatePdf(docData, limits, degradations) {
  // 标准 PDF 页面尺寸：Letter (612 x 792 pt)，边距 54 pt (0.75 in)
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const contentWidth = pageWidth - margin * 2;

  const pages = [];
  let currentCommands = [];
  let currentY = pageHeight - margin;

  function flushPage() {
    if (currentCommands.length > 0) {
      pages.push(currentCommands.join('\n'));
      currentCommands = [];
    }
    currentY = pageHeight - margin;
  }

  function ensureSpace(neededHeight) {
    if (currentY - neededHeight < margin) {
      flushPage();
    }
  }

  function escapePdfText(str) {
    const s = String(str || '');
    if (/^[\x20-\x7e\t\r\n]*$/.test(s)) {
      return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
    }
    const buf = Buffer.alloc(2 + s.length * 2);
    buf.writeUInt16BE(0xfeff, 0);
    for (let i = 0; i < s.length; i++) {
      buf.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
    }
    return '<' + buf.toString('hex') + '>';
  }

  // 1. 标题
  ensureSpace(40);
  currentCommands.push('BT /F2 18 Tf');
  currentCommands.push(`${margin} ${currentY} Td`);
  currentCommands.push(`${escapePdfText(docData.title)} Tj ET`);
  currentY -= 28;

  // 2. 元数据
  const metaParts = [];
  if (docData.author) metaParts.push(`Author: ${docData.author}`);
  if (docData.date) metaParts.push(`Date: ${docData.date}`);
  if (metaParts.length > 0) {
    ensureSpace(20);
    currentCommands.push('BT /F1 9 Tf 0.4 0.4 0.4 rg');
    currentCommands.push(`${margin} ${currentY} Td`);
    currentCommands.push(`${escapePdfText(metaParts.join('  |  '))} Tj 0 0 0 rg ET`);
    currentY -= 24;
  }

  function drawTable(table) {
    const colCount = table.headers.length;
    const colWidth = contentWidth / colCount;
    const rowHeight = 18;

    // 表头
    ensureSpace(rowHeight + 20);
    // 表头背景条
    currentCommands.push(`0.92 0.94 0.96 rg ${margin} ${currentY - 4} ${contentWidth} ${rowHeight} re f 0 0 0 rg`);
    currentCommands.push('BT /F2 9 Tf');
    for (let c = 0; c < colCount; c++) {
      const x = margin + c * colWidth + 4;
      currentCommands.push(`1 0 0 1 ${x} ${currentY} Tm ${escapePdfText(table.headers[c])} Tj`);
    }
    currentCommands.push('ET');
    currentY -= rowHeight;

    // 数据行
    for (let r = 0; r < table.rows.length; r++) {
      ensureSpace(rowHeight);
      const row = table.rows[r];
      // 隔行底纹
      if (r % 2 === 1) {
        currentCommands.push(`0.98 0.98 0.98 rg ${margin} ${currentY - 4} ${contentWidth} ${rowHeight} re f 0 0 0 rg`);
      }
      currentCommands.push('BT /F1 9 Tf');
      for (let c = 0; c < colCount; c++) {
        const val = row[c] === null || row[c] === undefined ? '' : String(row[c]);
        const x = margin + c * colWidth + 4;
        currentCommands.push(`1 0 0 1 ${x} ${currentY} Tm ${escapePdfText(val)} Tj`);
      }
      currentCommands.push('ET');
      currentY -= rowHeight;
    }
    currentY -= 12; // 表格间距
  }

  // 3. 章节
  if (docData.sections) {
    for (const sec of docData.sections) {
      if (sec.heading) {
        ensureSpace(30);
        currentCommands.push('BT /F2 13 Tf 0.15 0.25 0.4 rg');
        currentCommands.push(`${margin} ${currentY} Td`);
        currentCommands.push(`${escapePdfText(sec.heading)} Tj 0 0 0 rg ET`);
        currentY -= 20;
      }
      if (sec.paragraphs) {
        for (const p of sec.paragraphs) {
          ensureSpace(18);
          currentCommands.push('BT /F1 10 Tf');
          currentCommands.push(`${margin} ${currentY} Td`);
          currentCommands.push(`${escapePdfText(String(p))} Tj ET`);
          currentY -= 16;
        }
      }
      if (sec.table) {
        drawTable(sec.table);
      }
    }
  }

  if (docData.table) {
    drawTable(docData.table);
  }

  flushPage();
  if (pages.length === 0) flushPage();

  // 组装标准 PDF 对象树 (ISO 32000-1)
  const objects = [];
  function addObj(body) {
    objects.push(body);
    return objects.length;
  }

  // 预留前序编号
  // Obj 1: Catalog
  // Obj 2: Pages
  // Obj 3: Font F1 (Helvetica)
  // Obj 4: Font F2 (Helvetica-Bold)
  // 之后每页 2 个对象：Page 对象 + Contents Stream 对象
  const catalogObjId = addObj('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesObjId = addObj(''); // 占位，稍后回填 Kids
  const fontF1ObjId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontF2ObjId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageObjIds = [];
  for (let i = 0; i < pages.length; i++) {
    const pageObjId = objects.length + 1;
    const contentsObjId = objects.length + 2;
    pageObjIds.push(pageObjId);

    const streamBody = pages[i];
    const streamLen = Buffer.byteLength(streamBody, 'latin1');

    addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentsObjId} 0 R /Resources << /Font << /F1 ${fontF1ObjId} 0 R /F2 ${fontF2ObjId} 0 R >> >> >>`);
    addObj(`<< /Length ${streamLen} >>\nstream\n${streamBody}\nendstream`);
  }

  // 回填 Pages 对象
  const kidsStr = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  objects[pagesObjId - 1] = `<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjIds.length} >>`;

  // 写入 PDF 字节流与交叉引用表 (xref)
  let pdfOutput = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdfOutput, 'latin1'));
    pdfOutput += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const startxref = Buffer.byteLength(pdfOutput, 'latin1');
  pdfOutput += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdfOutput += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdfOutput += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${startxref}\n%%EOF`;

  const buffer = Buffer.from(pdfOutput, 'latin1');

  if (buffer.length > limits.maxBytes) {
    throw docError(`Generated PDF file size (${buffer.length}) exceeds maxBytes (${limits.maxBytes})`, 'DOC_BYTES_LIMIT_EXCEEDED');
  }

  return {
    format: 'pdf',
    mime: 'application/pdf',
    buffer,
    byteCount: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    degradations,
  };
}

/**
 * 统一主导出入口
 *
 * @param {Object} docData - 结构化数据 { title, author, date, sections, table }
 * @param {Object} [options]
 * @param {'docx'|'pdf'|'xlsx'} options.format - 目标格式
 * @param {number} [options.maxRows] - 最大行数
 * @param {number} [options.maxCells] - 最大单元格数
 * @param {number} [options.maxBytes] - 最大字节上限
 * @param {number} [options.timeoutMs] - 超时毫秒
 * @returns {Object} { format, mime, buffer, byteCount, sha256, degradations }
 */
function exportDocumentCandidate(docData, options = {}) {
  const startedAt = Date.now();

  const format = String(options.format || '').toLowerCase();
  if (!SUPPORTED_FORMATS.has(format)) {
    throw docError(`Unsupported format: '${options.format}'. Allowed: docx, pdf, xlsx`, 'DOC_FORMAT_UNSUPPORTED');
  }

  const limits = resolveLimits(options);
  // Generate only from a bounded, detached, immutable JSON value. The older
  // format-specific validator remains a second contract check.
  const guarded = guardStructuredDocumentInput(docData);
  docData = guarded.normalized;
  validateStructuredDocument(docData, limits);

  const degradations = [];

  // 超时检查钩子
  if (Date.now() - startedAt > limits.timeoutMs) {
    throw docError('Document generation timed out during validation', 'DOC_TIMEOUT');
  }

  let result;
  if (format === 'docx') {
    result = generateDocx(docData, limits, degradations);
  } else if (format === 'xlsx') {
    result = generateXlsx(docData, limits, degradations);
  } else if (format === 'pdf') {
    result = generatePdf(docData, limits, degradations);
  }

  if (Date.now() - startedAt > limits.timeoutMs) {
    throw docError('Document generation timed out during rendering', 'DOC_TIMEOUT');
  }

  return Object.freeze(result);
}

module.exports = {
  exportDocumentCandidate,
  resolveLimits,
  validateStructuredDocument,
  DEFAULT_LIMITS,
  HARD_CEILINGS,
  SUPPORTED_FORMATS,
  FORMULA_INJECTION_REGEX,
};
