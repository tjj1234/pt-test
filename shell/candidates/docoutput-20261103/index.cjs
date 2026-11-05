'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { zipSync, strToU8 } = require(path.join(__dirname, '../../node_modules/fflate'));

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_PARAGRAPHS = 2000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TITLE_LEN = 500;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function escapeXml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function checkIllegalChars(str) {
  if (!str || typeof str !== 'string') return;
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe || code === 0xffff) {
      throw Object.assign(new Error(`Illegal control character U+${code.toString(16)}`), { code: 'ILLEGAL_CONTROL_CHARS' });
    }
  }
}

/**
 * 字符串转 PDF UTF-16BE 十六进制表示（支持全量中文字符）
 */
function toPdfHexString(str) {
  const s = str || '';
  const buf = Buffer.alloc(s.length * 2 + 2);
  buf[0] = 0xfe;
  buf[1] = 0xff; // UTF-16BE BOM
  for (let i = 0; i < s.length; i++) {
    buf.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
  }
  return `<${buf.toString('hex').toUpperCase()}>`;
}

/**
 * 生成规范的中文 PDF 二进制流
 */
function buildChinesePdf({ title, sections }) {
  const objects = [];
  function addObject(content) {
    objects.push(content);
    return objects.length; // 1-based object index
  }

  // 1: Catalog
  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  // 2: Pages (占位更新)
  addObject('');
  // 3: Font (支持中文的标准字体声明)
  addObject(`<<
  /Type /Font
  /Subtype /Type0
  /BaseFont /STSong-Light
  /Encoding /UniGB-UCS2-H
  /DescendantFonts [<<
    /Type /Font
    /Subtype /CIDFontType0
    /BaseFont /STSong-Light
    /CIDSystemInfo <<
      /Registry (Adobe)
      /Ordering (GB1)
      /Supplement 4
    >>
  >>]
>>`);

  const pageObjIds = [];

  // 搜集所有段落文本
  const allLines = [];
  if (title) allLines.push({ text: title, isHeading: true });
  for (const sec of (sections || [])) {
    if (sec.heading) allLines.push({ text: sec.heading, isHeading: true });
    for (const p of (sec.paragraphs || [])) {
      allLines.push({ text: p, isHeading: false });
    }
  }

  // 简单分页：每页最多 30 行
  const LINES_PER_PAGE = 30;
  for (let i = 0; i < Math.max(1, allLines.length); i += LINES_PER_PAGE) {
    const chunk = allLines.slice(i, i + LINES_PER_PAGE);

    // 构建内容流
    let streamBody = 'BT\n/F1 12 Tf\n50 780 Td\n18 TL\n';
    for (const line of chunk) {
      const hex = toPdfHexString(line.text);
      if (line.isHeading) {
        streamBody += `/F1 16 Tf\n${hex} Tj\nT*\n/F1 12 Tf\n`;
      } else {
        streamBody += `${hex} Tj\nT*\n`;
      }
    }
    streamBody += 'ET\n';

    const streamObjId = addObject(`<< /Length ${Buffer.byteLength(streamBody, 'ascii')} >>\nstream\n${streamBody}endstream`);
    const pageObjId = addObject(`<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [0 0 595 842]
  /Resources <<
    /Font << /F1 3 0 R >>
  >>
  /Contents ${streamObjId} 0 R
>>`);
    pageObjIds.push(pageObjId);
  }

  // 回填 Pages 对象 (Obj 2)
  objects[1] = `<<
  /Type /Pages
  /Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}]
  /Count ${pageObjIds.length}
>>`;

  // 拼接成标准 PDF 文件
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(output.length);
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = output.length;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }

  output += `trailer\n<<
  /Size ${objects.length + 1}
  /Root 1 0 R
>>
startxref
${xrefOffset}
%%EOF`;

  return Buffer.from(output, 'latin1');
}

/**
 * 生成规范的 DOCX 二进制包
 */
function buildDocx({ title, sections }) {
  let bodyXml = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>`;

  for (const sec of (sections || [])) {
    if (sec.heading) {
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escapeXml(sec.heading)}</w:t></w:r></w:p>`;
    }
    for (const p of (sec.paragraphs || [])) {
      bodyXml += `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`;
    }
  }

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
  </w:body>
</w:document>`),
  };

  return Buffer.from(zipSync(files));
}

/**
 * 生成防公式注入的规范 XLSX 二进制包
 */
function buildXlsx({ sheets }) {
  const sanitizeCell = (val) => {
    if (val === null || val === undefined) return { type: 'empty', val: '' };
    if (typeof val === 'number') return { type: 'num', val: String(val) };
    if (typeof val === 'boolean') return { type: 'bool', val: val ? '1' : '0' };
    let str = String(val);
    checkIllegalChars(str);
    // 公式注入转义：开头若为 = + - @ \t \r，前缀单引号
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return { type: 'str', val: escapeXml(str) };
  };

  const sheetEntries = sheets || [{ name: 'Sheet1', rows: [] }];
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetEntries.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetEntries.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n  ')}
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetEntries.map((s, i) => `<sheet name="${escapeXml(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`),
  };

  sheetEntries.forEach((s, i) => {
    let sheetXml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
    const rows = s.rows || [];
    rows.forEach((r, rowIdx) => {
      sheetXml += `<row r="${rowIdx + 1}">`;
      (r || []).forEach((c, colIdx) => {
        const colLetter = String.fromCharCode(65 + (colIdx % 26));
        const ref = `${colLetter}${rowIdx + 1}`;
        const item = sanitizeCell(c);
        if (item.type === 'num') {
          sheetXml += `<c r="${ref}"><v>${item.val}</v></c>`;
        } else if (item.type === 'bool') {
          sheetXml += `<c r="${ref}" t="b"><v>${item.val}</v></c>`;
        } else if (item.type === 'str') {
          sheetXml += `<c r="${ref}" t="inlineStr"><is><t>${item.val}</t></is></c>`;
        }
      });
      sheetXml += `</row>`;
    });
    sheetXml += `</sheetData></worksheet>`;
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml);
  });

  return Buffer.from(zipSync(files));
}

function createDocOutputGenerator() {
  async function generateDocument(params) {
    const startTime = Date.now();
    const { runId, tenantId, artifactVersion, format, content = {}, resourceLimits = {}, signal } = params || {};

    if (!runId || !tenantId || !artifactVersion) {
      return { ok: false, code: 'DOC_INPUT_INVALID', detail: 'runId, tenantId, and artifactVersion are required' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'DOC_CANCELLED' };
    }

    const fmt = (format || '').toLowerCase();
    if (!['pdf', 'docx', 'xlsx'].includes(fmt)) {
      return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED', detail: `Unsupported export format: ${format}` };
    }

    const title = content.title || '';
    if (typeof title !== 'string' || title.length > MAX_TITLE_LEN) {
      return { ok: false, code: 'DOC_INPUT_LIMIT', detail: `Title length exceeds ${MAX_TITLE_LEN}` };
    }
    try {
      checkIllegalChars(title);
    } catch (err) {
      return { ok: false, code: err.code || 'DOC_INPUT_INVALID', detail: err.message };
    }

    const maxOutputBytes = resourceLimits.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    const maxParagraphs = resourceLimits.maxParagraphs || DEFAULT_MAX_PARAGRAPHS;

    let totalParagraphs = 0;
    for (const sec of (content.sections || [])) {
      totalParagraphs += (sec.paragraphs || []).length;
    }
    if (totalParagraphs > maxParagraphs) {
      return { ok: false, code: 'DOC_INPUT_LIMIT', detail: `Paragraph count ${totalParagraphs} exceeds limit ${maxParagraphs}` };
    }

    let buffer;
    let mimeType;

    try {
      if (fmt === 'pdf') {
        buffer = buildChinesePdf({ title, sections: content.sections });
        mimeType = 'application/pdf';
      } else if (fmt === 'docx') {
        buffer = buildDocx({ title, sections: content.sections });
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (fmt === 'xlsx') {
        buffer = buildXlsx({ sheets: content.sheets });
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
    } catch (err) {
      return { ok: false, code: err.code || 'DOC_GENERATION_FAILED', detail: err.message };
    }

    if (buffer.length > maxOutputBytes) {
      return { ok: false, code: 'DOC_OUTPUT_LIMIT', detail: `Generated output ${buffer.length} exceeds ${maxOutputBytes}` };
    }

    return {
      ok: true,
      format: fmt,
      mimeType,
      runId,
      tenantId,
      artifactVersion,
      buffer,
      byteLength: buffer.length,
      sha256: sha256(buffer),
      durationMs: Date.now() - startTime,
    };
  }

  return {
    generateDocument,
    sha256,
  };
}

module.exports = {
  createDocOutputGenerator,
  buildChinesePdf,
  buildDocx,
  buildXlsx,
  sha256,
};
