"use strict";
/**
 * A1/A15 · 导出文件 → CanonicalAdRecord[]
 * workspaceId 必须由调用方从 AttributionContext 注入；本模块不读客户端租户。
 * A15：多 sheet / 双文件 join；(无 Ad 列时 Google creativeName 标「系列级近似」)。
 */
const { parseTabular, parseAndJoin } = require("./tabular");
const {
  suggestMapping,
  detectProvider,
  currencyFromHeaders,
  REQUIRED_MAP,
  SOURCE_VERSION,
  rowToCanonical,
} = require("./mapping");
const { assertCanonicalAd } = require("../contracts/validate");

function extractDefaultDate(buffer, filename) {
  try {
    const kind = String(filename || "").toLowerCase();
    if (kind.endsWith(".xlsx") || kind.endsWith(".xls")) return null;
    const text = Buffer.isBuffer(buffer)
      ? buffer.toString("utf8")
      : String(buffer || "");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 8);
    for (const line of lines) {
      const s = line.replace(/^"|"$/g, "").trim();
      const range = /^([A-Za-z]+ \d{1,2}, \d{4})\s*-\s*([A-Za-z]+ \d{1,2}, \d{4})$/.exec(s);
      if (range) {
        const d = parseEnglishDate(range[1]);
        if (d) return d;
      }
      const one = parseEnglishDate(s);
      if (one) return one;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseEnglishDate(s) {
  const m = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/i.exec(
    String(s || "").trim()
  );
  if (!m) return null;
  const months = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const mm = months[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}

function parseExportFile(input) {
  const workspaceId = input && input.workspaceId;
  if (!workspaceId || typeof workspaceId !== "string") {
    throw Object.assign(new Error("workspaceId 必须来自 AttributionContext"), {
      code: "CONTEXT_REQUIRED",
    });
  }
  if (!input.sourceFileId) {
    throw Object.assign(new Error("sourceFileId 必填"), { code: "SOURCE_FILE_REQUIRED" });
  }

  let tabular;
  if (input.buffer2) {
    tabular = parseAndJoin(
      { buffer: input.buffer, filename: input.filename },
      { buffer: input.buffer2, filename: input.filename2 || input.filename }
    );
  } else {
    tabular = parseTabular(input.buffer, input.filename, { autoJoin: true });
  }

  const { headers, rows, kind, join } = tabular;
  const provider = detectProvider(headers, input.provider);
  const suggested = suggestMapping(headers);
  const mapping = input.mapping || suggested.mapping;
  const defaultDate =
    input.defaultDate || extractDefaultDate(input.buffer, input.filename) || null;
  const missing = REQUIRED_MAP.filter((f) => {
    if (f === "date" && defaultDate) return false;
    return !mapping[f] || !mapping[f].column;
  });
  if (missing.length) {
    return {
      ok: false,
      code: "MAPPING_INCOMPLETE",
      provider,
      headers,
      mapping,
      mappingAudit: suggested.audit,
      missingRequired: missing,
      records: [],
      errors: missing.map((f) => ({ sourceRowNumber: 1, field: f, reason: `必填列未映射: ${f}` })),
      join: join || null,
    };
  }

  const defaultCurrency = currencyFromHeaders(headers, mapping) || "USD";
  const rawSource = kind === "csv" ? "csv_export" : "xlsx_export";
  const importedAt = input.importedAt || new Date().toISOString();
  const sourceVersion = input.sourceVersion || SOURCE_VERSION;

  const records = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowObj = {};
    headers.forEach((h, idx) => {
      rowObj[h] = rows[i][idx] !== undefined ? rows[i][idx] : "";
    });
    const sourceRowNumber = i + 2;
    const result = rowToCanonical(rowObj, mapping, {
      workspaceId,
      provider,
      sourceFileId: input.sourceFileId,
      sourceRowNumber,
      rawSource,
      importedAt,
      sourceVersion,
      defaultCurrency,
      defaultDate,
    });
    if (!result.ok) {
      errors.push({
        sourceRowNumber,
        field: result.field || null,
        reason: result.reason,
      });
      continue;
    }
    const shapeErrors = assertCanonicalAd(result.record, []);
    if (shapeErrors.length) {
      errors.push({
        sourceRowNumber,
        field: null,
        reason: shapeErrors.join("; "),
      });
      continue;
    }
    records.push(result.record);
  }

  const ok = records.length > 0 && errors.length === 0;
  const partial = records.length > 0 && errors.length > 0;
  return {
    ok: ok || partial,
    partial,
    code: ok ? "OK" : partial ? "PARTIAL" : "FAILED",
    provider,
    headers,
    mapping,
    mappingAudit: suggested.audit,
    rawSource,
    rowCount: rows.length,
    successRows: records.length,
    failedRows: errors.length,
    records,
    errors,
    join: join || null,
    defaultDate,
  };
}

function parseGoogleExport(input) {
  return parseExportFile({ ...input, provider: "google" });
}
function parseMetaExport(input) {
  return parseExportFile({ ...input, provider: "meta" });
}
function parseXExport(input) {
  return parseExportFile({ ...input, provider: "x" });
}

module.exports = {
  parseExportFile,
  parseGoogleExport,
  parseMetaExport,
  parseXExport,
  extractDefaultDate,
};
