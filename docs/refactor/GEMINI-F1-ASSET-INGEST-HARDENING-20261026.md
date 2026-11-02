# Gemini 独立任务包：F1 媒体抓取候选加固（2026-10-26）

**目标**：修正既有隔离候选的可证实边界漏洞，交回可供主 Agent 接线审阅的模块、专项测试和报告。此任务本身不接入产品、不宣称 F1 完成。主 Agent 与三个子 Agent 在你交回前不编辑本包指定文件。

## 文件独占边界

只可编辑 `shell/media/asset-ingest-candidate.cjs`、`tests/regression/f1-media-asset-ingest-candidate-test.mjs`、`docs/refactor/evidence/F1-media-asset-ingest-gemini-20261025.md`。可读 `docs/refactor/GEMINI-F1-MEDIA-ASSET-PACKAGE-20261025.md`、`docs/refactor/HANDOFF-20261026-F1.md` 及必要的宿主接口。不得修改 `server.cjs`、`media-run-handler.cjs`、Run/store、UI、配置、`WORKLOG.md` 或其他 Agent 文件；不得调用真实 PT、读取 Key/签名 URL、下载真实资产、变更数据库、commit/push/merge/部署、处理 `wb copy/`。

## 必须解决并验证

1. 所有错误消息、可枚举属性及 `cause` 均不携带原 URL、query、凭据或任何不受控响应头。现有 `Content-Type: image/png?token=secret123` 会把 token 写入错误消息；新增回归并修复。
2. 对 `maxBytes`、`timeoutMs` 做有限正整数及受控上界校验；`Infinity`、`NaN`、负数、零、非数字不得回退成宽松默认。若宿主选择更小上限，应保留更小值。新增边界测试。
3. 删除或安全约束先 `arrayBuffer()` 整块读入的路径；无可受限的流时失败关闭。测试应证明没有调用不受限的 `arrayBuffer()`，并覆盖头部伪报和流中超限。
4. 超时与外部取消覆盖 fetch 等待及流读取；即使注入的 fetch/reader 不配合 AbortSignal，调用本身也应在有界时间拒绝。释放 reader/响应体时不得遮盖原始固定错误码。新增不会无限挂起的测试。
5. 报告准确区分响应头 MIME 检查与文件内容格式验证；若不做文件魔数/容器解析，明确留下内容真实性缺口，不能再宣称完整媒体内容校验。
6. 复核精确主机白名单的适用范围：它不能单独证明 DNS 解析目的地址安全。若模块不控制 DNS/连接目标，在报告写明宿主必须限制允许域名、出口或解析策略；不要用 URL 字符串检查声称完整 SSRF 防护。

## 验收与交回

运行 `node --test tests/regression/f1-media-asset-ingest-candidate-test.mjs`、`node --check shell/media/asset-ingest-candidate.cjs` 和 `git diff --check`；只保留测试摘要与失败详情。报告三文件变更、命令结果、剩余限制和宿主接线前置。**不得**照搬旧报告“生成成功后、外部结果终态记录前接入”的时序：`media-run-handler.cjs` 可能已在回调中先持久化外部结果，集成时序由主 Agent 裁定。
