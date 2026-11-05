import { createRequire } from 'node:module';
import { createDocOutputGenerator, sha256 } from '../../shell/candidates/docoutput-20261103/index.cjs';
import { createDocInputParser } from '../../shell/candidates/docinput-20261103/index.cjs';

const require = createRequire(import.meta.url);
const { unzipSync } = require('../../shell/node_modules/fflate');

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

async function run() {
  console.log('\n=== DOCOUTPUT 模型文档产物与中文PDF探针开始 ===\n');

  const generator = createDocOutputGenerator();

  // [1] 中文 PDF 渲染与结构规范
  console.log('[1] 中文 PDF 渲染与结构规范');
  {
    const resPdf = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'pdf',
      content: {
        title: '人工智能数据分析报告',
        sections: [
          {
            heading: '一、前言与背景',
            paragraphs: [
              '随着大模型技术的演进，企业端应用逐步迈进复杂业务场景。',
              '本轮重构重点聚焦于最大化复用已有底座能力。',
            ],
          },
          {
            heading: '二、核心结论',
            paragraphs: ['所有功能包均遵循严格的沙箱与安全契约规范。'],
          },
        ],
      },
    });

    assert(resPdf.ok === true, 'PDF 生成成功 ok=true');
    assert(resPdf.mimeType === 'application/pdf', 'MIME 为 application/pdf');
    assert(resPdf.format === 'pdf', 'format 为 pdf');
    assert(resPdf.artifactVersion === 'v1.0.0', '版本号绑定正确');
    assert(resPdf.runId === 'run-out-1', 'runId 强绑定');

    const pdfRaw = resPdf.buffer.toString('latin1');
    assert(pdfRaw.startsWith('%PDF-1.4'), '包含合法 PDF 1.4 头部');
    assert(pdfRaw.includes('STSong-Light') && pdfRaw.includes('UniGB-UCS2-H'), '包含中文字体与编码声明');
    assert(pdfRaw.includes('startxref') && pdfRaw.includes('%%EOF'), '包含标准交叉引用表与尾部标识');
    assert(resPdf.sha256 === sha256(resPdf.buffer), '产物 SHA256 精确');
  }

  // [2] DOCX 生成与反读解包校验
  console.log('\n[2] DOCX 生成与反读解包校验');
  {
    const resDocx = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'docx',
      content: {
        title: '需求规格说明书',
        sections: [
          {
            heading: '模块一',
            paragraphs: ['这是 DOCX 段落测试文本内容。'],
          },
        ],
      },
    });

    assert(resDocx.ok === true, 'DOCX 生成 ok=true');
    assert(resDocx.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX MIME 正确');

    // 反读验证 ZIP 结构
    const unzipped = unzipSync(new Uint8Array(resDocx.buffer));
    assert(unzipped['[Content_Types].xml'] != null, '包含 [Content_Types].xml');
    assert(unzipped['word/document.xml'] != null, '包含 word/document.xml');

    const docXml = Buffer.from(unzipped['word/document.xml']).toString('utf8');
    assert(docXml.includes('需求规格说明书'), '反读包含中文标题');
    assert(docXml.includes('这是 DOCX 段落测试文本内容。'), '反读包含正文内容');
  }

  // [3] XLSX 生成与公式注入防御
  console.log('\n[3] XLSX 生成与公式注入防御');
  {
    const resXlsx = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'xlsx',
      content: {
        title: '测试表格',
        sheets: [
          {
            name: '财务清单',
            rows: [
              ['项目', '金额', '状态', '公式注入测试'],
              ['服务器开销', 1250.5, true, '=SUM(A1:A10)'], // 恶意公式注入尝试
              ['域名费用', 35, false, '+cmd|/c calc'],       // 恶意公式注入尝试
            ],
          },
        ],
      },
    });

    assert(resXlsx.ok === true, 'XLSX 生成 ok=true');
    const unzipped = unzipSync(new Uint8Array(resXlsx.buffer));
    assert(unzipped['xl/worksheets/sheet1.xml'] != null, '包含 sheet1.xml');

    const sheetXml = Buffer.from(unzipped['xl/worksheets/sheet1.xml']).toString('utf8');
    assert(sheetXml.includes('财务清单') || unzipped['xl/workbook.xml'] != null, '工作表存在');
    assert(sheetXml.includes("&apos;=SUM(A1:A10)") || sheetXml.includes("'=SUM(A1:A10)"), '以 = 开头的公式被单引号转义');
    assert(sheetXml.includes("&apos;+cmd|/c calc") || sheetXml.includes("'+cmd|/c calc"), '以 + 开头的公式被单引号转义');
    assert(!sheetXml.includes('<f>'), '严禁生成 <f> 裸公式节点');
  }

  // [4] 非法字符与参数边界校验
  console.log('\n[4] 非法字符与参数边界校验');
  {
    // 非法控制字符
    const resIllegal = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'pdf',
      content: {
        title: 'Bad\x00Title',
      },
    });
    assert(resIllegal.ok === false && resIllegal.code === 'ILLEGAL_CONTROL_CHARS', '含非法控制字符返回 ILLEGAL_CONTROL_CHARS');

    // 不支持的格式
    const resBadFmt = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'epub',
      content: { title: 'Test' },
    });
    assert(resBadFmt.ok === false && resBadFmt.code === 'DOC_FORMAT_UNSUPPORTED', '不支持格式返回 DOC_FORMAT_UNSUPPORTED');

    // 缺少必填元信息
    const resMissing = await generator.generateDocument({
      runId: '',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'pdf',
    });
    assert(resMissing.ok === false && resMissing.code === 'DOC_INPUT_INVALID', '缺少 runId 返回 DOC_INPUT_INVALID');

    // 输出体积超限
    const resLimit = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'pdf',
      content: { title: 'Overlimit' },
      resourceLimits: { maxOutputBytes: 100 },
    });
    assert(resLimit.ok === false && resLimit.code === 'DOC_OUTPUT_LIMIT', '产物体积超限返回 DOC_OUTPUT_LIMIT');

    // 外部取消
    const ctrl = new AbortController();
    ctrl.abort();
    const resCancel = await generator.generateDocument({
      runId: 'run-out-1',
      tenantId: 'tenant-prod',
      artifactVersion: 'v1.0.0',
      format: 'pdf',
      content: { title: 'Cancel' },
      signal: ctrl.signal,
    });
    assert(resCancel.ok === false && resCancel.code === 'DOC_CANCELLED', '信号取消返回 DOC_CANCELLED');
  }

  // [5] 跨包闭环验证 (将生成的 PDF/DOCX 交给 docinput-20261103 探测)
  console.log('\n[5] 跨包闭环验证');
  {
    const pdfDoc = await generator.generateDocument({
      runId: 'run-chain',
      tenantId: 'tenant-chain',
      artifactVersion: 'v2.0.0',
      format: 'pdf',
      content: {
        title: '双向验证文档',
        sections: [{ paragraphs: ['测试输入输出闭环'] }],
      },
    });

    const inParser = createDocInputParser();
    const parseRes = await inParser.parseDocument({
      runId: 'run-chain',
      tenantId: 'tenant-chain',
      buffer: pdfDoc.buffer,
      format: 'pdf',
    });

    assert(parseRes.ok === true, '导出的 PDF 成功被 docinput 包识别解析');
    assert(parseRes.inputSha256 === pdfDoc.sha256, '双包传递 SHA256 完全对齐');
  }

  console.log(`\n=== DOCOUTPUT 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('DocOutput probe fatal error:', err);
  process.exit(1);
});
