"use strict";
/**
 * A1 · 表格解析（CSV 内置；XLSX 可选依赖 `xlsx`，未安装时仅支持 CSV）
 */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const s = String(text || "").replace(/^\uFEFF/, "");
  while (i < s.length) {
    const row = [];
    while (i < s.length) {
      let cell = "";
      if (s[i] === '"') {
        i += 1;
        while (i < s.length) {
          if (s[i] === '"') {
            if (s[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          cell += s[i++];
        }
      } else {
        while (i < s.length && s[i] !== "," && s[i] !== "\n" && s[i] !== "\r") {
          cell += s[i++];
        }
      }
      row.push(cell);
      if (s[i] === ",") {
        i += 1;
        continue;
      }
      if (s[i] === "\r") i += 1;
      if (s[i] === "\n") {
        i += 1;
        break;
      }
      break;
    }
    if (row.length === 1 && row[0] === "" && i >= s.length) break;
    rows.push(row);
  }
  if (rows.length === 0) throw new Error("CSV 为空");
  const headers = rows[0].map((h) => String(h).trim());
  const data = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
  return { headers, rows: data };
}

function fileKind(filename, buffer) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".xls")) return "xls";
  if (
    buffer &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return "xlsx";
  }
  return "csv";
}

function parseXlsx(buffer) {
  let XLSX;
  try {
    XLSX = require("xlsx");
  } catch {
    throw Object.assign(new Error("未安装 xlsx，无法解析 Excel；请导出 CSV 或 npm i xlsx"), {
      code: "XLSX_MISSING",
    });
  }
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = wb.SheetNames && wb.SheetNames[0];
  if (!sheetName) throw new Error("Excel 没有工作表");
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
  });
  if (!matrix.length) throw new Error("Excel 为空");
  const headers = (matrix[0] || []).map((h) => String(h == null ? "" : h).trim());
  if (!headers.some((h) => h)) throw new Error("无法解析表头");
  const data = matrix
    .slice(1)
    .filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? "" : c).trim() !== ""))
    .map((r) => headers.map((_, i) => (r[i] == null ? "" : String(r[i]))));
  return { headers, rows: data };
}

function parseTabular(buffer, filename) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ""), "utf8");
  const kind = fileKind(filename, raw);
  if (kind === "xlsx" || kind === "xls") return { kind, ...parseXlsx(raw) };
  return { kind: "csv", ...parseCsv(raw.toString("utf8")) };
}

module.exports = { parseCsv, parseXlsx, parseTabular, fileKind };
