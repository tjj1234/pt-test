"use strict";
/**
 * A18 · EventImportJob 状态机：pending → validating → ready → importing → completed|partial_failed|failed
 * 结构校验在本包；事件名映射 / 归一化统一走 A17；落库走 Collect ingestOne。
 */
const { createImportStore } = require("./store");
const { parseEventExportFile } = require("./parse-events");
const { createIngestionAdapter } = require("../ingestion-adapter");
const { validateEvent } = require("../../../analytics/backend/collect/validate");
const { ingestOne: defaultIngestOne } = require("../../../analytics/backend/collect/ingest");

const TERMINAL = new Set(["completed", "partial_failed", "failed", "cancelled"]);

function publicJob(job) {
  if (!job) return null;
  const { tenantId, records, fileAbs, ...rest } = job;
  return rest;
}

function fileExt(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".xlsx")) return ".xlsx";
  if (n.endsWith(".xls")) return ".xls";
  if (n.endsWith(".csv")) return ".csv";
  return ".csv";
}

function toBuffer(input) {
  if (Buffer.isBuffer(input.buffer)) return input.buffer;
  if (input.contentBase64) return Buffer.from(String(input.contentBase64), "base64");
  return null;
}

/**
 * 结构通过的行 → A17 adapt → Collect validate → ingestOne
 */
async function persistAdaptedEvents(pool, context, records, adapter, ingestFn) {
  const ingest = ingestFn || defaultIngestOne;
  const persistErrors = [];
  let persisted = 0;
  let ignored = 0;

  for (const rec of records) {
    const sourceRowNumber = rec.sourceRowNumber;
    try {
      const adapted = adapter.adapt(context.workspaceId, rec.raw);
      if (adapted.ignored) {
        ignored += 1;
        continue;
      }
      if (!adapted.ok || !adapted.event) {
        persistErrors.push({
          sourceRowNumber,
          field: "event_name",
          reason:
            (adapted.error && adapted.error.message) ||
            adapted.reason ||
            "A17 适配失败",
        });
        continue;
      }
      const v = validateEvent(adapted.event);
      if (!v.ok) {
        persistErrors.push({
          sourceRowNumber,
          field: (v.errors && v.errors[0] && v.errors[0].field) || null,
          reason:
            "Collect 校验失败: " +
            (v.errors || []).map((e) => e.message || e.field).join("; "),
        });
        continue;
      }
      await ingest(pool, {
        tenant_id: context.tenantId,
        webhook_id: "event_csv_import",
        event: adapted.event,
      });
      persisted += 1;
    } catch (err) {
      persistErrors.push({
        sourceRowNumber,
        field: null,
        reason: err && err.message ? err.message : String(err),
      });
    }
  }

  return { persisted, ignored, persistErrors };
}

function createEventImportService(opts = {}) {
  const path = require("node:path");
  const defaultEventStorage = path.join(
    process.env.PT_IMPORT_STORAGE_DIR ||
      path.join(__dirname, "..", "..", "..", "analytics", "data", "imports"),
    "_events"
  );
  const storageDir =
    opts.storageDir || process.env.PT_EVENT_IMPORT_STORAGE_DIR || defaultEventStorage;
  const store = opts.store || createImportStore({ storageDir, pool: opts.pool });
  const pool = opts.pool || null;
  const adapter =
    opts.adapter ||
    createIngestionAdapter({
      storageDir: opts.eventMappingDir || opts.adapterStorageDir,
      mappingStore: opts.mappingStore,
    });
  const ingestOne = opts.ingestOne || defaultIngestOne;

  async function createAndValidate(context, input) {
    if (!context || !context.tenantId || !context.workspaceId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const buf = toBuffer(input || {});
    if (!buf || !buf.length) {
      throw Object.assign(new Error("文件为空"), { code: "EMPTY_FILE" });
    }
    if (buf.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error("文件超过 20MB"), { code: "TOO_LARGE" });
    }

    const ids = store.newIds();
    const importId = ids.importId;
    const sourceFileId = ids.sourceFileId;
    const now = new Date().toISOString();
    const originalName = (input && input.originalName) || "events.csv";
    const abs = store.saveFile(context.tenantId, sourceFileId, buf, fileExt(originalName));

    await store.createJob({
      importId,
      kind: "event",
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      status: "pending",
      sourceFileId,
      originalName,
      idempotencyKey: (input && input.idempotencyKey) || null,
      headers: null,
      sampleRows: null,
      mapping: null,
      mappingAudit: null,
      rowCount: null,
      successRows: null,
      failedRows: null,
      persistedRows: null,
      ignoredRows: null,
      errorMessage: null,
      errorDetails: null,
      createdBy: context.actorId || null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      fileAbs: abs,
      records: null,
    });

    await store.updateJob(context.tenantId, importId, { status: "validating" });

    try {
      const parsed = parseEventExportFile({
        buffer: buf,
        filename: originalName,
        workspaceId: context.workspaceId,
        sourceFileId,
        mapping: (input && input.mapping) || undefined,
      });

      if (parsed.code === "MAPPING_INCOMPLETE") {
        return publicJob(
          await store.updateJob(context.tenantId, importId, {
            status: "ready",
            headers: parsed.headers,
            sampleRows: [],
            mapping: parsed.mapping,
            mappingAudit: parsed.mappingAudit,
            rowCount: 0,
            errorMessage: "必填列未映射，请补 mapping 后 confirm",
            errorDetails: parsed.errors,
          })
        );
      }

      const sampleRows = (parsed.records || []).slice(0, 3).map((r) => ({
        sourceRowNumber: r.sourceRowNumber,
        event_name: r.raw.event_name,
        user_id: r.raw.user_id,
        timestamp: r.raw.timestamp,
        utm_source: r.raw.utm_source || null,
      }));

      return publicJob(
        await store.updateJob(context.tenantId, importId, {
          status: "ready",
          headers: parsed.headers,
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          rowCount: parsed.rowCount,
          sampleRows,
          successRows: parsed.successRows,
          failedRows: parsed.failedRows,
          errorMessage: parsed.failedRows
            ? `结构校验：${parsed.successRows} 行通过，${parsed.failedRows} 行失败`
            : null,
          errorDetails: parsed.errors && parsed.errors.length ? parsed.errors : null,
          _previewOk: parsed.ok,
          _previewPartial: parsed.partial,
        })
      );
    } catch (err) {
      return publicJob(
        await store.updateJob(context.tenantId, importId, {
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
    const job = await store.getJob(context.tenantId, importId);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return publicJob(job);
    if (job.status !== "ready" && job.status !== "pending" && job.status !== "validating") {
      throw Object.assign(new Error("当前状态不可确认导入: " + job.status), {
        code: "BAD_STATUS",
      });
    }

    await store.updateJob(context.tenantId, importId, { status: "importing" });
    const file = store.readFile(context.tenantId, job.sourceFileId);
    if (!file) {
      return publicJob(
        await store.updateJob(context.tenantId, importId, {
          status: "failed",
          errorMessage: "原文件缺失",
          finishedAt: new Date().toISOString(),
        })
      );
    }

    if (!pool || typeof pool.connect !== "function") {
      return publicJob(
        await store.updateJob(context.tenantId, importId, {
          status: "failed",
          errorMessage: "导入落库需要 pool",
          finishedAt: new Date().toISOString(),
        })
      );
    }

    const mapping = mappingPatch || job.mapping || undefined;
    const parsed = parseEventExportFile({
      buffer: file.buffer,
      filename: job.originalName,
      workspaceId: context.workspaceId,
      sourceFileId: job.sourceFileId,
      mapping,
    });

    if (!parsed.ok && parsed.code === "MAPPING_INCOMPLETE") {
      return publicJob(
        await store.updateJob(context.tenantId, importId, {
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
        await store.updateJob(context.tenantId, importId, {
          status: "failed",
          mapping: parsed.mapping,
          mappingAudit: parsed.mappingAudit,
          headers: parsed.headers,
          rowCount: parsed.rowCount,
          successRows: 0,
          failedRows: parsed.failedRows,
          errorDetails: parsed.errors.length ? parsed.errors : null,
          errorMessage: "无成功行",
          finishedAt: new Date().toISOString(),
        })
      );
    }

    const { persisted, ignored, persistErrors } = await persistAdaptedEvents(
      pool,
      context,
      parsed.records,
      adapter,
      ingestOne
    );

    const parseFailed = parsed.failedRows || 0;
    const adaptFailed = persistErrors.length;
    const successRows = persisted + ignored;
    const failedRows = parseFailed + adaptFailed;
    const allDetails = [
      ...(parsed.errors && parsed.errors.length ? parsed.errors : []),
      ...persistErrors,
    ];

    let status;
    if (successRows > 0 && failedRows === 0 && !parsed.partial) status = "completed";
    else if (successRows > 0) status = "partial_failed";
    else status = "failed";

    return publicJob(
      await store.updateJob(context.tenantId, importId, {
        status,
        mapping: parsed.mapping,
        mappingAudit: parsed.mappingAudit,
        headers: parsed.headers,
        rowCount: parsed.rowCount,
        successRows,
        failedRows,
        persistedRows: persisted,
        ignoredRows: ignored,
        errorDetails: allDetails.length ? allDetails : null,
        errorMessage:
          status === "failed"
            ? adaptFailed
              ? "适配或落库失败"
              : "无成功行"
            : adaptFailed
              ? "部分行适配/落库失败"
              : parseFailed
                ? "部分行结构校验失败"
                : null,
        records: parsed.records,
        finishedAt: new Date().toISOString(),
      })
    );
  }

  async function getJob(context, importId) {
    if (!context || !context.tenantId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    const job = await store.getJob(context.tenantId, importId);
    if (job && job.kind && job.kind !== "event") return null;
    return publicJob(job);
  }

  async function listJobs(context, limit) {
    if (!context || !context.tenantId) {
      throw Object.assign(new Error("AttributionContext 必填"), { code: "CONTEXT_REQUIRED" });
    }
    return (await store
      .listJobs(context.tenantId, limit))
      .filter((j) => !j.kind || j.kind === "event")
      .map(publicJob);
  }

  return {
    store,
    adapter,
    createAndValidate,
    confirmImport,
    getJob,
    listJobs,
  };
}

module.exports = {
  createEventImportService,
  publicJob,
  persistAdaptedEvents,
};
