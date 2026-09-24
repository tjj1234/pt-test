"use strict";
/**
 * A17 · 数据质量统计（适配层计数，只读汇总）
 */
function createQualityStatsStore() {
  /** @type {Map<string, object>} */
  const byWs = new Map();

  function ensure(workspaceId) {
    if (!byWs.has(workspaceId)) {
      byWs.set(workspaceId, {
        workspaceId,
        totalAdapted: 0,
        ignored: 0,
        unmapped: 0,
        eventIdNative: 0,
        eventIdFallback: 0,
        timestampClient: 0,
        timestampFallback: 0,
        mappedViaConfig: 0,
        updatedAt: null,
      });
    }
    return byWs.get(workspaceId);
  }

  function record(workspaceId, flags = {}) {
    const s = ensure(workspaceId);
    if (flags.ignored) {
      s.ignored += 1;
      s.totalAdapted += 1;
      s.updatedAt = new Date().toISOString();
      return;
    }
    if (flags.unmapped) {
      s.unmapped += 1;
      s.totalAdapted += 1;
      s.updatedAt = new Date().toISOString();
      return;
    }
    s.totalAdapted += 1;
    if (flags.eventIdNative) s.eventIdNative += 1;
    else s.eventIdFallback += 1;
    if (flags.timestampFallback) s.timestampFallback += 1;
    else s.timestampClient += 1;
    if (flags.mapped) s.mappedViaConfig += 1;
    s.updatedAt = new Date().toISOString();
  }

  function snapshot(workspaceId) {
    const s = ensure(workspaceId);
    const adaptedOk = s.eventIdNative + s.eventIdFallback;
    return {
      workspaceId,
      totalAdapted: s.totalAdapted,
      ignored: s.ignored,
      unmappedEventCount: s.unmapped,
      eventIdQuality: {
        client_native_unique: s.eventIdNative,
        adapter_fallback: s.eventIdFallback,
        client_native_ratio:
          adaptedOk > 0 ? Number((s.eventIdNative / adaptedOk).toFixed(4)) : null,
      },
      timestampFallback: {
        count: s.timestampFallback,
        ratio: adaptedOk > 0 ? Number((s.timestampFallback / adaptedOk).toFixed(4)) : null,
        client_count: s.timestampClient,
      },
      mappedViaConfig: s.mappedViaConfig,
      updatedAt: s.updatedAt,
    };
  }

  function reset(workspaceId) {
    byWs.delete(workspaceId);
  }

  return { record, snapshot, reset, ensure };
}

module.exports = { createQualityStatsStore };
