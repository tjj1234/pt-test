'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Unzip, UnzipInflate } = require(path.join(__dirname, '../../node_modules/fflate'));

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_EXPANDED_BYTES = 32 * 1024 * 1024; // 32MB
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验文档 Magic Bytes
 */
function detectMagicFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  // PDF: %PDF-
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf';
  }

  // ZIP / OOXML: PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'zip';
  }

  // OLE Compound File (旧版 .doc, .xls, .ppt): D0 CF 11 E0 A1 B1 1A E1
  if (buffer.length >= 8 &&
      buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0 &&
      buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1) {
    return 'legacy-ole';
  }

  return null;
}

function createDocInputParser(options = {}) {
  const ocrBackend = options.ocrBackend || null;
  const legacyConverter = options.legacyConverter || null;

  async function parseDocument(params) {
    const startTime = Date.now();
    const { runId, tenantId, buffer, format, options: docOpts = {}, signal } = params || {};

    if (!runId || !tenantId) {
      return { ok: false, code: 'DOC_INPUT_INVALID', detail: 'runId and tenantId are required' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'DOC_CANCELLED' };
    }

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, code: 'DOC_INPUT_INVALID', detail: 'buffer must be a non-empty Buffer' };
    }

    const detected = detectMagicFormat(buffer);
    const normalizedFormat = (format || '').toLowerCase();

    // 格式与 Magic 校验
    if (normalizedFormat === 'pdf' && detected !== 'pdf') {
      return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED', detail: 'Magic bytes do not match PDF' };
    }
    if (normalizedFormat === 'zip' && detected !== 'zip') {
      return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED', detail: 'Magic bytes do not match ZIP' };
    }
    if (['doc', 'xls', 'ppt'].includes(normalizedFormat) && detected !== 'legacy-ole') {
      return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED', detail: 'Magic bytes do not match Legacy Office OLE' };
    }
    if (!['pdf', 'zip', 'doc', 'xls', 'ppt'].includes(normalizedFormat)) {
      return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED', detail: `Unsupported format: ${format}` };
    }

    const inputSha256 = sha256(buffer);
    const timeoutMs = Math.min(docOpts.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // --- 1. ZIP 文件处理 ---
    if (normalizedFormat === 'zip') {
      const maxEntries = docOpts.maxEntries || DEFAULT_MAX_ENTRIES;
      const maxExpandedBytes = docOpts.maxExpandedBytes || DEFAULT_MAX_EXPANDED_BYTES;

      return new Promise((resolve) => {
        let settled = false;
        const entries = [];
        let totalExpanded = 0;
        const entryNames = new Set();

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, code: 'DOC_TIMEOUT', detail: 'ZIP inspection timed out' });
        }, timeoutMs);

        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, code: 'DOC_CANCELLED' });
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const unzip = new Unzip((file) => {
          if (settled) return;

          // 路径穿越与非法字符检查
          const name = file.name;
          if (
            name.startsWith('/') ||
            name.includes('\\') ||
            name.split('/').some((part) => part === '..' || part === '.') ||
            /^[A-Za-z]:/.test(name)
          ) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, code: 'ZIP_TRAVERSAL_REJECTED', detail: `Illegal path in zip: ${name}` });
            return;
          }

          // 活跃内容 / 宏脚本拦截
          if (/vbaProject\.bin$|\.(?:exe|vbs|bat|cmd|ps1|scr|dll)$/i.test(name)) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, code: 'ZIP_ACTIVE_CONTENT_REJECTED', detail: `Active script/executable in zip: ${name}` });
            return;
          }

          if (entryNames.has(name)) {
            // 重复条目略过或记录
          }
          entryNames.add(name);

          if (entryNames.size > maxEntries) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, code: 'ZIP_ENTRY_LIMIT', detail: `Entry count exceeds ${maxEntries}` });
            return;
          }

          let fileChunks = [];
          let fileBytes = 0;

          file.ondata = (err, chunk, final) => {
            if (settled) return;
            if (err) {
              settled = true;
              clearTimeout(timer);
              resolve({ ok: false, code: 'DOC_INPUT_INVALID', detail: err.message });
              return;
            }

            fileChunks.push(chunk);
            fileBytes += chunk.length;
            totalExpanded += chunk.length;

            if (totalExpanded > maxExpandedBytes) {
              settled = true;
              clearTimeout(timer);
              resolve({ ok: false, code: 'ZIP_EXPANSION_LIMIT', detail: `Total expanded bytes exceed ${maxExpandedBytes}` });
              return;
            }

            if (final) {
              const fileBuf = Buffer.concat(fileChunks);
              entries.push({
                name,
                size: fileBytes,
                sha256: sha256(fileBuf),
              });
            }
          };

          file.start();
        });

        unzip.register(UnzipInflate);

        try {
          for (let i = 0; i < buffer.length; i += 4096) {
            if (settled) break;
            unzip.push(buffer.subarray(i, i + 4096), i + 4096 >= buffer.length);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, code: 'DOC_INPUT_INVALID', detail: err.message });
            return;
          }
        }

        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: true,
            format: 'zip',
            inputSha256,
            entries,
            truncated: false,
            durationMs: Date.now() - startTime,
          });
        }
      });
    }

    // --- 2. 旧版 Office (.doc / .xls / .ppt) 处理 ---
    if (['doc', 'xls', 'ppt'].includes(normalizedFormat)) {
      if (!legacyConverter) {
        return {
          ok: false,
          code: 'LEGACY_OFFICE_CONVERTER_UNAVAILABLE',
          detail: `No converter available for legacy ${normalizedFormat.toUpperCase()} format (fail-closed)`,
        };
      }

      try {
        const convertRes = await legacyConverter({ buffer, format: normalizedFormat, signal });
        return {
          ok: true,
          format: normalizedFormat,
          inputSha256,
          pages: convertRes.pages || [],
          pageCount: (convertRes.pages || []).length,
          truncated: false,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        return { ok: false, code: 'LEGACY_CONVERT_FAILED', detail: err.message };
      }
    }

    // --- 3. PDF 处理 ---
    if (normalizedFormat === 'pdf') {
      const pdfString = buffer.toString('binary');

      // 加密检测
      if (pdfString.includes('/Encrypt')) {
        return { ok: false, code: 'ENCRYPTED_FILE_REJECTED', detail: 'Encrypted or password protected PDF' };
      }

      const maxPages = docOpts.maxPages || DEFAULT_MAX_PAGES;
      const isScanOnly = pdfString.includes('/Subtype /Image') && !pdfString.includes('BT\n') && !pdfString.includes('BT\r');

      if (isScanOnly) {
        if (!docOpts.enableOcr) {
          return {
            ok: true,
            format: 'pdf',
            inputSha256,
            pageCount: 1,
            pages: [{ pageNumber: 1, text: '', isOcr: false }],
            truncated: false,
            durationMs: Date.now() - startTime,
          };
        }

        if (!ocrBackend) {
          return {
            ok: false,
            code: 'OCR_UNAVAILABLE',
            detail: 'OCR requested for scanned document but no OCR backend provided',
          };
        }

        const ocrPages = await ocrBackend({ buffer, signal });
        return {
          ok: true,
          format: 'pdf',
          inputSha256,
          pageCount: ocrPages.length,
          pages: ocrPages.map((p, idx) => ({ pageNumber: idx + 1, text: p.text, isOcr: true })),
          truncated: false,
          durationMs: Date.now() - startTime,
        };
      }

      // 简单文本 PDF 提取模拟（逐页）
      const pageMarkers = pdfString.split('/Type /Page\n');
      const detectedPages = Math.max(1, pageMarkers.length - 1);
      const pages = [];

      for (let i = 1; i <= Math.min(detectedPages, maxPages); i++) {
        pages.push({
          pageNumber: i,
          text: `Extracted text from PDF page ${i}`,
          isOcr: false,
        });
      }

      return {
        ok: true,
        format: 'pdf',
        inputSha256,
        pageCount: detectedPages,
        pages,
        truncated: detectedPages > maxPages,
        durationMs: Date.now() - startTime,
      };
    }

    return { ok: false, code: 'DOC_FORMAT_UNSUPPORTED' };
  }

  return {
    parseDocument,
    detectMagicFormat,
    sha256,
  };
}

module.exports = {
  createDocInputParser,
  detectMagicFormat,
  sha256,
};
