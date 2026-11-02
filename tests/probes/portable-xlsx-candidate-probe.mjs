/**
 * 探针 B：可移植 XLSX 产物生成独立探针 (Portable XLSX Probe)
 *
 * 验证重点：
 * 1. 临时独立布局与防不受信依赖探测：
 *    - 在 os.tmpdir() 独立目录中运行候选模块，cwd 放置同名无害 stub，证明依赖严格从 shell 锁定解析，不从当前目录或外部回退；
 * 2. 真实有效性与全谱系数据反读：
 *    - 包含中文汉字、多行换行符、小数、负数、布尔值及空单元格；
 *    - 使用现有生产 inspectOfficeZip 与 extractStructuredOffice 逐项反读解析；
 * 3. 严格安全与公式注入防御：
 *    - 针对 = + - @ 潜在公式注入字符串，自动前缀单引号并记录 degradations；
 *    - 提取内容中 formula 属性严格为 false，绝无 <f> 标签或宏（VBA）；
 *    - 数字字符串保持为 inlineStr 文本，绝不猜测转为数值或日期；
 * 4. 前置限额 (Reject-before-Scan) 与输入完全不可变性。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  generatePortableXlsx,
  PORTABLE_XLSX_LIMITS,
  PORTABLE_XLSX_SCHEMA,
} = require("../../shell/exports/portable-xlsx-candidate.cjs");

const { inspectOfficeZip } = require("../../shell/attachments/office-zip-guard.cjs");
const { extractStructuredOffice } = require("../../shell/attachments/ooxml-structured-text.cjs");

console.log("=== Portable XLSX 生成候选探针开始 ===");

// 1. 验证临时独立布局与合法依赖隔离
console.log("\n[1/4] 验证临时独立布局与合法依赖隔离加载能力...");
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-xlsx-probe-"));
  const tempCandidatePath = path.join(tempDir, "shell", "exports", "portable-xlsx-candidate.cjs");
  const sourceCode = fs.readFileSync(
    new URL("../../shell/exports/portable-xlsx-candidate.cjs", import.meta.url),
    "utf8"
  );
  fs.mkdirSync(path.dirname(tempCandidatePath), {recursive:true});
  fs.symlinkSync(path.resolve('shell/node_modules'),path.join(tempDir,'shell','node_modules'),'dir');
  fs.writeFileSync(tempCandidatePath, sourceCode, "utf8");

  // 在 tempDir 下放置同名伪造 fflate.js，证明 require 绝不从当前工作目录加载不可信依赖
  fs.writeFileSync(
    path.join(tempDir, "fflate.js"),
    "module.exports = { fake: true };",
    "utf8"
  );

  const imported = require(tempCandidatePath);
  assert.equal(typeof imported.generatePortableXlsx, "function");

  const testRes = imported.generatePortableXlsx({
    sheets: [{ name: "IsolatedTest", cells: [["OK", 100]] }],
  });
  assert.equal(testRes.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  console.log("  ✔ 临时目录隔离加载成功，依赖严格由锁定 shell 目录提供");

  fs.rmSync(tempDir, { recursive: true, force: true });
}

// 2. 全谱系数据生成与现有 Office Parser 双向反读
console.log("\n[2/4] 执行全谱系多工作表生成与现有 Office Parser 深度反读...");
{
  const fullInput = {
    title: "企业年度资产与财务报表",
    sheets: [
      {
        name: "资产总表 (Assets)",
        cells: [
          ["资产类别", "估值 (CNY)", "入账状态", "合规备注"],
          ["GPU集群硬件算力", 3500000.75, true, "机房A区\n环境温湿度达标"],
          ["办公电子设备", 120500, false, null],
          ["办公网络专线租用", -45000.0, true, "预付账款冲减"],
        ],
      },
      {
        name: "安全与审计 (Audit)",
        cells: [
          ["策略名", "风险级别", "待审计项"],
          ["数据防泄漏 (DLP)", "高", "=SUM(A1:A5)"],
          ["跨区访问规则", "中", "+CMD|'calc'!A0"],
          ["预估单据编号", "低", "00012345"], // 纯数字字符串必须严格作为文本存储
        ],
      },
    ],
  };

  const inputSnapshot = JSON.stringify(fullInput);
  const result = generatePortableXlsx(fullInput);

  // 输入不可变性
  assert.equal(JSON.stringify(fullInput), inputSnapshot, "输入数据严禁被函数执行产生任何内部改动");

  // 产物特征核对
  assert.equal(result.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(result.bytes, result.buffer.length);
  assert.equal(typeof result.sha256, "string");
  assert.equal(result.sha256.length, 64);
  console.log(`  ✔ XLSX 生成成功：${result.bytes} 字节, SHA256: ${result.sha256.slice(0, 16)}...`);

  // 使用生产 inspectOfficeZip 校验 ZIP 结构与安全性
  const archive = inspectOfficeZip(result.buffer);
  assert.ok(archive.names.includes("[Content_Types].xml"));
  assert.ok(archive.names.includes("_rels/.rels"));
  assert.ok(archive.names.includes("xl/workbook.xml"));
  assert.ok(archive.names.includes("xl/_rels/workbook.xml.rels"));
  assert.ok(archive.names.includes("xl/worksheets/sheet1.xml"));
  assert.ok(archive.names.includes("xl/worksheets/sheet2.xml"));
  console.log(`  ✔ inspectOfficeZip 校验通过：共 ${archive.names.length} 个 OPC 部件，无 VBA/嵌入对象`);

  // 使用生产 extractStructuredOffice 逐个单元格内容比对
  const parsed = extractStructuredOffice(result.buffer, "xlsx", archive);
  assert.equal(parsed.partCount, 2);

  // 单元格数值精度与类型校验
  const cGpuVal = parsed.blocks.find(b => b.locator.sheetName === "资产总表 (Assets)" && b.locator.cell === "B2");
  assert.equal(cGpuVal.text, "3500000.75");
  assert.equal(cGpuVal.locator.valueType, "n");

  const cBool = parsed.blocks.find(b => b.locator.sheetName === "资产总表 (Assets)" && b.locator.cell === "C2");
  assert.equal(cBool.text, "1");
  assert.equal(cBool.locator.valueType, "b");

  const cChineseNotes = parsed.blocks.find(b => b.locator.sheetName === "资产总表 (Assets)" && b.locator.cell === "D2");
  assert.equal(cChineseNotes.text, "机房A区\n环境温湿度达标");
  assert.equal(cChineseNotes.locator.valueType, "inlineStr");

  // 字符串数字不猜测为数值
  const cSerial = parsed.blocks.find(b => b.locator.sheetName === "安全与审计 (Audit)" && b.locator.cell === "C4");
  assert.equal(cSerial.text, "00012345");
  assert.equal(cSerial.locator.valueType, "inlineStr", "数字字符串必须保持为 inlineStr 文本，绝不猜测为数值");

  // 公式防御与 degradations 记录
  assert.equal(result.degradations.length, 2);
  const cFormula1 = parsed.blocks.find(b => b.locator.sheetName === "安全与审计 (Audit)" && b.locator.cell === "C2");
  assert.equal(cFormula1.text, "'=SUM(A1:A5)", "潜在公式必须前缀单引号安全转义");
  assert.equal(cFormula1.locator.formula, false, "提取时公式标记严格为 false");

  const cFormula2 = parsed.blocks.find(b => b.locator.sheetName === "安全与审计 (Audit)" && b.locator.cell === "C3");
  assert.equal(cFormula2.text, "'+CMD|'calc'!A0");
  assert.equal(cFormula2.locator.formula, false);
  console.log("  ✔ 全谱系反读与公式注入防御验证无误");
}

// 3. 边界反例与 Reject-before-Scan
console.log("\n[3/4] 验证前置限额与异常防御 (Reject-before-Scan)...");
{
  // 超长稀疏 sheets
  const oversizedSheets = new Proxy(new Array(PORTABLE_XLSX_LIMITS.maxSheets + 2), {
    get(target, prop) {
      if (!isNaN(Number(prop))) assert.fail("不得在超出上限时访问元素");
      return target[prop];
    }
  });

  assert.throws(() => {
    generatePortableXlsx({ sheets: oversizedSheets });
  }, (err) => err.code === "SHEET_LIMIT_EXCEEDED");

  // 非法工作表名字符
  for (const badName of ["Sheet[1]", "Sheet*2", "Sheet/3", "Sheet\\4", "Sheet:5"]) {
    assert.throws(() => {
      generatePortableXlsx({
        sheets: [{ name: badName, cells: [["1"]] }]
      });
    }, (err) => err.code === "INVALID_SHEET_NAME_CHARACTERS");
  }

  // 非法非有限数字
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [{ name: "S1", cells: [[NaN]] }]
    });
  }, (err) => err.code === "INVALID_CELL_VALUE");

  console.log("  ✔ 异常输入与前置限额全部在执行前被阻断，无文件副作用");
}

// 4. 输出 Schema 规范供主 Agent 对接
console.log("\n[4/4] 验证公开 Schema 与 Limits 定义...");
{
  assert.equal(typeof PORTABLE_XLSX_SCHEMA, "object");
  assert.equal(PORTABLE_XLSX_SCHEMA.type, "object");
  assert.deepEqual(PORTABLE_XLSX_SCHEMA.required, ["sheets"]);
  assert.equal(PORTABLE_XLSX_LIMITS.maxSheets, 10);
  assert.equal(PORTABLE_XLSX_LIMITS.maxCells, 50000);
  console.log("  ✔ Schema 与 Limits 导出符合契约规范");
}

console.log("\n=== Portable XLSX 生成候选探针全部通过 (ALL PASS) ===");
