import { createRequire } from 'node:module';
import { createDocInputParser, detectMagicFormat, sha256 } from '../../shell/candidates/docinput-20261103/index.cjs';

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('../../shell/node_modules/fflate');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✖ [FAIL] ${message}`);
    failed++;
  }
}

// 辅助构造 PDF Buffer
function createTextPdfBuffer() {
  const content = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page\n>>\nendobj\n4 0 obj\n<< /Type /Page\n>>\nendobj\nxref\ntrailer\n<< /Root 1 0 R >>\n%%EOF`;
  return Buffer.from(content, 'ascii');
}

function createEncryptedPdfBuffer() {
  const content = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Page /Encrypt 5 0 R >>\nendobj\n%%EOF`;
  return Buffer.from(content, 'ascii');
}

function createScannedPdfBuffer() {
  const content = `%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /XObject << /Im1 2 0 R >> >> >>\nendobj\n2 0 obj\n<< /Type /XObject /Subtype /Image >>\nendobj\n%%EOF`;
  return Buffer.from(content, 'ascii');
}

function createLegacyOleBuffer() {
  const buf = Buffer.alloc(512);
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  buf.write('Word.Document.8', 32, 'ascii');
  return buf;
}

async function run() {
  console.log('\n=== DOCINPUT 格式与有界输入解析探针开始 ===\n');

  // [1] Magic Bytes 探测
  console.log('[1] Magic Bytes 探测');
  {
    assert(detectMagicFormat(createTextPdfBuffer()) === 'pdf', 'PDF magic 识别');
    assert(detectMagicFormat(createLegacyOleBuffer()) === 'legacy-ole', 'Legacy Office OLE magic 识别');
    const simpleZip = Buffer.from(zipSync({ 'test.txt': strToU8('hello') }));
    assert(detectMagicFormat(simpleZip) === 'zip', 'ZIP magic 识别');
    assert(detectMagicFormat(Buffer.from('UNKNOWN')) === null, '未知数据返回 null');
  }

  const parser = createDocInputParser();

  // [2] 格式与伪造数据拦截
  console.log('\n[2] 格式与伪造数据拦截');
  {
    const badBuf = Buffer.from('FAKE_PDF_HEADER');
    const resBad = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: badBuf,
      format: 'pdf',
    });
    assert(resBad.ok === false && resBad.code === 'DOC_FORMAT_UNSUPPORTED', '伪造 PDF 返回 DOC_FORMAT_UNSUPPORTED');

    const resEncrypted = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: createEncryptedPdfBuffer(),
      format: 'pdf',
    });
    assert(resEncrypted.ok === false && resEncrypted.code === 'ENCRYPTED_FILE_REJECTED', '加密 PDF 拦截 ENCRYPTED_FILE_REJECTED');
  }

  // [3] PDF 文本与 OCR 处理
  console.log('\n[3] PDF 文本与 OCR 处理');
  {
    const textPdf = createTextPdfBuffer();
    const resText = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: textPdf,
      format: 'pdf',
    });
    assert(resText.ok === true, '文本 PDF 解析成功 ok=true');
    assert(resText.pageCount === 2, '识别页数为 2');
    assert(resText.pages.length === 2, '提取页数完整');
    assert(resText.inputSha256 === sha256(textPdf), 'inputSha256 计算精确');

    // 扫描件未开 OCR
    const scanPdf = createScannedPdfBuffer();
    const resScanNoOcr = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: scanPdf,
      format: 'pdf',
      options: { enableOcr: false },
    });
    assert(resScanNoOcr.ok === true, '扫描件未启用 OCR 正常返回');
    assert(resScanNoOcr.pages[0].text === '', '扫描件文本为空');

    // 扫描件开 OCR 但无后端
    const resScanNoBackend = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: scanPdf,
      format: 'pdf',
      options: { enableOcr: true },
    });
    assert(resScanNoBackend.ok === false && resScanNoBackend.code === 'OCR_UNAVAILABLE', '无 OCR 后端时 fail-closed 返回 OCR_UNAVAILABLE');

    // 挂载 OCR 后端
    const ocrParser = createDocInputParser({
      ocrBackend: async () => [{ text: 'Scanned OCR Chinese Text' }],
    });
    const resScanOcr = await ocrParser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: scanPdf,
      format: 'pdf',
      options: { enableOcr: true },
    });
    assert(resScanOcr.ok === true, 'OCR 挂载解析 ok=true');
    assert(resScanOcr.pages[0].isOcr === true, '标记 isOcr=true');
    assert(resScanOcr.pages[0].text === 'Scanned OCR Chinese Text', 'OCR 提取文本正确');
  }

  // [4] 旧版 Office (.doc / .xls / .ppt) fail-closed 与转码
  console.log('\n[4] 旧版 Office fail-closed 与转码');
  {
    const oleDoc = createLegacyOleBuffer();
    const resNoConv = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: oleDoc,
      format: 'doc',
    });
    assert(resNoConv.ok === false && resNoConv.code === 'LEGACY_OFFICE_CONVERTER_UNAVAILABLE', '无转码器 fail-closed');

    const convParser = createDocInputParser({
      legacyConverter: async () => ({
        pages: [{ pageNumber: 1, text: 'Legacy Word Document Text' }],
      }),
    });
    const resConv = await convParser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: oleDoc,
      format: 'doc',
    });
    assert(resConv.ok === true, '旧版 Office 转换解析 ok=true');
    assert(resConv.pages[0].text === 'Legacy Word Document Text', '转码文本正确');
  }

  // [5] ZIP 安全解包与边界防护
  console.log('\n[5] ZIP 安全解包与边界防护');
  {
    // 正常 ZIP
    const normalZip = Buffer.from(
      zipSync({
        'data.csv': strToU8('col1,col2\n1,2\n'),
        'notes.txt': strToU8('meeting notes'),
      })
    );
    const resZip = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: normalZip,
      format: 'zip',
    });
    assert(resZip.ok === true, '正常 ZIP 解析 ok=true');
    assert(resZip.entries.length === 2, '成功读取 2 个条目');
    assert(resZip.entries.some((e) => e.name === 'data.csv'), '包含 data.csv');
    assert(resZip.inputSha256 === sha256(normalZip), 'ZIP inputSha256 精确');

    // 路径穿越攻击 ZIP
    const traversalZip = Buffer.from(
      zipSync({
        '../../etc/passwd': strToU8('root:x:0:0:root'),
      })
    );
    const resTraversal = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: traversalZip,
      format: 'zip',
    });
    assert(resTraversal.ok === false && resTraversal.code === 'ZIP_TRAVERSAL_REJECTED', '路径穿越被 ZIP_TRAVERSAL_REJECTED 阻断');

    // 宏 / 可执行载荷 ZIP
    const macroZip = Buffer.from(
      zipSync({
        'word/vbaProject.bin': strToU8('FAKE_MACRO'),
      })
    );
    const resMacro = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: macroZip,
      format: 'zip',
    });
    assert(resMacro.ok === false && resMacro.code === 'ZIP_ACTIVE_CONTENT_REJECTED', 'VBA 宏被 ZIP_ACTIVE_CONTENT_REJECTED 阻断');

    // 条目上限拦截
    const manyFiles = {};
    for (let i = 0; i < 20; i++) manyFiles[`file_${i}.txt`] = strToU8('content');
    const limitZip = Buffer.from(zipSync(manyFiles));
    const resLimit = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: limitZip,
      format: 'zip',
      options: { maxEntries: 10 },
    });
    assert(resLimit.ok === false && resLimit.code === 'ZIP_ENTRY_LIMIT', '条目超限被 ZIP_ENTRY_LIMIT 阻断');

    // 解压炸弹防御
    const resBomb = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: normalZip,
      format: 'zip',
      options: { maxExpandedBytes: 10 },
    });
    assert(resBomb.ok === false && resBomb.code === 'ZIP_EXPANSION_LIMIT', '展开字节超限被 ZIP_EXPANSION_LIMIT 阻断');
  }

  // [6] 取消信号与生命周期
  console.log('\n[6] 取消信号与生命周期');
  {
    const ctrl = new AbortController();
    ctrl.abort();
    const resCancel = await parser.parseDocument({
      runId: 'run-d1',
      tenantId: 'tenant-1',
      buffer: createTextPdfBuffer(),
      format: 'pdf',
      signal: ctrl.signal,
    });
    assert(resCancel.ok === false && resCancel.code === 'DOC_CANCELLED', '信号取消返回 DOC_CANCELLED');
  }

  console.log(`\n=== DOCINPUT 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('DocInput probe fatal error:', err);
  process.exit(1);
});
