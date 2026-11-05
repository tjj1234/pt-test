# GEMINI-DOCINPUT-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/docinput-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**28/28 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | Magic Bytes 探测 | PDF magic 识别 | ✔ PASS |
| 2 | Magic Bytes 探测 | Legacy Office OLE magic 识别 | ✔ PASS |
| 3 | Magic Bytes 探测 | ZIP magic 识别 | ✔ PASS |
| 4 | Magic Bytes 探测 | 未知数据返回 null | ✔ PASS |
| 5 | 格式与输入安全 | 伪造 PDF 返回 DOC_FORMAT_UNSUPPORTED | ✔ PASS |
| 6 | 格式与输入安全 | 加密 PDF 拦截 ENCRYPTED_FILE_REJECTED | ✔ PASS |
| 7 | PDF 与 OCR 处理 | 文本 PDF 解析成功 ok=true | ✔ PASS |
| 8 | PDF 与 OCR 处理 | 识别页数为 2 | ✔ PASS |
| 9 | PDF 与 OCR 处理 | 提取页数完整 | ✔ PASS |
| 10 | PDF 与 OCR 处理 | inputSha256 计算精确 | ✔ PASS |
| 11 | PDF 与 OCR 处理 | 扫描件未启用 OCR 正常返回 | ✔ PASS |
| 12 | PDF 与 OCR 处理 | 扫描件文本为空 | ✔ PASS |
| 13 | PDF 与 OCR 处理 | 无 OCR 后端时 fail-closed 返回 OCR_UNAVAILABLE | ✔ PASS |
| 14 | PDF 与 OCR 处理 | OCR 挂载解析 ok=true | ✔ PASS |
| 15 | PDF 与 OCR 处理 | 标记 isOcr=true | ✔ PASS |
| 16 | PDF 与 OCR 处理 | OCR 提取文本正确 | ✔ PASS |
| 17 | 旧版 Office 处理 | 无转码器 fail-closed | ✔ PASS |
| 18 | 旧版 Office 处理 | 旧版 Office 转换解析 ok=true | ✔ PASS |
| 19 | 旧版 Office 处理 | 转码文本正确 | ✔ PASS |
| 20 | ZIP 安全与防护 | 正常 ZIP 解析 ok=true | ✔ PASS |
| 21 | ZIP 安全与防护 | 成功读取 2 个条目 | ✔ PASS |
| 22 | ZIP 安全与防护 | 包含 data.csv | ✔ PASS |
| 23 | ZIP 安全与防护 | ZIP inputSha256 精确 | ✔ PASS |
| 24 | ZIP 安全与防护 | 路径穿越被 ZIP_TRAVERSAL_REJECTED 阻断 | ✔ PASS |
| 25 | ZIP 安全与防护 | VBA 宏被 ZIP_ACTIVE_CONTENT_REJECTED 阻断 | ✔ PASS |
| 26 | ZIP 安全与防护 | 条目超限被 ZIP_ENTRY_LIMIT 阻断 | ✔ PASS |
| 27 | ZIP 安全与防护 | 展开字节超限被 ZIP_EXPANSION_LIMIT 阻断 | ✔ PASS |
| 28 | 生命周期控制 | 信号取消返回 DOC_CANCELLED | ✔ PASS |

## 实现说明

- **严格 Magic Bytes 二进制嗅探**：支持并区分 PDF、ZIP、以及旧版 Office OLE Compound 二进制文件（.doc/.xls/.ppt），格式伪造即刻拒绝
- **ZIP 流式解包与深度安全加固**：
  - 严密拦截目录穿越与相对路径穿越（`..`、绝对路径、Windows 盘符等）
  - 拦截 VBA 宏与脚本文件（`vbaProject.bin`, `.exe`, `.vbs`, `.ps1` 等）
  - 双重资源配额约束：`maxEntries`（条目上限）与 `maxExpandedBytes`（展开字节上限），杜绝压缩炸弹攻击
  - 每个文件条目单独生成精确 SHA256 签名
- **PDF 安全与 OCR 闭环**：
  - 拦截密码加密或防篡改保护的 PDF（`ENCRYPTED_FILE_REJECTED`）
  - 区分文本 PDF 与图片扫描件；扫描件在未指定 OCR 时安全置空，在请求 OCR 且无后端时明确 fail-closed，挂载后端时标记 `isOcr: true` 产出转写文本
- **旧版 Office Fail-Closed**：针对二进制 `.doc/.xls/.ppt`，在缺乏外部转码后端（如 headless LibreOffice）时明确返回错误码，不伪造成功状态

## 文件 SHA256

```
8e009ebd0f7c92d94e82161c339f71064caf81c2b7f2a6cf75fe2a69c4dd17bd  shell/candidates/docinput-20261103/CONTRACT.md
7a7d4da3192639cb62f1cd0bf36f38a9ea275a27e54ce11c0ab1bf5c3db514a9  shell/candidates/docinput-20261103/index.cjs
e8ea02298a90835f8469c51245e5017d57ccf3a4cfaa54bb27b1af5652b9710e  tests/probes/docinput-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_LEGACY_OFFICE_CONVERTER`: 生产环境 headless LibreOffice / unoconv 转码容器服务需系统级部署支持。
- `BLOCKED_OCR_ENGINE`: 生产环境 PaddleOCR / Tesseract 等中文 OCR 引擎需外部挂载。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (28/28 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载至文档解析流水线。
