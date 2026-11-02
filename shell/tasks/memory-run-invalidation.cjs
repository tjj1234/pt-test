"use strict";

async function cancelActiveRunsForMemoryChange(store, execution, identity) {
  if (!store || !execution || !identity?.userId || !identity?.tenantId) return 0;
  let cancelled = 0;
  const failures = [];
  let cursor = null;
  do {
    const page = await store.listRuns(identity, { afterRunId: cursor, limit: 500 });
    for (const run of page.runs) {
      if (!["running", "waiting_external", "awaiting_confirmation", "cancelling"].includes(run.state)) continue;
      try {
        const result = await execution.cancel(identity, run.runId);
        if (result.stopped || result.run?.state === "cancelled") cancelled++;
        else failures.push(run.runId);
      } catch { failures.push(run.runId); }
    }
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return { cancelled, failures };
}

module.exports = { cancelActiveRunsForMemoryChange };
