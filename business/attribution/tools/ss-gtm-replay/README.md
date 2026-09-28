# A20 · SS-GTM 五缺陷离线回放

离线校验工具：用诊断 §6 的 5 个真实缺陷样例，打到 **Collect 三件套校验 + A17 适配层**，输出「未修复 vs 平台缓解」对照报告。

**不改任何生产代码路径。** 不依赖真实 GTM 容器。

## 跑法

```bash
# 文本报告（对照 diagnosis-baseline.json）
node business/attribution/tools/ss-gtm-replay/replay.js

# JSON
node business/attribution/tools/ss-gtm-replay/replay.js --json

# 缓解路径真入库（临时 PGlite）
node business/attribution/tools/ss-gtm-replay/replay.js --persist
```

验收入口：`node tests/attribution/a20-ss-gtm-replay.test.js`

## 五缺陷（§6 基线）

| ID | 缺陷 | 未修复 raw→Collect | A17 缓解后 |
|---|---|---|---|
| D1 | 502 网关 | TARGET_BAD_GATEWAY | 同左（只能诊断） |
| D2 | event_name 大小写（Visit） | REJECT event_name | 映射→visit 后 ACCEPT |
| D3 | event_id 非 UUID | REJECT event_id | 确定性 UUID 兜底 ACCEPT |
| D4 | 缺 timestamp | REJECT timestamp | received_at 兜底 ACCEPT |
| D5 | 缺 event_id | REJECT event_id | 确定性 UUID 兜底 ACCEPT |

PT 技术侧修好上游后：同一命令重跑；当 **raw→Collect 也 ACCEPT**（D1 为 diagnosis `OK`）即确认修复，无需重新手工诊断。
