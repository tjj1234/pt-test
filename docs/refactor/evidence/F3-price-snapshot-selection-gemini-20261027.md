# F3 价格快照选择候选 – 交付证据报告

**日期**：2026-10-27  
**来源**：`shell/usage/price-snapshot-selection-candidate.cjs`  
**测试**：`tests/regression/f3-price-snapshot-selection-candidate-test.mjs`

---

## 输入输出契约

### 函数签名

```
selectTextPriceSnapshot({ snapshots, model, requestedAt })
  → { snapshot: DeepFrozen | null, coverage, reasonCode? }
```

### 输入约束

| 字段 | 类型 | 约束 |
|------|------|------|
| `snapshots` | Array | 硬上限 1 000 项；不接受 getter/Proxy/循环引用 |
| `model` | string | 严格等值匹配；上限 1,000 字符 |
| `requestedAt` | ISO 8601 UTC 字符串 | 不接受 NaN/未来相对时间 |

每个快照项必须含：

- `sourceUrl`：必须为 `https://powertokens.ai/pricing`
- `currency`：必须为 `USD`
- `model`：严格等值（大小写敏感）
- `capturedAt`：已发生的 UTC 时间戳，不得晚于 `requestedAt`
- `effectiveFrom`：合法 UTC 时间戳
- `effectiveUntil`：合法 UTC 时间戳或 `null`（开区间右端）
- `inputUsdPerMillion`, `outputUsdPerMillion`, `cacheReadUsdPerMillion`, `cacheWriteUsdPerMillion`：有限非负数字；缺失/null/undefined 均拒绝

### 返回值

| `coverage` | `snapshot` | 含义 |
|------------|------------|------|
| `selected` | 深冻结快照副本 | 唯一匹配，可安全传入 `estimateTextResponseCost` |
| `unknown` | `null` | 无匹配、重叠、字段非法等；`reasonCode` 说明原因 |

### 错误码（reasonCode）

| 代码 | 说明 |
|------|------|
| `NO_MATCHING_SNAPSHOT` | 无任何快照覆盖指定调用时刻 |
| `OVERLAPPING_SNAPSHOTS` | 多个快照同时覆盖，无法确定唯一适用版本 |
| `INVALID_SOURCE_URL` | 来源非 PT 官方价格页 |
| `INVALID_CURRENCY` | 非 USD |
| `FUTURE_CAPTURED_AT` | 抓取时间晚于请求时间 |
| `INVALID_TIMESTAMPS` | 时间戳非法或区间颠倒 |
| `INVALID_PRICE_FIELD` | 价格字段缺失、非数字、NaN、Infinity 或负数 |
| `RESOURCE_LIMIT_EXCEEDED` | 快照数组超过硬上限 |
| `UNTRUSTED_INPUT` | getter/Proxy/非纯对象检测失败 |

---

## 测试原始结果

```
✔ 1. 唯一匹配成功与返回深冻结副本
✔ 2. 半开区间 [effectiveFrom, effectiveUntil) 起止边界测试
✔ 3. 无匹配区间 Fail-Closed（不能猜最近价）
✔ 4. 重叠版本 (Overlapping) 严格拒绝
✔ 5. 不同模型严格隔离与大小写敏感
✔ 6. 错误来源与非 USD 币种严格阻断
✔ 7. 缺失缓存维度拒绝（不能填 0）
✔ 8. 显式零费率是合法价格
✔ 9. 未来抓取时间 (capturedAt > requestedAt) 严格拒收
✔ 10. 非法时间戳与区间颠倒拒绝
✔ 11. 非有限价格 (NaN, Infinity) 与负数价格严格阻断
✔ 12. Getter, Setter, Proxy 与原型篡改防护
✔ 13. 资源硬上限防护与错误脱敏
✔ 14. 兼容性验证：选中快照与现有 estimateTextResponseCost 无缝联动

tests 14 | pass 14 | fail 0
```

`node --check` PASS，`git diff --check` PASS。

---

## 交付方抽查摘要（2026-10-27；独立主审见文末）

```
r1 唯一匹配：snapshot !== null, coverage = 'selected'   ✔
r2 无匹配：  snapshot === null, coverage = 'unknown',
             reasonCode = 'NO_MATCHING_SNAPSHOT'         ✔
r3 重叠：    snapshot === null, reasonCode = 'OVERLAPPING_SNAPSHOTS' ✔
```

---

## 风险与已知限制

1. **无内置价格**：模块不携带任何 PT 实际价格数据；调用方须从受信任来源录入快照。
2. **纯函数，不访问网络/时钟**：正确性完全取决于调用方传入快照的准确性与时效性。
3. **尚未接线**：此候选尚未连接 Run 持久台账、快照版本写入或 UI 展示；不能计入 F3 完整交付。
4. **未覆盖媒体价格**：视频/图片/音频计费维度按用户指示挂起，此模块不涉及。
5. **价格非 PT 实际账单**：估算结果与 PT 内部实际 credits/扣费独立；须在界面明确标注。

---

## 明确的未接线边界

- 快照持久写入数据库（无）
- 调用时版本绑定（无）
- 价格估算接入 Run 台账（无）
- 错误/取消/未知结果账本（无）
- 真实用户验收（无）
- 媒体价格（挂起）

主 Agent 后续负责以上全部接线工作。

## 主 Agent 独立审阅与加固（2026-10-27）

实际复跑候选选择器与既有文本估算器，两文件原有 **17/17 PASS**。源码审阅发现 `Date.parse` 可顺延非法公历日期、接受 `24:00`；数组 Proxy 的 length 与 options.throwOnError 存在直接属性读取；未知字段可携带未检查的嵌套对象。已用 Node 原生 `util.types.isProxy` 在读取前拒绝 Proxy，按属性描述符处理选项，限制平面字段与数组额外属性；时间戳仅接受 `Z`/`+00:00`，保留最多毫秒精度，并反查公历字段以拒绝日期顺延。新增三组负向回归后，两文件 **20/20 PASS**，`node --check` 和 `git diff --check` PASS。

本次当前工作区仅发现两个 `f3-` 前缀测试文件；交付摘要的“四个 F3 文件／33 项”和“全仓 328 文件”未在本轮复现，不能作为当前仓库验收结论。上文 reasonCode 表为交付方概括，实际精确常量以源码 `REASON_CODES` 为准（例如 `INVALID_TIMESTAMP`、`NON_FINITE_PRICE`、`GETTER_PROHIBITED`）。候选可进入后续接线，但仍无实际价格、持久快照、调用时版本绑定或产品费用展示。
