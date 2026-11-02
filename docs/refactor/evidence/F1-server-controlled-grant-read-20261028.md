# Server 持久授权读取接线（本地，未发布）

结论：server 已复用既有 grant store、媒体 handler 与 DSH profile，按当前用户/租户/Run 读取有效授权后选择 `media:<task>`。此增量只完成读取/消费接线，尚无产品授权签发或核对入口，不构成 F1 交付；没有真实 PT 请求、部署、提交或覆盖旧归档。

## 行为与信任边界

`getActiveGrantForRun(identity, runId)` 先核对 Run 所有权，只返回未消费且数据库时钟下未过期的授权；两个有效授权报 `MEDIA_GRANT_AMBIGUOUS`，不猜模型。server 在调用模型前固定授权 ID，后续 handler 按同一 ID 重读持久记录；客户端和工具参数不能选择授权。实际调用仍复用同 Key 路由资格、原子消费/跨 Run slot/同事务 external intent；默认无授权时不提高 profile，CSV 保持既有 profile。server 的媒体 handler 统一要求可信授权，避免绕过 profile 直接调用时走旧非受控提交路径。

签发仍是 host 内部 `issue()`，要求已运行且持有租约的 Run。当前没有用户确认→签发→执行的完整时序，测试中的签发由隔离预加载夹具在授权读取前完成；不能据此声称产品已能签发或实际出片。显式核对/释放候选尚未接 HTTP/UI。没有改变请求次数上限为金额硬上限。

## 本轮实际验证

| 命令/范围 | 结果 | 证据边界 |
|---|---|---|
| `node --test tests/regression/media-grant-store-candidate-test.mjs tests/regression/f1-controlled-media-admission-test.mjs tests/regression/f1-budget-policy-change-test.mjs` | 12/12 | 实际 PGlite 迁移、所有权、歧义/过期/消费、事务回滚、重开、未知提交及 SDK 暖会话预算 |
| `node --test tests/regression/f1-model-media-task-http-test.mjs tests/regression/f2-csv-http-sdk-integration-test.mjs tests/regression/f1-media-runner-host-test.mjs tests/regression/chat-request-test.mjs` | 6/6 | HTTP、真实 SDK/host/store，模型/provider 为替身；CSV 下载/历史和四媒体链未被本次接线破坏 |
| 扩充 HTTP 测试后单独重跑 `f1-model-media-task-http-test.mjs` | 1/1 | 实际 server + 数据库授权签发：无授权媒体请求不抬 profile；host 签发后 media profile；下一普通 Run 恢复默认；HTTP 伪造 grantId/profile 为 400 且不调用模型 |
| `node --check shell/server.cjs` | PASS | 语法检查 |

后一次单项是前一组 HTTP 项的扩充复验，不累计为第 19 个独立测试。未重新执行全仓回归/PG并发/Linux归档/目标环境；旧 candidate34-r3 不包含本次源码，保持不可部署草案及原 SHA。

下一断点：收口授权签发与 Run 生命周期的用户确认时序，接显式核对入口，再冻结新修订；付费验收总额度/单次额度仍待用户明确。本轮未触碰 Gemini F3 独占文件。
