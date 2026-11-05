'use strict';

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://powertokens.ai/api';

function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
}

function createBillingClient(config = {}) {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const token = config.token || null;
  const tenantId = config.tenantId || null;
  const httpTransport = config.httpTransport || null;

  async function executeRequest({ path, method = 'GET', queryParams = {}, signal }) {
    if (!tenantId) {
      return { ok: false, code: 'CROSS_TENANT_REJECTED', detail: 'tenantId is required' };
    }

    if (!token) {
      return { ok: false, code: 'TOKEN_REQUIRED', detail: 'Authorization token is required' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'BILLING_CANCELLED' };
    }

    if (!httpTransport) {
      return {
        ok: false,
        code: 'NETWORK_BLOCKED',
        detail: 'No httpTransport configured in offline environment',
      };
    }

    let url = `${baseUrl}${path}`;
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) {
        searchParams.append(k, String(v));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }

    try {
      const resp = await httpTransport({
        url,
        method,
        headers: {
          Authorization: token,
          Accept: 'application/json',
        },
        signal,
      });

      if (resp.status === 401) {
        return { ok: false, code: 'AUTH_UNAUTHORIZED', detail: 'Unauthorized or token expired' };
      }
      if (resp.status === 403) {
        return { ok: false, code: 'AUTH_FORBIDDEN', detail: 'Forbidden access to resource' };
      }
      if (resp.status === 429) {
        return { ok: false, code: 'RATE_LIMIT_EXCEEDED', detail: 'Rate limit exceeded' };
      }
      if (resp.status >= 500) {
        return { ok: false, code: 'SERVER_ERROR', detail: `Server error HTTP ${resp.status}` };
      }

      const body = resp.data || {};
      if (body.code !== 200) {
        return { ok: false, code: 'API_ERROR', detail: body.msg || `API error code ${body.code}` };
      }

      return { ok: true, data: body.data };
    } catch (err) {
      if (err.name === 'AbortError' || (signal && signal.aborted)) {
        return { ok: false, code: 'BILLING_CANCELLED' };
      }
      return { ok: false, code: 'TRANSPORT_ERROR', detail: err.message };
    }
  }

  // 1. 资产库签署状态
  async function getAgreementStatus(params = {}) {
    const { runId, signal } = params;
    if (!runId) return { ok: false, code: 'INVALID_INPUT', detail: 'runId is required' };

    const res = await executeRequest({ path: '/v1/asset/agreement/status', signal });
    if (!res.ok) return res;

    return {
      ok: true,
      accountId: res.data.account_id,
      agreementAccepted: Boolean(res.data.agreement_accepted),
      assetLibraryEnabled: Boolean(res.data.asset_library_enabled),
      queryAt: Date.now(),
    };
  }

  // 2. 余额查询
  async function getBalance(params = {}) {
    const { runId, signal } = params;
    if (!runId) return { ok: false, code: 'INVALID_INPUT', detail: 'runId is required' };

    const res = await executeRequest({ path: '/v1/billing/balance', signal });
    if (!res.ok) return res;

    return {
      ok: true,
      balance: res.data.balance,
      currency: res.data.currency || 'credits',
      keyId: res.data.key_id,
      isCached: Boolean(res.data.is_cached),
      dataAsOf: res.data.data_as_of,
      queryAt: Date.now(),
    };
  }

  // 3. 消费明细查询与核对
  async function getConsumeLog(params = {}) {
    const { runId, consumeId, signal } = params;
    if (!runId) return { ok: false, code: 'INVALID_INPUT', detail: 'runId is required' };

    const res = await executeRequest({ path: '/v1/logs/query', signal });
    if (!res.ok) return res;

    const record = res.data;
    if (!record || (consumeId && record.consume_id !== consumeId)) {
      return { ok: false, code: 'RECORD_NOT_FOUND', detail: 'Consume record not found', status: 'unknown' };
    }

    return {
      ok: true,
      consumeId: record.consume_id,
      requestId: record.request_id,
      modelId: record.model_id,
      status: record.status,
      consumeTime: record.consume_time,
      quota: record.quota,
      inputTokens: record.usage ? record.usage.input_tokens : 0,
      outputTokens: record.usage ? record.usage.output_tokens : 0,
      formula: record.billing ? record.billing.formula : '',
      reconciled: record.status === 'success',
    };
  }

  // 4. 账单汇总
  async function getUsageSummary(params = {}) {
    const { runId, startDate, endDate, signal } = params;
    if (!runId) return { ok: false, code: 'INVALID_INPUT', detail: 'runId is required' };

    if (startDate && !isValidDate(startDate)) {
      return { ok: false, code: 'DATE_RANGE_INVALID', detail: 'Invalid startDate format (must be YYYY-MM-DD)' };
    }
    if (endDate && !isValidDate(endDate)) {
      return { ok: false, code: 'DATE_RANGE_INVALID', detail: 'Invalid endDate format (must be YYYY-MM-DD)' };
    }
    if (startDate && endDate && startDate > endDate) {
      return { ok: false, code: 'DATE_RANGE_INVALID', detail: 'startDate cannot be later than endDate' };
    }

    const queryParams = {};
    if (startDate) queryParams.start_date = startDate;
    if (endDate) queryParams.end_date = endDate;

    const res = await executeRequest({ path: '/v1/billing/usage', queryParams, signal });
    if (!res.ok) return res;

    const data = res.data || {};
    const items = data.items || [];
    const totalQuota = items.reduce((acc, it) => acc + (it.quota || it.total_quota || 0), 0);

    return {
      ok: true,
      currency: data.currency || 'credits',
      keyId: data.key_id,
      periodStart: data.period_start || startDate || '',
      periodEnd: data.period_end || endDate || '',
      totalQuota,
      items: items.map((it) => ({
        modelId: it.model_id,
        modelType: it.model_type,
        totalQuota: it.quota || it.total_quota || 0,
        requestCount: it.request_count || 1,
      })),
    };
  }

  return {
    getAgreementStatus,
    getBalance,
    getConsumeLog,
    getUsageSummary,
    sha256,
  };
}

module.exports = {
  createBillingClient,
  isValidDate,
  sha256,
};
