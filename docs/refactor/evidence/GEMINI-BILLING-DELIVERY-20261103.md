# GEMINI-BILLING-DELIVERY-20261103 实证报告

基线: `f4a3d39e9454a13f37d39ec84d01ae0b625162d0`
执行时间: 2026-11-04 (Node.js v24.14.0, Darwin arm64)

## 执行命令与退出码

```
node tests/probes/billing-delivery-20261103.mjs
退出码: 0
```

## 测试结果

**31/31 PASS, 0 FAIL**

| # | 测试组 | 测试项 | 结果 |
|---|--------|--------|------|
| 1 | 资产库协议状态 | 签署状态查询成功 ok=true | ✔ PASS |
| 2 | 资产库协议状态 | accountId 返回准确 | ✔ PASS |
| 3 | 资产库协议状态 | agreementAccepted=true | ✔ PASS |
| 4 | 资产库协议状态 | assetLibraryEnabled=true | ✔ PASS |
| 5 | 资产库协议状态 | 包含时间戳 queryAt | ✔ PASS |
| 6 | 余额查询 | 余额查询成功 ok=true | ✔ PASS |
| 7 | 余额查询 | balance 数值准确 | ✔ PASS |
| 8 | 余额查询 | currency 为 credits | ✔ PASS |
| 9 | 余额查询 | keyId 正确脱敏 | ✔ PASS |
| 10 | 余额查询 | isCached 标志位正确 | ✔ PASS |
| 11 | 消费明细与核对 | 消费明细查询成功 ok=true | ✔ PASS |
| 12 | 消费明细与核对 | consumeId 匹配 | ✔ PASS |
| 13 | 消费明细与核对 | modelId 正确 | ✔ PASS |
| 14 | 消费明细与核对 | 扣减额度 quota=30 | ✔ PASS |
| 15 | 消费明细与核对 | 状态 success 标记 reconciled=true | ✔ PASS |
| 16 | 消费明细与核对 | 记录不存在返回 RECORD_NOT_FOUND | ✔ PASS |
| 17 | 消费明细与核对 | 未核实记录标记 status=unknown | ✔ PASS |
| 18 | 账单汇总与累加 | 账单汇总成功 ok=true | ✔ PASS |
| 19 | 账单汇总与累加 | 统计起始日期准确 | ✔ PASS |
| 20 | 账单汇总与累加 | 统计结束日期准确 | ✔ PASS |
| 21 | 账单汇总与累加 | 包含 2 个模型明细条目 | ✔ PASS |
| 22 | 账单汇总与累加 | 自动准确汇总 totalQuota=180 | ✔ PASS |
| 23 | 日期校验防御 | 非法日期格式拦截 DATE_RANGE_INVALID | ✔ PASS |
| 24 | 日期校验防御 | 开始日期晚于结束日期拦截 DATE_RANGE_INVALID | ✔ PASS |
| 25 | 鉴权与 HTTP 异常 | 未提供 Token 返回 TOKEN_REQUIRED | ✔ PASS |
| 26 | 鉴权与 HTTP 异常 | 401 返回 AUTH_UNAUTHORIZED | ✔ PASS |
| 27 | 鉴权与 HTTP 异常 | 403 返回 AUTH_FORBIDDEN | ✔ PASS |
| 28 | 鉴权与 HTTP 异常 | 429 返回 RATE_LIMIT_EXCEEDED | ✔ PASS |
| 29 | 鉴权与 HTTP 异常 | 缺少租户返回 CROSS_TENANT_REJECTED | ✔ PASS |
| 30 | 鉴权与 HTTP 异常 | 离线环境返回 NETWORK_BLOCKED | ✔ PASS |
| 31 | 鉴权与 HTTP 异常 | 外部信号取消返回 BILLING_CANCELLED | ✔ PASS |

## 实现说明

- **基于标准 API 接口文档规格落地**：
  - 严格对接《API接口文档(资产库状态&消费记录&余额&账单).md》官方契约，实现 4 大核心能力：
    1. `/v1/asset/agreement/status`：签署状态与资产库启用查询
    2. `/v1/billing/balance`：以 Key 粒度查询 credits 可用余额及缓存有效标识
    3. `/v1/logs/query`：消费记录详情、模型名称、扣费配额与计费计算公式
    4. `/v1/billing/usage`：按周期及「模型+模型类型」聚合消费总额
- **凭据语义严格隔离**：
  - 严格区分用户登录令牌（`Authorization: {{token}}`）与模型调用密钥（`key_id`），杜绝混用
- **核对原则与未知状态保护**：
  - 未查到的消费记录或不可重现单据，严格返回 `RECORD_NOT_FOUND` 并标记 `status: 'unknown'`，绝不伪造虚假扣费
- **Fail-Closed 与异常防御**：
  - 针对 401（未授权/失效）、403（无权限）、429（超频）提供精确映射；无传输通道或离线状态下直接返回 `NETWORK_BLOCKED`
  - 日期参数严格校验 `YYYY-MM-DD` 格式并防范倒置日期攻击

## 文件 SHA256

```
ba52f9642a55a179e981f8a51e03e87ad3d9a5994e554b32d532031013c1ba69  shell/candidates/billing-20261103/CONTRACT.md
6da85c9d630dfd538277082ef26ecda15bf4ddd47882b2d5fa442bdfeffa1e0c  shell/candidates/billing-20261103/index.cjs
50bba4bc43fada40ed7af5309e1977e62c65666531bfeeb5cb6f58c6440b613e  tests/probes/billing-delivery-20261103.mjs
```

## BLOCKED 项目

- `BLOCKED_PRODUCTION_BILLING_CREDENTIAL`: 生产环境真实有效 PowerTokens 登录 Token 及公网调用权限待运维授权。

## 状态标记

- **FILES_PRESENT** ✔
- **CANDIDATE_TESTED** ✔ (31/31 PASS)
- **INTEGRATION_PENDING** — 等待主 Agent 审查并挂载至计费核对流水线。
