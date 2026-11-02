"use strict";
const { admitControlledMediaAttempt } = require("./controlled-media-admission.cjs");
const { callMediaRoute } = require("../../business/media/powertokens.cjs");
const { createMediaInputAsset } = require("./media-input-asset.cjs");

// Trusted Run context is injected by the host, never accepted from child args.
// drain() keeps the executor lease alive until late external acknowledgements settle.
function createMediaRunHandler({ store, identity, taskRun, loadCredential, resolveRoute, executeMedia = callMediaRoute, fetchImpl = globalThis.fetch, loadControlledGrant = null, reserveControlledAttempt = null, inputImageBytes = null, inputImageFilename = 'reference.png', assetBridgeFactory = null }) {
  if (!store || typeof loadCredential !== "function" || typeof executeMedia !== "function" || typeof fetchImpl !== "function") throw new TypeError("Media handler dependencies are required");
  if (resolveRoute !== undefined && typeof resolveRoute !== "function") throw new TypeError("Media route resolver must be a function");
  const controlled = loadControlledGrant !== null || reserveControlledAttempt !== null;
  if (controlled && (typeof loadControlledGrant !== "function" || typeof reserveControlledAttempt !== "function" || typeof resolveRoute !== "function")) throw new TypeError("Controlled media dependencies are required");
  const operations = store.externalOperations;
  if (!operations) throw new TypeError("Durable external operations store is required");
  const pendingMediaRpc = new Set();
  const handle = (request) => {
    const operation = (async () => {
      const { requestId, name, args, signal } = request;
      if (name !== "media.route") throw Object.assign(new Error("Parent RPC tool is not allowed"), { code: "TOOL_NOT_ALLOWED" });
      if (!taskRun || !taskRun.runId || !taskRun.leaseOwner) throw Object.assign(new Error("Run lease context is unavailable"), { code: "RUN_LEASE_UNAVAILABLE" });
      if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw Object.assign(new Error("Parent RPC request ID is invalid"), { code: "TOOL_REQUEST_INVALID" });
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw Object.assign(new Error("media.route arguments are invalid"), { code: "TOOL_REQUEST_INVALID" });
      if (signal?.aborted || taskRun.signal?.aborted) throw Object.assign(new Error("Media operation was cancelled before submission"), { code: "SESSION_ABORTED" });

      const apiKey = await loadCredential(identity.userId);
      if (!apiKey || !String(apiKey).trim()) throw Object.assign(new Error("PowerTokens credential is unavailable"), { code: "NO_API_KEY" });
      // Resolve with the exact credential used for submission. A second Key
      // lookup could authorize one credential scope and submit under another.
      // No durable intent or paid request exists until qualification succeeds.
      const grant = controlled ? await loadControlledGrant(identity, taskRun.runId) : null;
      if (controlled && !grant) throw Object.assign(new Error("Controlled media authorization is unavailable"), { code: "MEDIA_GRANT_INVALID" });
      const resolvedRoute = resolveRoute ? await resolveRoute({ identity: { ...identity }, args: structuredClone(args), apiKey,
        ...(controlled ? { selection: { mode: "manual", modelId: grant.modelId } } : {}) }) : undefined;
      if (resolveRoute && (!resolvedRoute || typeof resolvedRoute !== "object" || Array.isArray(resolvedRoute))) {
        throw Object.assign(new Error("Media model qualification is unavailable"), { code: "MEDIA_ROUTE_UNAVAILABLE" });
      }
      if (signal?.aborted || taskRun.signal?.aborted) throw Object.assign(new Error("Media operation was cancelled before submission"), { code: "SESSION_ABORTED" });
      const operationKey = `${taskRun.runId}:${requestId}`;
      let intentRecorded = false;
      let resultRecorded = false;
      let postAttempted = false;
      let taskIdObserved = null;
      let taskIdRecorded = false;
      let externalResult = null;
      let mediaResult;
      let mediaExecutionCompleted = false;
      const persistResult = async ({ outcome, providerStatus = null, reason = null, queried = false }) => {
        if (!intentRecorded) throw Object.assign(new Error("External result arrived before durable intent"), { code: "EXTERNAL_INTENT_MISSING" });
        externalResult = { outcome, providerStatus, reason, queried };
        await operations.recordSubmissionResult(identity, taskRun.runId, operationKey, {
          runLeaseOwner: taskRun.leaseOwner,
          outcome,
          providerStatus,
          reason,
          queried,
          observedAt: new Date().toISOString(),
        });
        resultRecorded = true;
      };
      const abortableFetch = (url, init = {}) => {
        const signals = [signal, taskRun.signal, init.signal].filter(Boolean);
        const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
        if (combinedSignal.aborted) throw Object.assign(new Error("Media operation was aborted"), { code: "SESSION_ABORTED" });
        if (String(init.method || "GET").toUpperCase() === "POST") postAttempted = true;
        return fetchImpl(url, { ...init, signal: combinedSignal });
      };

      const persistTaskId = async (taskId) => {
        await operations.recordTaskId(identity, taskRun.runId, operationKey, {
          taskId,
          runLeaseOwner: taskRun.leaseOwner,
        });
        taskIdRecorded = true;
      };

      try {
        const preparedInputImageUrl = ['pt-python-video-v1','pt-python-seedance-v1'].includes(resolvedRoute?.adapterId) && args.taskType === 'image2video'
          ? await createMediaInputAsset({operations,emit:taskRun.emit, ...(assetBridgeFactory?{bridgeFactory:assetBridgeFactory}:{})})({identity,taskRun,requestId,bytes:inputImageBytes,filename:inputImageFilename,apiKey,signal:AbortSignal.any([signal,taskRun.signal].filter(Boolean))})
          : null;
        mediaResult = await executeMedia({ ...identity, workspaceId: "ws_" + identity.tenantId }, args, {
        apiKey,
        ...(preparedInputImageUrl ? {preparedInputImageUrl} : {}),
        ...(resolveRoute ? { resolvedRoute, requireResolvedRoute: true } : {}),
        fetchImpl: abortableFetch,
        signal: AbortSignal.any([signal, taskRun.signal].filter(Boolean)),
        onExternalIntent: async (metadata) => {
          if (signal?.aborted || taskRun.signal?.aborted) throw Object.assign(new Error("Media operation was cancelled before submission"), { code: "SESSION_ABORTED" });
          if (controlled) {
            if (metadata.provider !== resolvedRoute.provider) throw Object.assign(new Error("Controlled provider mismatch"), { code: "MEDIA_GRANT_ROUTE_MISMATCH" });
            await admitControlledMediaAttempt({ grant,
              run: { runId:taskRun.runId, userId:identity.userId, tenantId:identity.tenantId, state:"running", activeLease:true, leaseOwner:taskRun.leaseOwner },
              credentialScopeId:resolvedRoute.scopeId, route:resolvedRoute, requestId,
              reserveAttempt: async reservation => {
                const receipt = await reserveControlledAttempt(identity, { ...reservation, runLeaseOwner:taskRun.leaseOwner, provider:resolvedRoute.provider, adapterId:resolvedRoute.adapterId, adapterVersion:resolvedRoute.adapterVersion });
                if (receipt?.intentRecorded !== true) throw Object.assign(new Error("Atomic intent receipt missing"), { code:"MEDIA_RESERVATION_INVALID" });
                return receipt;
              },
            });
            intentRecorded = true;
            return;
          }
          await operations.createIntent(identity, taskRun.runId, {
            provider: metadata.provider,
            operationKey,
            runLeaseOwner: taskRun.leaseOwner,
          });
          intentRecorded = true;
        },
        // Non-fetch executors (for example a trusted Python worker) must
        // acknowledge this boundary before allowing their provider POST.
        onExternalSubmissionStarted: async () => {
          if (!intentRecorded) throw Object.assign(new Error("External submission arrived before durable intent"), { code: "EXTERNAL_INTENT_MISSING" });
          if (signal?.aborted || taskRun.signal?.aborted) throw Object.assign(new Error("Media operation was cancelled before submission"), { code: "SESSION_ABORTED" });
          postAttempted = true;
        },
        onExternalTaskId: async ({ taskId }) => {
          taskIdObserved = taskId;
          if (!intentRecorded) throw Object.assign(new Error("External task ID arrived before durable intent"), { code: "EXTERNAL_INTENT_MISSING" });
          await persistTaskId(taskId);
          // Intentionally persist even after abort: a known remote task must be
          // reconciled; aborting this local turn does not cancel provider work.
        },
        onExternalResult: async ({ outcome, providerStatus }) => persistResult({ outcome, providerStatus }),
        });
        mediaExecutionCompleted = true;
        if (!resultRecorded) await persistResult({ outcome: "succeeded", providerStatus: "succeeded", queried: taskIdRecorded });
        return mediaResult;
      } catch (error) {
        // No executor acknowledged submission: this is a local failure before submission,
        // distinct from an aborted POST whose provider outcome is unknown.
        if (intentRecorded && !postAttempted && !resultRecorded) {
          await persistResult({ outcome: "cancelled", reason: "not_submitted" });
        }
        // A task ID is already known to this process. Retry only its idempotent
        // persistence once; never resume polling or repeat the paid POST here.
        if (intentRecorded && postAttempted && taskIdObserved && !taskIdRecorded) {
          try { await persistTaskId(taskIdObserved); } catch { /* fall through to fail-closed manual state */ }
        }
        // First retry an observed synchronous result. A failed acknowledgement
        // from its durable write must not be misclassified as an unknown POST.
        if (intentRecorded && postAttempted && externalResult && !resultRecorded) {
          try { await persistResult(externalResult); } catch { /* continue to fail-closed manual state */ }
        }
        // If task polling and media result extraction already completed, a
        // recovered durable acknowledgement is enough to return that result.
        // Callback failures before executeMedia returns have no recoverable
        // result here and remain errors for the caller.
        if (mediaExecutionCompleted && resultRecorded) return mediaResult;
        // A sent POST without a durable task ID/result is an unknown submission,
        // not proof of remote cancellation or failure. Preserve the Run lease so
        // the enclosing execution can still persist its terminal Run state.
        if (intentRecorded && postAttempted && !taskIdRecorded && !resultRecorded) {
          const current = await operations.get(identity, taskRun.runId, operationKey);
          if (!current.taskId && ["submitting", "manual_check"].includes(current.status)) {
            await operations.markUnknownSubmission(identity, taskRun.runId, operationKey, {
              runLeaseOwner: taskRun.leaseOwner,
              reason: taskIdObserved ? "task_id_persistence_failed" : "submission_response_unknown",
              observedAt: new Date().toISOString(),
            });
          }
        }
        throw error;
      }
    })();
    pendingMediaRpc.add(operation);
    operation.then(() => pendingMediaRpc.delete(operation), () => pendingMediaRpc.delete(operation));
    return operation;
  };
  async function drain() {
    while (pendingMediaRpc.size) await Promise.allSettled([...pendingMediaRpc]);
  }
  return { handle, drain };
}
module.exports = { createMediaRunHandler };
