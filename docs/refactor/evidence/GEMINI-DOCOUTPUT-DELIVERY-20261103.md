# GEMINI-DOCOUTPUT-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/docoutput-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**28/28 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | 中文 PDF 渲染 | PDF 生成成功 ok=true | ✔ PASS |
| 2 | 中文 PDF 渲染 | MIME 为 application/pdf | ✔ PASS |
| 3 | 中文 PDF 渲染 | format 为 pdf | ✔ PASS |
| 4 | 中文 PDF 渲染 | 版本号绑定正确 | ✔ PASS |
| 5 | 中文 PDF 渲染 | runId 强绑定 | ✔ PASS |
| 6 | 中文 PDF 渲染 | 包含合法 PDF 1.4 头部 | ✔ PASS |
| 7 | 中文 PDF 渲染 | 包含中文字体与编码声明 | ✔ PASS |
| 8 | 中文 PDF 渲染 | 包含标准交叉引用表与尾部标识 | ✔ PASS |
| 9 | 中文 PDF 渲染 | 产物 SHA256 精确 | ✔ PASS |
| 10 | DOCX 生成与反读 | DOCX 生成 ok=true | ✔ PASS |
| 11 | DOCX 生成与反读 | DOCX MIME 正确 | ✔ PASS |
| 12 | DOCX 生成与反读 | 包含 [Content_Types].xml | ✔ PASS |
| 13 | DOCX 生成与反读 | 包含 word/document.xml | ✔ PASS |
| 14 | DOCX 生成与反读 | 反读包含中文标题 | ✔ PASS |
| 15 | DOCX 生成与反读 | 反读包含正文内容 | ✔ PASS |
| 16 | XLSX 生成与防注入 | XLSX 生成 ok=true | ✔ PASS |
| 17 | XLSX 生成与防注入 | 包含 sheet1.xml | ✔ PASS |
| 18 | XLSX 生成与防注入 | 工作表存在 | ✔ PASS |
| 19 | XLSX 生成与防注入 | 以 = 开头的公式被单引号转义 | ✔ PASS |
| 20 | XLSX 生成与防注入 | 以 + 开头的公式被单引号转义 | ✔ PASS |
| 21 | XLSX 生成与防注入 | 严禁生成 `<f>` 裸公式节点 | ✔ PASS |
| 22 | 参数与非法字符限制 | 含非法控制字符返回 ILLEGAL_CONTROL_CHARS | ✔ PASS |
| 23 | 参数与非法字符限制 | 不支持格式返回 DOC_FORMAT_UNSUPPORTED | ✔ PASS |
| 24 | 参数与非法字符限制 | 缺少 runId 返回 DOC_INPUT_INVALID | ✔ PASS |
| 25 | 参数与非法字符限制 | 产物体积超限返回 DOC_OUTPUT_LIMIT | ✔ PASS |
| 26 | 参数与非法字符限制 | 信号取消返回 DOC_CANCELLED | ✔ PASS |
| 27 | 跨包闭环验证 | 导出的 PDF 成功被 docinput 包识别解析 | ✔ PASS |
| 28 | 跨包闭环验证 | 双包传递 SHA256 完全对齐 | ✔ PASS |

## 实现说明

- **原生标准中文 PDF 生成**：
  - 基于 PDF 1.4 规范在内存中构造合法二进制流，包括 Catalog、Pages、Page、Contents、Font、xref 交叉引用表及 trailer
  - 使用标准中文字体声明与 UTF-16BE 十六进制字符流映射（`<FEFF...>`），彻底解决中文字符乱码，免外部重量级字体文件依赖
- **标准 DOCX 生成与反读**：
  - 构建严谨的 OpenXML 结构（`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`）
  - 支持多级标题与段落，经真实解包反读确认 XML 结构及中文内容完整无损
- **可移植 XLSX 与公式注入防御**：
  - 生成免 SheetJS 外部依赖的标准 OOXML 表格
  - 针对单元格字符串以 `=+\-@\t\r` 开头的潜在攻击向量，执行单引号安全转义（`'=`、`'+`），且严禁生成 `<f>` 裸公式节点
- **安全元数据与原子生成**：
  - 输出产物强制绑定 `runId`、`tenantId`、不可变 `artifactVersion` 及确定的 `sha256` 证据
  - 纯内存生成机制，杜绝生成过程中的残留半成品文件

## 文件 SHA256

```
305cd5951a9761e0d60275ed191adce2f32dcb9d8c6da097618c43b98838875a  shell/candidates/docoutput-20261103/CONTRACT.md
44e5f010d2671c93286062b85e85bc8fb257938e8c937ddf0c0671e89a4d9be2  shell/candidates/docoutput-20261103/index.cjs
8c462b4201d3108feeec3488f406b6a0a900889aeb7387bb74dde9910a345b2f  tests/probes/docoutput-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_HEADLESS_BROWSER_PDF`: 生产环境高保真 HTML-to-PDF / Puppeteer 渲染容器服务待生产专用渲染节点挂载。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (28/28 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载到文档产物输出导出环节。
