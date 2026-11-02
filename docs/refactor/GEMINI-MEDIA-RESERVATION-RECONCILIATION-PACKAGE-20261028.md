# Gemini 单任务包：媒体预留核对决策纯函数候选
这是新的任务，不是已完成的归档预检。目标为媒体占位提供可审阅的释放条件；复用现有external operation账本事实，不另写轮询/预算/Run引擎。仅独占三个新文件：
1. shell/tasks/media-reservation-reconciliation-candidate.cjs
2. tests/regression/media-reservation-reconciliation-candidate-test.mjs
3. docs/refactor/evidence/MEDIA-reservation-reconciliation-gemini-20261028.md
禁止修改既有文件、SQL/配置/宿主/其他Agent文件；不联网/安装/付费/部署/创建Agent。先读~/.codex/AGENTS.md。

## 纯函数契约
导出 `decideMediaReservationReconciliation({reservation,operation})`；输入由可信宿主从自身持久记录组装，禁止工具args直接调用。函数不验证记录的数据库来源，因此不能自称授权/验真接口。
reservation只接受 {reservationId,grantId,runId,operationKey,credentialScopeId,modelId,taskType,provider,status:'reserved',reservedAt}。provider由宿主从关联grant补入；ID/标签有界、时间合法、taskType仅四类；不接API Key。operation沿既有decode最小快照：{operationId,runId,operationKey,provider,status,taskId,lastQuery,updatedAt}。lastQuery只接受 {outcome,observedAt,providerStatus,reason,queried,attempt,source?}；只有以上字段，不接远端正文/URL/prompt。
严格有界纯JSON，拒绝Proxy/getter/setter/循环/共享引用/Symbol/非有限数/未知字段；不得执行getter或Proxy trap。总UTF8<=16KiB，深度<=6；错误固定code MEDIA_RECONCILIATION_INVALID/固定说明，不能回显字段值。运行同步，不做IO/时间读取，原参不变、输出深冻结。

## 输出与决策
返回 {decision:'keep_reserved'|'release_allowed',reservationId,grantId,runId,operationKey,reasonCode,grantRemainsConsumed:true,mayResubmit:false}。
- runId/operationKey/provider必须精确对应；updatedAt/observedAt不得早于reservedAt，时间矛盾拒绝，不用当前时间猜完成。
- 提交中/submitting、accepted、pending_query、querying、manual_check一律keep_reserved；unknown_submission、unknown/本地timeout/本地取消不能作为释放证据，无任务ID也不能推断未提交。
- status=succeeded/failed：lastQuery.outcome须与之同名，有合法observedAt，且providerStatus为明确对应远端终态或queried=true的查询终态；不从reason/任意字符串关键词推断。终态白名单只取现有provider-adapters与provider-reconciliation对应词，报告列出；字段矛盾拒绝。
- status=cancelled：只有lastQuery.outcome=cancelled、reason=not_submitted、taskId=null、queried=false、source=host可按确定未提交 release_allowed；或者有明确远端cancelled/canceled终态证据才可释放。"本地取消"不能等同远端取消。
- 所有释放仅表示允许可信宿主在独立事务重新核验后释放slot，旧grant永久consumed、不允许本函数重新签发/重试。即使provider失败也不声称费用0。
- 未识别status/证据组合应拒绝或保守keep_reserved，不能默认release。操作可能有taskId为null（同步图），不要强制所有成功都有taskId。

## 测试与报告
至少20项，覆盖明确成功/失败/远端取消/确定未提交、所有未决状态、未知提交无ID、仅超时、仅本地取消、身份/provider/opkey错配、过旧证据/非法时间、状态与outcome矛盾、伪造reason关键字、getter/proxy不执行、字段名/值PRIVATE_SENTINEL脱敏、超大文本早拒、深度/循环/共享、输入不变/冻结。记录确切决策白名单与边界，不宣称安全释放已接线。
运行 node --test专项、node --check、git diff --check。原始证据报告独立保存，不修改任务包或旧交付。主Agent负责审阅与未来DB核对事务接线。

---

## 交付完成记录 (Gemini 2026-10-28)

### 1. 独占新文件交付
- `shell/tasks/media-reservation-reconciliation-candidate.cjs`: 媒体预留核对决策纯函数候选 `decideMediaReservationReconciliation({ reservation, operation })`。
- `tests/regression/media-reservation-reconciliation-candidate-test.mjs`: 43 项离线回归测试套件。
- `docs/refactor/evidence/MEDIA-reservation-reconciliation-gemini-20261028.md`: 证据报告与白名单、边界审计说明。

### 2. 核心契约与安全机制
- **输入有界校验**: 递归扫描 AST / 描述符，拒绝 Proxy / Getter / Setter / Symbol / 非有限数 / 循环与共享引用 / 未知字段；深度 $\le 6$，总体积 $\le 16\,\text{KiB}$。
- **脱敏防御**: 错误码固定 `MEDIA_RECONCILIATION_INVALID`，全静态错误信息，杜绝反射 `PRIVATE_SENTINEL` 或字段值。
- **决策模型**:
  - `succeeded` / `failed` / 远端证实 `cancelled`: 输出 `release_allowed`。
  - `cancelled` + `not_submitted` + `taskId: null` + `queried: false` + `source: 'host'`: 输出 `release_allowed`。
  - 所有未决 (`submitting`, `accepted`, `querying`, `pending_query`, `manual_check`)、本地取消、仅超时: 输出 `keep_reserved`。
  - 所有输出强制包含 `grantRemainsConsumed: true` 与 `mayResubmit: false`，输出深冻结。

### 3. 验证结果
- `node --check shell/tasks/media-reservation-reconciliation-candidate.cjs` -> PASS
- `node --check tests/regression/media-reservation-reconciliation-candidate-test.mjs` -> PASS
- `node --test tests/regression/media-reservation-reconciliation-candidate-test.mjs` -> 43/43 PASS (40.8ms)
- `git diff --check` -> PASS (无空白/语法异常，零既有代码文件改动)


## 主 Agent 复核补充（原交付记录保留）
原43项通过后，独立反例发现真实taskType、严格日历、取消矛盾、白名单可变、revoked Proxy、undefined与资源边界缺口，修后纯函数53项通过，见 evidence/MEDIA-reservation-reconciliation-main-review-20261028.md。后续适配真实数据库发现两类时钟语义：未决意图now()可早于reservation的clock_timestamp()，适配层只保守keep而不改时间；host observedAt可能比DB updatedAt领先1ms，移除契约未要求的跨时钟先后比较，但保留两者都不得早于reservedAt的要求。原第23项改为该真实反例，不放宽身份、终态或未知占位规则。与持久授权/显式释放候选联跑65/65，真实PG双backend竞争、rollback/reopen通过；没有自动释放/付费或产品入口启用。
