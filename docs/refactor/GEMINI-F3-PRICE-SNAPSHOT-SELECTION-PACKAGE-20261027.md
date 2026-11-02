# Gemini 单任务包：F3 文本定价快照选择候选

目标：为 F3 的“每次调用按当时适用的 PT 官方价格做可审计估算”提供**纯函数候选**。主 Agent 已有 `shell/usage/text-cost-estimate.cjs`，它只负责单次文本用量乘以已选中的价格；本包只解决“从版本化价格记录中确定唯一适用快照”。不得把候选当作 PT 实际账单，也不得接产品/Run。

**文件独占：仅新建以下 3 个文件，不修改任何已有文件、配置、锁文件、数据库或其他 Agent 文件。一次只做这一个任务包。**

1. `shell/usage/price-snapshot-selection-candidate.cjs`：导出 `selectTextPriceSnapshot({ snapshots, model, requestedAt })`。输入为本地传入的候选快照数组，单项至少含 `sourceUrl`、`version`、`capturedAt`、`effectiveFrom`、`effectiveUntil`（可为 null）、`currency`、`model`、`inputUsdPerMillion`、`outputUsdPerMillion`、`cacheReadUsdPerMillion`、`cacheWriteUsdPerMillion`。只接受 `https://powertokens.ai/pricing`、USD、完全相等的模型 ID、无歧义 UTC 时间戳、有限且非负价格；有效期采用 `[effectiveFrom,effectiveUntil)`。仅当指定调用时刻恰好落入**唯一**匹配快照才返回深冻结副本；无匹配、重叠、未来抓取时间、字段缺失/非法均返回 `{ snapshot: null, coverage: 'unknown', reasonCode }` 或稳定脱敏错误码，不能猜最近价、不能填 0。非零/零价格都必须来自明确字段。不得访问网络或时钟，不得从模型名猜价格或费率，不得改写原输入。对数组长度、字符串长度设硬上限，遇 getter/Proxy/循环/非纯对象 fail closed，错误信息不回显路径、模型名或用户数据。
2. `tests/regression/f3-price-snapshot-selection-candidate-test.mjs`：覆盖唯一匹配、起止边界、无匹配、重叠版本、不同模型、错误来源/币种、缺失缓存维度、零费率、未来 capturedAt、非法时间、NaN/Infinity、getter/Proxy、资源上限、输入不变和深冻结。另用已选快照调用现有 `estimateTextResponseCost` 做**一条兼容性验证**，不修改该模块。
3. `docs/refactor/evidence/F3-price-snapshot-selection-gemini-20261027.md`：记录输入输出契约、测试原始结果、风险与明确的未接线边界。

边界：没有 PT 按 Key 的用量/账单公开 API；本包不寻找或录入任何实际价格，不抓网页，不执行付费请求，不接数据库、Run、UI、导出或媒体价格。主 Agent 后续负责官方价格来源核验、持久快照写入、调用时绑定版本、错误/取消/未知结果账本与真实用户验收。交付前运行定向测试、`node --check`、`git diff --check`，报告实际结果；不得宣称 F3 交付。
