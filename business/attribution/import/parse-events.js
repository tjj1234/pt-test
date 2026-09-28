"use strict";
/**
 * A18 · 事件导出文件 → 原始事件行（结构校验）
 * 事件名映射 / 三件套补齐交给 A17；本模块只做表格解析 + 必填列 + event_time/user_id。
 */
const { parseTabular } = require("../parsers/tabular");
const {
  suggestEventMapping,
  EVENT_REQUIRED_MAP,
  rowToRawEvent,
} = require("./event-field-mapping");

function parseEventExportFile(input) {
  const workspaceId = input && input.workspaceId;
  if (!workspaceId || typeof workspaceId !== "string") {
    throw Object.assign(new Error("workspaceId 必须来自 AttributionContext"), {
      code: "CONTEXT_REQUIRED",
    });
  }
  if (!input.sourceFileId) {
    throw Object.assign(new Error("sourceFileId 必填"), { code: "SOURCE_FILE_REQUIRED" });
  }

  const tabular = parseTabular(input.buffer, input.filename, { autoJoin: false });
  const { headers, rows, kind } = tabular;
  const suggested = suggestEventMapping(headers);
  const mapping = input.mapping || suggested.mapping;

  const missing = EVENT_REQUIRED_MAP.filter((f) => !mapping[f] || !mapping[f].column);
  if (missing.length) {
    return {
      ok: false,
      code: "MAPPING_INCOMPLETE",
      headers,
      mapping,
      mappingAudit: suggested.audit,
      missingRequired: missing,
      records: [],
      errors: missing.map((f) => ({
        sourceRowNumber: 1,
        field: f,
        reason: `必填列未映射: ${f}`,
      })),
      rowCount: rows.length,
      successRows: 0,
      failedRows: missing.length,
    };
  }

  const records = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowObj = {};
    headers.forEach((h, idx) => {
      rowObj[h] = rows[i][idx] !== undefined ? rows[i][idx] : "";
    });
    const sourceRowNumber = i + 2;
    const result = rowToRawEvent(rowObj, mapping, {
      sourceRowNumber,
      sourceFileId: input.sourceFileId,
    });
    if (!result.ok) {
      errors.push({
        sourceRowNumber,
        field: result.field || null,
        reason: result.reason,
      });
      continue;
    }
    records.push({
      sourceRowNumber,
      raw: result.raw,
    });
  }

  const ok = records.length > 0 && errors.length === 0;
  const partial = records.length > 0 && errors.length > 0;
  return {
    ok: ok || partial,
    partial,
    code: ok ? "OK" : partial ? "PARTIAL" : "FAILED",
    headers,
    mapping,
    mappingAudit: suggested.audit,
    rawSource: kind === "csv" ? "csv_export" : "xlsx_export",
    rowCount: rows.length,
    successRows: records.length,
    failedRows: errors.length,
    records,
    errors,
  };
}

module.exports = { parseEventExportFile };
