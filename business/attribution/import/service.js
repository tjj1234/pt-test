"use strict";
/**
 * A9/A16 · AdImportJob 状态机：pending → validating → ready → importing → completed|partial_failed|failed
 * 复用 A15 parsers；tenant/workspace 只认 Context。
 * confirm 落库后：用新广告数据 + 已有 Collect 事件重算归因（不拉广告平台）。
 */
const { parseExportFile } = require("../parsers");
const { PROVIDERS } = require("../contracts/validate");
const { createImportStore } = require("./store");
const { createWorkspaceMetaStore } = require("./workspace-meta");
const { toDailyMetricRow } = require("./toDailyMetricRow");
const { upsertDailyMetric: defaultUpsertDailyMetric } = require("../../../analytics/backend/ads/ingest");

const TERMINAL = new Set(["completed", "partial_failed", "failed", "cancelled"]);

const POST_IMPORT_ACTION = Object.freeze({
  type: "recompute_attribution_with_collect",
  description:
    "用新导入的广告数据 + 已有 Collect 事件数据，重新计算归因结果；不是重新拉取广告平台数据。",
});

function publicJob(job) {
  if (!job) return null;
  const { tenantId, records, fileAbs, fileAbs2, ...rest } = job;
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

function toBuffer(input, base64Key, bufferKey) {
  if (Buffer.isBuffer(input[bufferKey])) return input[bufferKey];
  if (input[base64Key]) return Buffer.from(String(input[base64Key]), "base64");
  return null;
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

function buildParseInput(context, job, file, file2, mapping) {
  const input = {
    buffer: file.buffer,
    filename: job.originalName,
    workspaceId: context.workspaceId,
    provider: job.provider,
    sourceFileId: job.sourceFileId,
    mapping,
  };
  if (file2 && job.sourceFileId2) {
    input.buffer2 = file2.buffer;
    input.filename2 = job.originalName2 || job.originalName;
  }
  return input;
}

function createImportService(opts = {}) {
  const store = opts.store || createImportStore(opts);
  const workspaceMeta = opts.workspaceMeta || createWorkspaceMetaStore(opts);
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
    const buf = toBuffer(input, "contentBase64", "buffer");
    if (!buf || !buf.length) {
      throw Object.assign(new Error("文件为空"), { code: "EMPTY_FILE" });
    }
    if (buf.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error("文件超过 20MB"), { code: "TOO_LARGE" });
    }
    const buf2 = toBuffer(input, "contentBase64_2", "buffer2");
    if (buf2 && buf2.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error("第二文件超过 20MB"), { code: "TOO_LARGE" });
    }

    const ids = store.newIds();
    const importId = ids.importId;
    const sourceFileId = ids.sourceFileId;
    const sourceFileId2 = buf2 && buf2.length ? store.newIds().sourceFileId : null;
    const now = new Date().toISOString();
    const originalName = input.originalName || "upload.csv";
    const originalName2 = buf2 ? input.originalName2 || "upload-2.csv" : null;
    const abs = store.saveFile(context.tenantId, sourceFileId, buf, fileExt(originalName));
    let abs2 = null;
    if (buf2 && sourceFileId2) {
      abs2 = store.saveFile(context.tenantId, sourceFileId2, buf2, fileExt(originalName2));
    }

    store.createJob({
      importId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      provider,
      status: "pending",
      sourceFileId,
      originalName,
      sourceFileId2,
      originalName2,
      idempotencyKey: input.idempotencyKey || null,
      headers: null,
      sampleRows: null,
      mapping: null,
      mappingAudit: null,
      rowCount: null,
      successRows: null,
      failedRows: null,
      persistedRows: null,
      errorMessage: null,
      errorDetails: null,
      dateRange: null,
      currencySeen: [],
      join: null,
      postImportAction: null,
      createdBy: context.actorId || null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      fileAbs: abs,
      fileAbs2: abs2,
      records: null,
    });

    store.updateJob(context.tenantId, importId, { status: "validating" });

    try {
      const parsed = parseExportFile({
        buffer: buf,
        filename: originalName,
        buffer2: buf2 || undefined,
        filename2: originalName2 || undefined,
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
            sampleRows: [],
            mapping: parsed.mapping,
            mappingAudit: parsed.mappingAudit,
            rowCount: 0,
            join: parsed.join || null,
            errorMessage: "必填列未映射，请补 mapping 后 confirm",
            errorDetails: parsed.errors,
          })
        );
      }

      const dates = (parsed.records || []).map((r) => r.date).filter(Boolean).sort();
      const currencies = [
        ...new Set((parsed.records || []).map((r) => r.currency).filter(Boolean)),
      ];
      const sampleRows = (parsed.records || []).slice(0, 3).map((r) => ({
        date: r.date,
        campaignId: r.campaignId,
        adGroupId: r.adGroupId,
        country: r.country,
        spend: r.spend,
        creativeName: r.creativeName,
      }));

      return publicJob(
        store.updateJob(context.tenantId, importId, {
          status: "ready",
          headers: parsed.headers,
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          rowCount: parsed.rowCount,
          sampleRows,
          dateRange:
            dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
          currencySeen: currencies,
          join: parsed.join || null,
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
    const file2 = job.sourceFileId2
      ? store.readFile(context.tenantId, job.sourceFileId2)
      : null;

    const mapping = mappingPatch || job.mapping || undefined;
    const parsed = parseExportFile(buildParseInput(context, job, file, file2, mapping));

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

    const finishedAt = new Date().toISOString();
    let workspace = workspaceMeta.load(context.workspaceId);
    if (successRows > 0 && (status === "completed" || status === "partial_failed")) {
      workspace = workspaceMeta.markFirstConnected(context.workspaceId, finishedAt);
    }

    return publicJob(
      store.updateJob(context.tenantId, importId, {
        status,
        mapping: parsed.mapping,
        mappingAudit: parsed.mappingAudit,
        headers: parsed.headers,
        rowCount: parsed.rowCount,
        successRows,
        failedRows,
        persistedRows: persisted,
        join: parsed.join || job.join || null,
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
        postImportAction: successRows > 0 ? { ...POST_IMPORT_ACTION } : null,
        firstConnectedAt: workspace.firstConnectedAt || null,
        finishedAt,
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

  function getWorkspaceMeta(context) {
    if (!context || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    return workspaceMeta.load(context.workspaceId);
  }

  return {
    store,
    workspaceMeta,
    createAndValidate,
    confirmImport,
    getJob,
    listJobs,
    getWorkspaceMeta,
    POST_IMPORT_ACTION,
  };
}

module.exports = {
  createImportService,
  publicJob,
  persistRecords,
  POST_IMPORT_ACTION,
};
