"use strict";
/**
 * A17 · 适配服务门面：映射配置 + adapt + 连接测试 + 质量统计
 */
const { createEventMappingStore } = require("./mapping-store");
const { createQualityStatsStore } = require("./quality-stats");
const { adaptEvent, adaptBatch } = require("./adapt");
const { runConnectionTest } = require("./connection-test");

function createIngestionAdapter(opts = {}) {
  const mappingStore = opts.mappingStore || createEventMappingStore(opts);
  const qualityStats = opts.qualityStats || createQualityStatsStore();

  function getMapping(workspaceId) {
    return mappingStore.load(workspaceId);
  }

  function putMapping(workspaceId, mappings, updatedBy) {
    return mappingStore.putMappings(workspaceId, mappings, updatedBy);
  }

  function adapt(workspaceId, raw, extra = {}) {
    return adaptEvent(raw, {
      workspaceId,
      mappingStore,
      qualityStats,
      receivedAtMs: extra.receivedAtMs,
    });
  }

  function adaptMany(workspaceId, raws, extra = {}) {
    return adaptBatch(raws, {
      workspaceId,
      mappingStore,
      qualityStats,
      receivedAtMs: extra.receivedAtMs,
    });
  }

  async function testConnection(workspaceId, input = {}) {
    // 若未给 event，用一条最小探测事件经适配层产出
    let event = input.event;
    if (!event) {
      const probe = adapt(workspaceId, {
        event_name: input.probeEventName || "visit",
        event_id: input.probeEventId,
        timestamp: input.probeTimestamp,
        visitor_id: "a17_probe",
      });
      if (!probe.ok || !probe.event) {
        return {
          ok: false,
          diagnosis: {
            code: "PROBE_ADAPT_FAILED",
            title: "探测事件适配失败",
            hint: probe.error && probe.error.message
              ? probe.error.message
              : "请配置 visit 映射或传入完整 event。",
          },
          adaptResult: probe,
        };
      }
      event = probe.event;
    }
    return runConnectionTest({
      collectUrl: input.collectUrl,
      secret: input.secret,
      event,
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    });
  }

  function getQualityStats(workspaceId) {
    return qualityStats.snapshot(workspaceId);
  }

  return {
    mappingStore,
    qualityStats,
    getMapping,
    putMapping,
    adapt,
    adaptMany,
    testConnection,
    getQualityStats,
  };
}

module.exports = { createIngestionAdapter };
