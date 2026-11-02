import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectTextPriceSnapshot,
  OFFICIAL_PRICE_SOURCE,
  OFFICIAL_CURRENCY,
  HARD_LIMITS,
  REASON_CODES,
  parseUnambiguousUtc,
} = require('../../shell/usage/price-snapshot-selection-candidate.cjs');

const { estimateTextResponseCost } = require('../../shell/usage/text-cost-estimate.cjs');

function makeSampleSnapshot(overrides = {}) {
  return {
    sourceUrl: OFFICIAL_PRICE_SOURCE,
    version: 'pt-20261026-v1',
    capturedAt: '2026-10-26T00:00:00Z',
    effectiveFrom: '2026-10-26T00:00:00Z',
    effectiveUntil: '2026-11-26T00:00:00Z',
    currency: OFFICIAL_CURRENCY,
    model: 'deepseek-chat',
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 3.0,
    cacheReadUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 2.0,
    ...overrides,
  };
}

test('calendar overflow and sub-millisecond timestamps cannot select a price', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-26T24:00:00Z', '2026-10-26T12:00:00.0001Z']) {
    assert.equal(parseUnambiguousUtc(value), null);
    assert.equal(selectTextPriceSnapshot({ snapshots: [makeSampleSnapshot()], model: 'deepseek-chat', requestedAt: value }).coverage, 'unknown');
  }
  assert.notEqual(parseUnambiguousUtc('2024-02-29T12:00:00+00:00'), null);
});

test('proxy arrays and option getters fail closed without executing traps', () => {
  let invoked = 0;
  const proxy = new Proxy([], { get() { invoked++; throw new Error('private'); } });
  const params = { snapshots: proxy, model: 'deepseek-chat', requestedAt: '2026-10-26T12:00:00Z' };
  assert.equal(selectTextPriceSnapshot(params).coverage, 'unknown');
  const options = Object.defineProperty({}, 'throwOnError', { get() { invoked++; return true; } });
  assert.equal(selectTextPriceSnapshot({ ...params, snapshots: [] }, options).coverage, 'unknown');
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(selectTextPriceSnapshot(revoked.proxy).coverage, 'unknown');
  assert.equal(invoked, 0);
});

test('unknown nested fields and array properties cannot bypass the flat schema', () => {
  const snapshot = makeSampleSnapshot(); snapshot.extra = snapshot;
  assert.equal(selectTextPriceSnapshot({ snapshots: [snapshot], model: 'deepseek-chat', requestedAt: '2026-10-26T12:00:00Z' }).coverage, 'unknown');
  const snapshots = [makeSampleSnapshot()];
  Object.defineProperty(snapshots, 'extra', { get() { throw new Error('must not execute'); } });
  assert.equal(selectTextPriceSnapshot({ snapshots, model: 'deepseek-chat', requestedAt: '2026-10-26T12:00:00Z' }).coverage, 'unknown');
});

test('1. 唯一匹配成功与返回深冻结副本', () => {
  const sample = makeSampleSnapshot();
  const originalSnapshots = [sample];

  const res = selectTextPriceSnapshot({
    snapshots: originalSnapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });

  assert.equal(res.coverage, 'selected');
  assert.equal(res.reasonCode, REASON_CODES.EXACT_MATCH);
  assert.ok(res.snapshot, '应当返回选中的快照对象');
  assert.equal(res.snapshot.model, 'deepseek-chat');
  assert.equal(res.snapshot.version, 'pt-20261026-v1');
  assert.equal(res.snapshot.inputUsdPerMillion, 1.0);
  assert.equal(res.snapshot.outputUsdPerMillion, 3.0);
  assert.equal(res.snapshot.cacheReadUsdPerMillion, 0.5);
  assert.equal(res.snapshot.cacheWriteUsdPerMillion, 2.0);

  // 验证深冻结
  assert.ok(Object.isFrozen(res));
  assert.ok(Object.isFrozen(res.snapshot));
  assert.throws(() => {
    'use strict';
    res.snapshot.inputUsdPerMillion = 999;
  }, TypeError);

  // 验证原入参未被冻结且未被就地修改
  assert.equal(Object.isFrozen(originalSnapshots), false);
  assert.equal(Object.isFrozen(sample), false);
  sample.version = 'modified-externally';
  assert.equal(res.snapshot.version, 'pt-20261026-v1', '返回的副本不受原入参后续篡改影响');
});

test('2. 半开区间 [effectiveFrom, effectiveUntil) 起止边界测试', () => {
  const sample = makeSampleSnapshot({
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveUntil: '2026-11-01T00:00:00Z',
    capturedAt: '2026-10-01T00:00:00Z',
  });
  const snapshots = [sample];

  // 1. 恰好在起始时刻 (inclusive) -> 命中
  const resStart = selectTextPriceSnapshot({
    snapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-10-01T00:00:00Z',
  });
  assert.equal(resStart.coverage, 'selected');
  assert.equal(resStart.reasonCode, REASON_CODES.EXACT_MATCH);

  // 2. 恰好在截止时刻前 1 毫秒 -> 命中
  const resBeforeEnd = selectTextPriceSnapshot({
    snapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-10-31T23:59:59.999Z',
  });
  assert.equal(resBeforeEnd.coverage, 'selected');
  assert.equal(resBeforeEnd.reasonCode, REASON_CODES.EXACT_MATCH);

  // 3. 恰好在截止时刻 (exclusive) -> 未命中
  const resAtEnd = selectTextPriceSnapshot({
    snapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-11-01T00:00:00Z',
  });
  assert.equal(resAtEnd.coverage, 'unknown');
  assert.equal(resAtEnd.snapshot, null);
  assert.equal(resAtEnd.reasonCode, REASON_CODES.NO_MATCH);

  // 4. effectiveUntil 为 null (开放上界) -> 命中更晚时刻
  const openEndedSample = makeSampleSnapshot({
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveUntil: null,
    capturedAt: '2026-10-01T00:00:00Z',
  });
  const resOpen = selectTextPriceSnapshot({
    snapshots: [openEndedSample],
    model: 'deepseek-chat',
    requestedAt: '2027-05-20T10:00:00Z',
  });
  assert.equal(resOpen.coverage, 'selected');
  assert.equal(resOpen.snapshot.effectiveUntil, null);
});

test('3. 无匹配区间 Fail-Closed (不能猜最近价)', () => {
  const sample = makeSampleSnapshot({
    effectiveFrom: '2026-10-10T00:00:00Z',
    effectiveUntil: '2026-10-20T00:00:00Z',
    capturedAt: '2026-10-10T00:00:00Z',
  });

  // 请求时间早于起始时间 -> 拒绝且不猜最近价
  const resBefore = selectTextPriceSnapshot({
    snapshots: [sample],
    model: 'deepseek-chat',
    requestedAt: '2026-10-09T23:59:59Z',
  });
  assert.equal(resBefore.coverage, 'unknown');
  assert.equal(resBefore.reasonCode, REASON_CODES.NO_MATCH);

  // 空快照列表
  const resEmpty = selectTextPriceSnapshot({
    snapshots: [],
    model: 'deepseek-chat',
    requestedAt: '2026-10-15T00:00:00Z',
  });
  assert.equal(resEmpty.coverage, 'unknown');
  assert.equal(resEmpty.reasonCode, REASON_CODES.NO_MATCH);
});

test('4. 重叠版本 (Overlapping) 严格拒绝', () => {
  const snapV1 = makeSampleSnapshot({
    version: 'v1',
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveUntil: '2026-10-20T00:00:00Z',
    capturedAt: '2026-10-01T00:00:00Z',
  });
  const snapV2 = makeSampleSnapshot({
    version: 'v2',
    effectiveFrom: '2026-10-15T00:00:00Z',
    effectiveUntil: '2026-10-25T00:00:00Z',
    capturedAt: '2026-10-15T00:00:00Z',
  });

  // 2026-10-16 处于两者重叠区间内 -> 必须返回 unknown 与 OVERLAPPING_SNAPSHOTS
  const res = selectTextPriceSnapshot({
    snapshots: [snapV1, snapV2],
    model: 'deepseek-chat',
    requestedAt: '2026-10-16T00:00:00Z',
  });
  assert.equal(res.coverage, 'unknown');
  assert.equal(res.snapshot, null);
  assert.equal(res.reasonCode, REASON_CODES.OVERLAPPING_SNAPSHOTS);
});

test('5. 不同模型严格隔离与大小写敏感', () => {
  const snapChat = makeSampleSnapshot({ model: 'deepseek-chat' });
  const snapReasoner = makeSampleSnapshot({ model: 'deepseek-reasoner' });

  const snapshots = [snapChat, snapReasoner];

  // 查询 deepseek-chat
  const resChat = selectTextPriceSnapshot({
    snapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resChat.coverage, 'selected');
  assert.equal(resChat.snapshot.model, 'deepseek-chat');

  // 查询未收录模型
  const resMissing = selectTextPriceSnapshot({
    snapshots,
    model: 'gpt-4o',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resMissing.coverage, 'unknown');
  assert.equal(resMissing.reasonCode, REASON_CODES.NO_MATCH);

  // 大小写必须完全一致，绝不模糊猜测
  const resCase = selectTextPriceSnapshot({
    snapshots,
    model: 'DeepSeek-Chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resCase.coverage, 'unknown');
  assert.equal(resCase.reasonCode, REASON_CODES.NO_MATCH);
});

test('6. 错误来源与非 USD 币种严格阻断', () => {
  // 错误 sourceUrl
  const badSource = makeSampleSnapshot({ sourceUrl: 'https://untrusted-api.com/pricing' });
  const resBadSource = selectTextPriceSnapshot({
    snapshots: [badSource],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resBadSource.coverage, 'unknown');
  assert.equal(resBadSource.reasonCode, REASON_CODES.INVALID_SOURCE_URL);

  // 错误币种 CNY / EUR
  const badCurrency = makeSampleSnapshot({ currency: 'CNY' });
  const resBadCurrency = selectTextPriceSnapshot({
    snapshots: [badCurrency],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resBadCurrency.coverage, 'unknown');
  assert.equal(resBadCurrency.reasonCode, REASON_CODES.INVALID_CURRENCY);
});

test('7. 缺失缓存维度拒绝 (不能填 0)', () => {
  // 缺少 cacheReadUsdPerMillion
  const noCacheRead = makeSampleSnapshot({ cacheReadUsdPerMillion: undefined });
  const resNoCacheRead = selectTextPriceSnapshot({
    snapshots: [noCacheRead],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resNoCacheRead.coverage, 'unknown');
  assert.equal(resNoCacheRead.reasonCode, REASON_CODES.MISSING_CACHE_DIMENSION);

  // 缺少 cacheWriteUsdPerMillion
  const noCacheWrite = makeSampleSnapshot({ cacheWriteUsdPerMillion: undefined });
  const resNoCacheWrite = selectTextPriceSnapshot({
    snapshots: [noCacheWrite],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resNoCacheWrite.coverage, 'unknown');
  assert.equal(resNoCacheWrite.reasonCode, REASON_CODES.MISSING_CACHE_DIMENSION);
});

test('8. 显式零费率是合法价格', () => {
  // 显式声明缓存读取或输入费率为 0
  const zeroRateSnap = makeSampleSnapshot({
    inputUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0,
    cacheWriteUsdPerMillion: 0,
  });

  const res = selectTextPriceSnapshot({
    snapshots: [zeroRateSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });

  assert.equal(res.coverage, 'selected');
  assert.equal(res.snapshot.inputUsdPerMillion, 0);
  assert.equal(res.snapshot.cacheReadUsdPerMillion, 0);
  assert.equal(res.snapshot.cacheWriteUsdPerMillion, 0);
});

test('9. 未来抓取时间 (capturedAt > requestedAt) 严格拒收', () => {
  // 调用发生于 12:00，但该快照抓取时间标为 13:00 (在调用时刻看来属于未来快照)
  const futureCaptured = makeSampleSnapshot({
    capturedAt: '2026-10-26T13:00:00Z',
  });

  const res = selectTextPriceSnapshot({
    snapshots: [futureCaptured],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });

  assert.equal(res.coverage, 'unknown');
  assert.equal(res.reasonCode, REASON_CODES.FUTURE_CAPTURED_AT);
});

test('10. 非法时间戳与区间颠倒拒绝', () => {
  // 1. 无时区标记 (非无歧义 UTC)
  const localTimeSnap = makeSampleSnapshot({
    effectiveFrom: '2026-10-26 00:00:00',
  });
  const resLocal = selectTextPriceSnapshot({
    snapshots: [localTimeSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resLocal.coverage, 'unknown');
  assert.equal(resLocal.reasonCode, REASON_CODES.INVALID_TIMESTAMP);

  // 2. requestedAt 非 UTC 字符串
  const resBadReq = selectTextPriceSnapshot({
    snapshots: [makeSampleSnapshot()],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26 12:00:00',
  });
  assert.equal(resBadReq.coverage, 'unknown');
  assert.equal(resBadReq.reasonCode, REASON_CODES.INVALID_TIMESTAMP);

  // 3. effectiveUntil <= effectiveFrom
  const invertedSnap = makeSampleSnapshot({
    effectiveFrom: '2026-10-26T12:00:00Z',
    effectiveUntil: '2026-10-25T12:00:00Z',
  });
  const resInverted = selectTextPriceSnapshot({
    snapshots: [invertedSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resInverted.coverage, 'unknown');
  assert.equal(resInverted.reasonCode, REASON_CODES.INVALID_EFFECTIVE_RANGE);
});

test('11. 非有限价格 (NaN, Infinity) 与负数价格严格阻断', () => {
  // NaN
  const nanSnap = makeSampleSnapshot({ inputUsdPerMillion: NaN });
  const resNan = selectTextPriceSnapshot({
    snapshots: [nanSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resNan.coverage, 'unknown');
  assert.equal(resNan.reasonCode, REASON_CODES.NON_FINITE_PRICE);

  // Infinity
  const infSnap = makeSampleSnapshot({ outputUsdPerMillion: Infinity });
  const resInf = selectTextPriceSnapshot({
    snapshots: [infSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resInf.coverage, 'unknown');
  assert.equal(resInf.reasonCode, REASON_CODES.NON_FINITE_PRICE);

  // 负数
  const negSnap = makeSampleSnapshot({ cacheReadUsdPerMillion: -0.01 });
  const resNeg = selectTextPriceSnapshot({
    snapshots: [negSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resNeg.coverage, 'unknown');
  assert.equal(resNeg.reasonCode, REASON_CODES.NEGATIVE_PRICE);
});

test('12. Getter, Setter, Proxy 与原型篡改防护', () => {
  // 1. Getter 陷阱探测并阻断执行
  let getterRan = false;
  const getterSnap = {
    get model() {
      getterRan = true;
      return 'deepseek-chat';
    },
  };
  const resGetter = selectTextPriceSnapshot({
    snapshots: [getterSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resGetter.coverage, 'unknown');
  assert.equal(resGetter.reasonCode, REASON_CODES.GETTER_PROHIBITED);
  assert.equal(getterRan, false, '不得执行 getter 代码');

  // 2. Proxy 恶意抛错
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Proxy 恶意抛错');
      },
    }
  );
  const resProxy = selectTextPriceSnapshot({
    snapshots: [throwingProxy],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resProxy.coverage, 'unknown');
  assert.equal(resProxy.reasonCode, REASON_CODES.PROXY_TRAP_ERROR);

  // 3. 原型链污染 (__proto__ / constructor 自身属性)
  const protoSnap = makeSampleSnapshot({ constructor: 'evil' });
  const resProto = selectTextPriceSnapshot({
    snapshots: [protoSnap],
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resProto.coverage, 'unknown');
  assert.equal(resProto.reasonCode, REASON_CODES.PROTOTYPE_POLLUTION);
});

test('13. 资源硬上限防护与错误脱敏', () => {
  // 1. 数组长度超限
  const hugeSnapshots = new Array(HARD_LIMITS.maxSnapshots + 1).fill(makeSampleSnapshot());
  const resHuge = selectTextPriceSnapshot({
    snapshots: hugeSnapshots,
    model: 'deepseek-chat',
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resHuge.coverage, 'unknown');
  assert.equal(resHuge.reasonCode, REASON_CODES.RESOURCE_LIMIT_EXCEEDED);

  // 2. 超长字符串防御
  const longModel = 'm'.repeat(HARD_LIMITS.maxStringLength + 1);
  const resLongModel = selectTextPriceSnapshot({
    snapshots: [makeSampleSnapshot()],
    model: longModel,
    requestedAt: '2026-10-26T12:00:00Z',
  });
  assert.equal(resLongModel.coverage, 'unknown');
  assert.equal(resLongModel.reasonCode, REASON_CODES.INVALID_MODEL);

  // 3. throwOnError 模式下的异常脱敏检查 (绝不泄露路径或模型名)
  try {
    selectTextPriceSnapshot(
      {
        snapshots: [makeSampleSnapshot({ currency: 'EUR' })],
        model: 'deepseek-chat',
        requestedAt: '2026-10-26T12:00:00Z',
      },
      { throwOnError: true }
    );
    assert.fail('应当抛出脱敏异常');
  } catch (err) {
    assert.equal(err.code, REASON_CODES.INVALID_CURRENCY);
    assert.ok(!err.message.includes('deepseek-chat'), '严禁在错误信息中回显模型名');
    assert.ok(!err.message.includes('/Users/'), '严禁在错误信息中回显文件路径');
  }
});

test('14. 兼容性验证：选中快照与现有 estimateTextResponseCost 无缝联动', () => {
  const sample = makeSampleSnapshot({
    model: 'example-model',
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 3.0,
    cacheReadUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 2.0,
  });

  // 1. 先通过候选选择器获取唯一适用快照
  const selection = selectTextPriceSnapshot({
    snapshots: [sample],
    model: 'example-model',
    requestedAt: '2026-10-26T12:00:00Z',
  });

  assert.equal(selection.coverage, 'selected');
  assert.ok(selection.snapshot);

  // 2. 将选出的深冻结快照直接输入现有 estimateTextResponseCost
  const costResult = estimateTextResponseCost({
    requestedModel: 'example-model',
    providerModel: 'example-model',
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    },
    price: selection.snapshot,
  });

  assert.equal(costResult.coverage, 'estimated');
  assert.equal(costResult.currency, 'USD');
  // 1000 * 1 + 200 * 3 + 400 * 0.5 + 100 * 2 = 1000 + 600 + 200 + 200 = 2000 / 1_000_000 = 0.002
  assert.equal(costResult.amount, 0.002);
  assert.equal(costResult.priceVersion, 'pt-20261026-v1');
  assert.equal(costResult.priceSourceUrl, OFFICIAL_PRICE_SOURCE);
});
