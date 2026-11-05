import { createBillingClient, isValidDate, sha256 } from '../../shell/candidates/billing-20261103/index.cjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✖ [FAIL] ${message}`);
    failed++;
  }
}

// 构造模拟 HTTP 传输层，返回 API 接口文档规范对应的真实响应
function createMockTransport() {
  return async ({ url, headers }) => {
    // 检查 Authorization Header
    if (!headers.Authorization || headers.Authorization === 'INVALID_TOKEN') {
      return { status: 401, data: { code: 401, msg: 'Unauthorized' } };
    }
    if (headers.Authorization === 'FORBIDDEN_TOKEN') {
      return { status: 403, data: { code: 403, msg: 'Forbidden' } };
    }
    if (headers.Authorization === 'RATE_LIMITED_TOKEN') {
      return { status: 429, data: { code: 429, msg: 'Too many requests' } };
    }

    const u = new URL(url);

    // 1. 资产签署状态
    if (u.pathname === '/api/v1/asset/agreement/status') {
      return {
        status: 200,
        data: {
          code: 200,
          data: {
            account_id: 'usr_va2SPJksQ10_z7gG',
            agreement_accepted: true,
            asset_library_enabled: true,
          },
          msg: '',
        },
      };
    }

    // 2. 余额查询
    if (u.pathname === '/api/v1/billing/balance') {
      return {
        status: 200,
        data: {
          code: 200,
          data: {
            balance: 9735,
            cache_ttl_seconds: null,
            currency: 'credits',
            data_as_of: '2026-10-30T06:28:35Z',
            is_cached: false,
            key_id: 'YlDh******D1Ci',
            updated_at: '2026-09-29T09:30:00Z',
          },
          msg: '',
        },
      };
    }

    // 3. 消费记录查询
    if (u.pathname === '/api/v1/logs/query') {
      return {
        status: 200,
        data: {
          code: 200,
          data: {
            consume_id: 'COS_20261029000039',
            request_id: '202610291027502520079680zCmvsK5',
            task_id: '',
            endpoint: 'POST /v1/images/edits',
            provider_name: 'Ali',
            model_id: 'wan2.7-image',
            model_name: 'Wan 2.7 Image',
            status: 'success',
            consume_time: 1793269685,
            request_type: 'image',
            quota: 30,
            original_quota: 30,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            billing: {
              pricing_mode: 'calculator',
              billing_unit: 'per_image',
              unit_size: 1,
              quota_per_unit: 1000,
              items: [{ name: 'Images', quantity: 1, unit_quota: 30, unit_label: 'images', subtotal_quota: 30 }],
              formula: '(Images 1 images × 30 credits/images) ≈ 30 credits',
              total_quota: 30,
              final_quota: 30,
            },
          },
          msg: '',
        },
      };
    }

    // 4. 账单汇总
    if (u.pathname === '/api/v1/billing/usage') {
      const s = u.searchParams.get('start_date') || '2026-09-21';
      const e = u.searchParams.get('end_date') || '2026-10-01';
      return {
        status: 200,
        data: {
          code: 200,
          data: {
            currency: 'credits',
            data_as_of: '2026-10-30T03:08:15Z',
            key_id: 'YlDh******D1Ci',
            period_start: s,
            period_end: e,
            items: [
              { model_id: 'wan2.7-image', model_type: 'image', quota: 30, request_count: 1 },
              { model_id: 'deepseek-chat', model_type: 'text', quota: 150, request_count: 5 },
            ],
          },
          msg: '',
        },
      };
    }

    return { status: 404, data: { code: 404, msg: 'Not Found' } };
  };
}

async function run() {
  console.log('\n=== BILLING 真实消费查询与账单核对探针开始 ===\n');

  const mockTransport = createMockTransport();
  const client = createBillingClient({
    baseUrl: 'https://powertokens.ai/api',
    token: 'VALID_AUTH_TOKEN',
    tenantId: 'tenant-billing-prod',
    httpTransport: mockTransport,
  });

  // [1] 资产库签署状态查询
  console.log('[1] 资产库签署状态查询');
  {
    const resStatus = await client.getAgreementStatus({ runId: 'run-b1' });
    assert(resStatus.ok === true, '签署状态查询成功 ok=true');
    assert(resStatus.accountId === 'usr_va2SPJksQ10_z7gG', 'accountId 返回准确');
    assert(resStatus.agreementAccepted === true, 'agreementAccepted=true');
    assert(resStatus.assetLibraryEnabled === true, 'assetLibraryEnabled=true');
    assert(typeof resStatus.queryAt === 'number', '包含时间戳 queryAt');
  }

  // [2] 余额查询
  console.log('\n[2] 余额查询');
  {
    const resBal = await client.getBalance({ runId: 'run-b1' });
    assert(resBal.ok === true, '余额查询成功 ok=true');
    assert(resBal.balance === 9735, 'balance 数值准确');
    assert(resBal.currency === 'credits', 'currency 为 credits');
    assert(resBal.keyId === 'YlDh******D1Ci', 'keyId 正确脱敏');
    assert(resBal.isCached === false, 'isCached 标志位正确');
  }

  // [3] 消费明细查询与单次核对
  console.log('\n[3] 消费明细查询与单次核对');
  {
    const resLog = await client.getConsumeLog({
      runId: 'run-b1',
      consumeId: 'COS_20261029000039',
    });
    assert(resLog.ok === true, '消费明细查询成功 ok=true');
    assert(resLog.consumeId === 'COS_20261029000039', 'consumeId 匹配');
    assert(resLog.modelId === 'wan2.7-image', 'modelId 正确');
    assert(resLog.quota === 30, '扣减额度 quota=30');
    assert(resLog.reconciled === true, '状态 success 标记 reconciled=true');

    // 记录未查到时标记 unknown
    const resNotFound = await client.getConsumeLog({
      runId: 'run-b1',
      consumeId: 'NON_EXISTENT_ID',
    });
    assert(resNotFound.ok === false && resNotFound.code === 'RECORD_NOT_FOUND', '记录不存在返回 RECORD_NOT_FOUND');
    assert(resNotFound.status === 'unknown', '未核实记录标记 status=unknown');
  }

  // [4] 账单汇总与总额累加
  console.log('\n[4] 账单汇总与总额累加');
  {
    const resUsage = await client.getUsageSummary({
      runId: 'run-b1',
      startDate: '2026-09-21',
      endDate: '2026-10-01',
    });
    assert(resUsage.ok === true, '账单汇总成功 ok=true');
    assert(resUsage.periodStart === '2026-09-21', '统计起始日期准确');
    assert(resUsage.periodEnd === '2026-10-01', '统计结束日期准确');
    assert(resUsage.items.length === 2, '包含 2 个模型明细条目');
    assert(resUsage.totalQuota === 180, '自动准确汇总 totalQuota=180 (30 + 150)');
  }

  // [5] 日期校验边界防御
  console.log('\n[5] 日期校验边界防御');
  {
    const resBadDate = await client.getUsageSummary({
      runId: 'run-b1',
      startDate: '2026-99-99',
    });
    assert(resBadDate.ok === false && resBadDate.code === 'DATE_RANGE_INVALID', '非法日期格式拦截 DATE_RANGE_INVALID');

    const resInvertedDate = await client.getUsageSummary({
      runId: 'run-b1',
      startDate: '2026-10-10',
      endDate: '2026-10-01',
    });
    assert(resInvertedDate.ok === false && resInvertedDate.code === 'DATE_RANGE_INVALID', '开始日期晚于结束日期拦截 DATE_RANGE_INVALID');
  }

  // [6] 鉴权与 HTTP 状态异常处理
  console.log('\n[6] 鉴权与 HTTP 状态异常处理');
  {
    // 未配置 Token
    const noTokenClient = createBillingClient({
      tenantId: 'tenant-billing-prod',
      httpTransport: mockTransport,
    });
    const resNoToken = await noTokenClient.getBalance({ runId: 'run-b1' });
    assert(resNoToken.ok === false && resNoToken.code === 'TOKEN_REQUIRED', '未提供 Token 返回 TOKEN_REQUIRED');

    // 401 失效
    const unauthClient = createBillingClient({
      token: 'INVALID_TOKEN',
      tenantId: 'tenant-billing-prod',
      httpTransport: mockTransport,
    });
    const res401 = await unauthClient.getBalance({ runId: 'run-b1' });
    assert(res401.ok === false && res401.code === 'AUTH_UNAUTHORIZED', '401 返回 AUTH_UNAUTHORIZED');

    // 403 权限不足
    const forbiddenClient = createBillingClient({
      token: 'FORBIDDEN_TOKEN',
      tenantId: 'tenant-billing-prod',
      httpTransport: mockTransport,
    });
    const res403 = await forbiddenClient.getBalance({ runId: 'run-b1' });
    assert(res403.ok === false && res403.code === 'AUTH_FORBIDDEN', '403 返回 AUTH_FORBIDDEN');

    // 429 频率超限
    const rateClient = createBillingClient({
      token: 'RATE_LIMITED_TOKEN',
      tenantId: 'tenant-billing-prod',
      httpTransport: mockTransport,
    });
    const res429 = await rateClient.getBalance({ runId: 'run-b1' });
    assert(res429.ok === false && res429.code === 'RATE_LIMIT_EXCEEDED', '429 返回 RATE_LIMIT_EXCEEDED');

    // 租户未配
    const noTenantClient = createBillingClient({
      token: 'VALID_AUTH_TOKEN',
      httpTransport: mockTransport,
    });
    const resNoTenant = await noTenantClient.getBalance({ runId: 'run-b1' });
    assert(resNoTenant.ok === false && resNoTenant.code === 'CROSS_TENANT_REJECTED', '缺少租户返回 CROSS_TENANT_REJECTED');

    // 离线无 transport
    const offlineClient = createBillingClient({
      token: 'VALID_AUTH_TOKEN',
      tenantId: 'tenant-billing-prod',
    });
    const resOffline = await offlineClient.getBalance({ runId: 'run-b1' });
    assert(resOffline.ok === false && resOffline.code === 'NETWORK_BLOCKED', '离线环境返回 NETWORK_BLOCKED');

    // 信号取消
    const ctrl = new AbortController();
    ctrl.abort();
    const resCancel = await client.getBalance({ runId: 'run-b1', signal: ctrl.signal });
    assert(resCancel.ok === false && resCancel.code === 'BILLING_CANCELLED', '外部信号取消返回 BILLING_CANCELLED');
  }

  console.log(`\n=== BILLING 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Billing probe fatal error:', err);
  process.exit(1);
});
