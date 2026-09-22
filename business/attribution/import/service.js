"use strict";
/**
 * A9 · 导入状态机：pending → validating → ready → importing → completed|partial_failed|failed
 * 复用 A1 parsers；tenant/workspace 只认 Context。
 * confirm 落库：CanonicalAdRecord → upsertDailyMetric → ad_performance_daily。
 */
const { parseExportFile } = require("../parsers");
const { PROVIDERS } = require("../contracts/validate");
const { createImportStore } = require("./store");
const { toDailyMetricRow } = require("./toDailyMetricRow");
const { upsertDailyMetric: defaultUpsertDailyMetric } = require("../../../analytics/backend/ads/ingest");

const TERMINAL = new Set(["completed", "partial_failed", "failed", "cancelled"]);

function publicJob(job) {
  if (!job) return null;
  const {
    tenantId,
    records,
    fileAbs,
    ...rest
  } = job;
  return rest;
}

function fileExt(name, kind) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".xlsx")) return ".xlsx";
  if (n.endsWith(".xls")) return ".xls";
  if (n.endsWith(".csv")) return ".csv";
  if (kind === "xlsx") return ".xlsx";
  return ".csv";
}

async function persistRecords(pool, records, upsertFn) {
  if (!pool || typeof pool.connect !== "function") {
    throw Object.assign(new Error("导入落库需要 pool（query + connect）"), {
      code: "POOL_REQUIRED",
    });
  }
  const upsert = upsertFn || defaultUpsertDailyMetric;
  const client = await pool.connect();
  const persistErrors = [];
  let persisted = 0;
  try {
    for (const rec of records) {
      try {
        const row = toDailyMetricRow(rec);
        await upsert(client, row);
        persisted += 1;
      } catch (err) {
        persistErrors.push({
          sourceRowNumber: rec && rec.sourceRowNumber,
          message: err && err.message ? err.message : String(err),
        });
      }
    }
  } finally {
    client.release();
  }
  return { persisted, persistErrors };
}

function createImportService(opts = {}) {
  const store = opts.store || createImportStore(opts);
  const pool = opts.pool || null;
  const upsertDailyMetric = opts.upsertDailyMetric || defaultUpsertDailyMetric;

  async function createAndValidate(context, input) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const provider = String(input.provider || "").toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      throw Object.assign(new Error("provider 需为 google|meta|x"), { code: "BAD_PROVIDER" });
    }
    const buf = Buffer.isBuffer(input.buffer)
      ? input.buffer
      : Buffer.from(String(input.contentBase64 || ""), "base64");
    if (!buf.length) {
      throw Object.assign(new Error("文件为空"), { code: "EMPTY_FILE" });
    }
    if (buf.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error("文件超过 20MB"), { code: "TOO_LARGE" });
    }

    const { importId, sourceFileId } = store.newIds();
    const now = new Date().toISOString();
    const originalName = input.originalName || "upload.csv";
    const ext = fileExt(originalName);
    const abs = store.saveFile(context.tenantId, sourceFileId, buf, ext);

    const job = store.createJob({
      importId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      provider,
      status: "pending",
      sourceFileId,
      originalName,
      idempotencyKey: input.idempotencyKey || null,
      headers: null,
      sampleRows: null,
      mapping: null,
      mappingAudit: null,
      rowCount: null,
      successRows: null,
      failedRows: null,
      errorMessage: null,
      errorDetails: null,
      dateRange: null,
      currencySeen: [],
      createdBy: context.actorId || null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      fileAbs: abs,
      records: null,
    });

    store.updateJob(context.tenantId, importId, { status: "validating" });

    try {
      const parsed = parseExportFile({
        buffer: buf,
        filename: originalName,
        workspaceId: context.workspaceId,
        provider,
        sourceFileId,
        mapping: input.mapping || undefined,
        importedAt: now,
      });

      if (parsed.code === "MAPPING_INCOMPLETE") {
        return publicJob(
          store.updateJob(context.tenantId, importId, {
            status: "ready",
            headers: parsed.headers,
            sampleRows: (parsed.headers && parsed.headers.length
              ? []
              : null),
            mapping: parsed.mapping,
            mappingAudit: parsed.mappingAudit,
            rowCount: 0,
            errorMessage: "必填列未映射，请补 mapping 后 confirm",
            errorDetails: parsed.errors,
          })
        );
      }

      // 预览：先 ready，等 confirm 再 importing（即使已能解析成功）
      const sampleRows = [];
      // re-parse headers for sample via tabular inside parse result
      const dates = (parsed.records || []).map((r) => r.date).filter(Boolean).sort();
      const currencies = [
        ...new Set((parsed.records || []).map((r) => r.currency).filter(Boolean)),
      ];

      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "ready",
          headers: parsed.headers,
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          rowCount: parsed.rowCount,
          sampleRows: sampleRows,
          dateRange:
            dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
          currencySeen: currencies,
          errorMessage: null,
          errorDetails: parsed.errors && parsed.errors.length ? parsed.errors : null,
          _previewOk: parsed.ok,
          _previewPartial: parsed.partial,
        })
      );
    } catch (err) {
      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "failed",
          errorMessage: err && err.message ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        })
      );
    }
  }

  async function confirmImport(context, importId, mappingPatch) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const job = store.getJob(context.tenantId, importId);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return publicJob(job);
    if (job.status !== "ready" && job.status !== "pending" && job.status !== "validating") {
      throw Object.assign(new Error("当前状态不可确认导入: " + job.status), {
        code: "BAD_STATUS",
      });
    }

    store.updateJob(context.tenantId, importId, { status: "importing" });
    const file = store.readFile(context.tenantId, job.sourceFileId);
    if (!file) {
      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "failed",
          errorMessage: "原文件缺失",
          finishedAt: new Date().toISOString(),
        })
      );
    }

    const mapping = mappingPatch || job.mapping || undefined;
    const parsed = parseExportFile({
      buffer: file.buffer,
      filename: job.originalName,
      workspaceId: context.workspaceId,
      provider: job.provider,
      sourceFileId: job.sourceFileId,
      mapping,
    });

    if (!parsed.ok && parsed.code === "MAPPING_INCOMPLETE") {
      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "failed",
          mapping: parsed.mapping,
          errorMessage: "映射不完整",
          errorDetails: parsed.errors,
          finishedAt: new Date().toISOString(),
        })
      );
    }

    if (!parsed.records || !parsed.records.length) {
      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "failed",
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          headers: parsed.headers,
          rowCount: parsed.rowCount,
          successRows: 0,
          failedRows: parsed.failedRows,
          errorDetails: parsed.errors.length ? parsed.errors : null,
          errorMessage: "无成功行",
          records: [],
          finishedAt: new Date().toISOString(),
        })
      );
    }

    let persisted = 0;
    let persistErrors = [];
    try {
      const result = await persistRecords(pool, parsed.records, upsertDailyMetric);
      persisted = result.persisted;
      persistErrors = result.persistErrors;
    } catch (err) {
      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "failed",
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          headers: parsed.headers,
          rowCount: parsed.rowCount,
          successRows: 0,
          failedRows: parsed.rowCount,
          errorMessage: err && err.message ? err.message : String(err),
          errorDetails: parsed.errors.length ? parsed.errors : null,
          records: parsed.records,
          finishedAt: new Date().toISOString(),
        })
      );
    }

    const parseFailed = parsed.failedRows || 0;
    const persistFailed = persistErrors.length;
    const successRows = persisted;
    const failedRows = parseFailed + persistFailed;
    const allDetails = [
      ...(parsed.errors && parsed.errors.length ? parsed.errors : []),
      ...persistErrors,
    ];

    let status;
    if (successRows > 0 && failedRows === 0 && !parsed.partial) status = "completed";
    else if (successRows > 0) status = "partial_failed";
    else status = "failed";

    return publicJob(
      store.updateJob(context.tenantId, importId, {
        status,
        mapping: parsed.mapping,
        mappingAudit: parsed.mappingAudit,
        headers: parsed.headers,
        rowCount: parsed.rowCount,
        successRows,
        failedRows,
        errorDetails: allDetails.length ? allDetails : null,
        errorMessage:
          status === "failed"
            ? persistFailed
              ? "落库失败"
              : "无成功行"
            : persistFailed
              ? "部分行落库失败"
              : null,
        records: parsed.records,
        persistedRows: persisted,
        finishedAt: new Date().toISOString(),
      })
    );
  }

  function getJob(context, importId) {
    if (!context || !context.tenantId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    return publicJob(store.getJob(context.tenantId, importId));
  }

  function listJobs(context, limit) {
    if (!context || !context.tenantId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    return store.listJobs(context.tenantId, limit).map(publicJob);
  }

  return {
    store,
    createAndValidate,
    confirmImport,
    getJob,
    listJobs,
  };
}

module.exports = { createImportService, publicJob, persistRecords };
