"use strict";
/**
 * A1 · 导出文件 → CanonicalAdRecord[]
 * workspaceId 必须由调用方从 AttributionContext 注入；本模块不读客户端租户。
 */
const { parseTabular } = require("./tabular");
const {
  suggestMapping,
  detectProvider,
  currencyFromHeaders,
  REQUIRED_MAP,
  rowToCanonical,
} = require("./mapping");
const { assertCanonicalAd } = require("../contracts/validate");

/**
 * @param {object} input
 * @param {Buffer|string} input.buffer
 * @param {string} [input.filename]
 * @param {string} input.workspaceId — AttributionContext.workspaceId
 * @param {"google"|"meta"|"x"} [input.provider]
 * @param {string} input.sourceFileId
 * @param {object} [input.mapping] — 覆盖建议映射
 * @param {string} [input.importedAt]
 * @param {string} [input.sourceVersion]
 */
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

  const { headers, rows, kind } = parseTabular(input.buffer, input.filename);
  const provider = detectProvider(headers, input.provider);
  const suggested = suggestMapping(headers);
  const mapping = input.mapping || suggested.mapping;
  const missing = REQUIRED_MAP.filter((f) => !mapping[f] || !mapping[f].column);
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
    };
  }

  const defaultCurrency = currencyFromHeaders(headers, mapping) || "USD";
  const rawSource = kind === "csv" ? "csv_export" : "xlsx_export";
  const importedAt = input.importedAt || new Date().toISOString();
  const sourceVersion = input.sourceVersion || "a1.0";

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
};
