"use strict";
/**
 * A1/A15 · 表格解析（CSV 内置；XLSX 可选依赖 `xlsx`）
 * A15：多 sheet 读取；多 sheet / 多文件按 (Ad ID|Campaign ID)+日期 join。
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

  const headerIdx = findHeaderRowIndex(rows);
  const headers = (rows[headerIdx] || []).map((h) => String(h).trim());
  const data = rows
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => String(c).trim() !== ""))
    .filter((r) => !isTotalOrNoiseRow(r));
  return { headers, rows: data, headerRowIndex: headerIdx };
}

function normCell(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ");
}

const HEADER_HINTS = [
  "impressions",
  "impr",
  "spend",
  "cost",
  "clicks",
  "campaign",
  "customer id",
  "reporting starts",
  "time period",
  "day",
  "date",
  "tweet id",
  "ad id",
  "amount spent",
];

function looksLikeHeaderRow(row) {
  const norms = (row || []).map(normCell).filter(Boolean);
  if (norms.length < 2) return false;
  let hits = 0;
  for (const n of norms) {
    if (HEADER_HINTS.some((h) => n === h || n.includes(h) || h.includes(n))) hits += 1;
  }
  return hits >= 2;
}

function findHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    if (looksLikeHeaderRow(rows[i])) return i;
  }
  return 0;
}

function isTotalOrNoiseRow(row) {
  const first = String((row && row[0]) || "")
    .trim()
    .toLowerCase();
  return first === "total" || first === "总计" || first.startsWith("total ");
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

function matrixToTable(matrix, sheetName) {
  if (!matrix.length) throw new Error("表格为空" + (sheetName ? `: ${sheetName}` : ""));
  const headerIdx = findHeaderRowIndex(matrix);
  const headers = (matrix[headerIdx] || []).map((h) => String(h == null ? "" : h).trim());
  if (!headers.some((h) => h)) throw new Error("无法解析表头" + (sheetName ? `: ${sheetName}` : ""));
  const data = matrix
    .slice(headerIdx + 1)
    .filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? "" : c).trim() !== ""))
    .filter((r) => !isTotalOrNoiseRow(r))
    .map((r) => headers.map((_, i) => (r[i] == null ? "" : String(r[i]))));
  return { name: sheetName || "Sheet1", headers, rows: data, headerRowIndex: headerIdx };
}

function parseXlsxAllSheets(buffer) {
  let XLSX;
  try {
    XLSX = require("xlsx");
  } catch {
    throw Object.assign(new Error("未安装 xlsx，无法解析 Excel；请导出 CSV 或 npm i xlsx"), {
      code: "XLSX_MISSING",
    });
  }
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  if (!wb.SheetNames || !wb.SheetNames.length) throw new Error("Excel 没有工作表");
  const sheets = [];
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: "",
    });
    if (!matrix.length) continue;
    try {
      sheets.push(matrixToTable(matrix, sheetName));
    } catch {
      /* skip bad sheet */
    }
  }
  if (!sheets.length) throw new Error("Excel 无可解析工作表");
  return { sheets };
}

function parseXlsx(buffer) {
  const all = parseXlsxAllSheets(buffer);
  const first = all.sheets[0];
  return { headers: first.headers, rows: first.rows, sheets: all.sheets };
}

/**
 * 识别 join 键列：优先 Ad ID / Tweet ID，其次 Campaign ID。
 */
function detectJoinColumns(headers) {
  const norms = headers.map((h) => ({ raw: h, n: normCell(h) }));
  const find = (...preds) => {
    for (const p of preds) {
      const hit = norms.find((x) => p(x.n));
      if (hit) return hit.raw;
    }
    return null;
  };
  const adCol = find(
    (n) => n === "ad id" || n === "ad_id",
    (n) => n === "tweet id" || n === "tweet_id",
    (n) => n === "creative id" || n === "creative_id",
    (n) => n.includes("ad id")
  );
  const campCol = find(
    (n) => n === "campaign id" || n === "campaign_id",
    (n) => n.includes("campaign id")
  );
  const dateCol = find(
    (n) => n === "date" || n === "day" || n === "time period",
    (n) => n === "reporting starts" || n === "reporting start",
    (n) => n.includes("date") && !n.includes("update")
  );
  if (adCol && dateCol) return { entityCol: adCol, dateCol, kind: "ad" };
  if (campCol && dateCol) return { entityCol: campCol, dateCol, kind: "campaign" };
  return {
    entityCol: adCol || campCol,
    dateCol,
    kind: adCol ? "ad" : campCol ? "campaign" : null,
  };
}

function rowToObject(headers, row) {
  const o = {};
  headers.forEach((h, i) => {
    o[h] = row[i] !== undefined ? row[i] : "";
  });
  return o;
}

function joinKeyFromObj(obj, entityCol, dateCol) {
  const e = String(obj[entityCol] || "")
    .trim()
    .toLowerCase();
  const d = String(obj[dateCol] || "")
    .trim()
    .slice(0, 32);
  if (!e || !d) return null;
  return `${e}\u0000${d}`;
}

/**
 * 主表 left-join 补充表（Location / 国家拆分），键为 (Ad|Campaign ID)+日期。
 * 补充表仅合并主表没有的新列（如 Country）；主表指标列优先。
 */
function joinTables(primary, supplement) {
  if (!primary || !supplement) {
    throw Object.assign(new Error("join 需要 primary 与 supplement 两张表"), {
      code: "JOIN_REQUIRED",
    });
  }
  const pk = detectJoinColumns(primary.headers);
  const sk = detectJoinColumns(supplement.headers);
  const entityColP = pk.entityCol;
  const entityColS = sk.entityCol;
  const dateColP = pk.dateCol;
  const dateColS = sk.dateCol;
  if (!entityColP || !entityColS || !dateColP || !dateColS) {
    throw Object.assign(
      new Error("无法 join：两侧需同时具备 (Ad ID 或 Campaign ID) 与日期列"),
      { code: "JOIN_KEYS_MISSING" }
    );
  }

  const suppIndex = new Map();
  for (const row of supplement.rows) {
    const obj = rowToObject(supplement.headers, row);
    const key = joinKeyFromObj(obj, entityColS, dateColS);
    if (!key) continue;
    if (!suppIndex.has(key)) suppIndex.set(key, []);
    suppIndex.get(key).push(obj);
  }

  const extraHeaders = supplement.headers.filter(
    (h) =>
      h !== entityColS &&
      h !== dateColS &&
      !primary.headers.some((ph) => normCell(ph) === normCell(h))
  );
  const headers = [...primary.headers, ...extraHeaders];
  const rows = [];
  let matched = 0;
  let unmatched = 0;

  for (const row of primary.rows) {
    const obj = rowToObject(primary.headers, row);
    const key = joinKeyFromObj(obj, entityColP, dateColP);
    const hits = key ? suppIndex.get(key) || [] : [];
    if (!hits.length) {
      unmatched += 1;
      const merged = primary.headers.map((h) => obj[h] ?? "");
      for (let i = 0; i < extraHeaders.length; i++) merged.push("");
      rows.push(merged);
      continue;
    }
    matched += 1;
    for (const hit of hits) {
      const merged = primary.headers.map((h) => obj[h] ?? "");
      for (const h of extraHeaders) merged.push(hit[h] ?? "");
      rows.push(merged);
    }
  }

  return {
    headers,
    rows,
    join: {
      kind: pk.kind || sk.kind,
      entityColPrimary: entityColP,
      entityColSupplement: entityColS,
      dateColPrimary: dateColP,
      dateColSupplement: dateColS,
      matched,
      unmatched,
      supplementRows: supplement.rows.length,
      explodedRows: rows.length,
    },
  };
}

function pickPrimaryAndLocation(sheets) {
  if (!sheets || sheets.length === 0) return null;
  if (sheets.length === 1) return { primary: sheets[0], supplement: null };
  const loc = sheets.find((s) => /location|country|geo|国家|地区/i.test(String(s.name || "")));
  const primary =
    sheets.find((s) => /result|metric|campaign|ad |report|数据|投放/i.test(String(s.name || ""))) ||
    sheets.find((s) => s !== loc) ||
    sheets[0];
  const supplement = loc && loc !== primary ? loc : sheets.find((s) => s !== primary) || null;
  return { primary, supplement };
}

function parseTabular(buffer, filename, opts = {}) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ""), "utf8");
  const kind = fileKind(filename, raw);
  const autoJoin = opts.autoJoin !== false;

  if (kind === "xlsx" || kind === "xls") {
    const { sheets } = parseXlsxAllSheets(raw);
    const picked = pickPrimaryAndLocation(sheets);
    if (autoJoin && picked.supplement) {
      const joined = joinTables(picked.primary, picked.supplement);
      return {
        kind,
        headers: joined.headers,
        rows: joined.rows,
        sheets,
        join: joined.join,
        primarySheet: picked.primary.name,
        supplementSheet: picked.supplement.name,
      };
    }
    const first = picked.primary || sheets[0];
    return {
      kind,
      headers: first.headers,
      rows: first.rows,
      sheets,
      join: null,
      primarySheet: first.name,
      supplementSheet: null,
    };
  }

  const csv = parseCsv(raw.toString("utf8"));
  return {
    kind: "csv",
    headers: csv.headers,
    rows: csv.rows,
    sheets: [{ name: "csv", headers: csv.headers, rows: csv.rows }],
    join: null,
    primarySheet: "csv",
    supplementSheet: null,
  };
}

function tabularFromInput(input) {
  if (!input) throw new Error("tabular input 必填");
  if (input.headers && input.rows) {
    return { name: input.name || "table", headers: input.headers, rows: input.rows };
  }
  const parsed = parseTabular(input.buffer, input.filename, { autoJoin: false });
  if (parsed.sheets && parsed.sheets.length > 1) {
    const picked = pickPrimaryAndLocation(parsed.sheets);
    return picked.primary;
  }
  return {
    name: parsed.primarySheet || "table",
    headers: parsed.headers,
    rows: parsed.rows,
  };
}

/** 一次导入两份文件：同一套 join 逻辑（Google 双 CSV / X 双 sheet 通用）。 */
function parseAndJoin(primaryInput, supplementInput) {
  const primary = tabularFromInput(primaryInput);
  const supplement = tabularFromInput(supplementInput);
  const joined = joinTables(primary, supplement);
  const kindP = primaryInput && primaryInput.filename ? fileKind(primaryInput.filename) : "csv";
  const kindS =
    supplementInput && supplementInput.filename ? fileKind(supplementInput.filename) : "csv";
  const kind = kindP === "xlsx" || kindS === "xlsx" || kindP === "xls" || kindS === "xls" ? "xlsx" : "csv";
  return {
    kind,
    headers: joined.headers,
    rows: joined.rows,
    sheets: [primary, supplement],
    join: joined.join,
    primarySheet: primary.name || "primary",
    supplementSheet: supplement.name || "supplement",
  };
}

module.exports = {
  parseCsv,
  parseXlsx,
  parseXlsxAllSheets,
  parseTabular,
  parseAndJoin,
  joinTables,
  detectJoinColumns,
  pickPrimaryAndLocation,
  fileKind,
  findHeaderRowIndex,
};
