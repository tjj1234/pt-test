# Gemini 独立任务包：F1 媒体结果耐久性（2026-10-25）

**目标**：北极星目前把 PT 返回的图片/视频 URL 保存在对话历史；已有本地结果展示证据，但未证明链接过期后仍能重开。请独立完成“可信结果 URL → 可持久化本地资产”的**隔离候选模块与测试**，供主 Agent 审阅接线。这个模块本身不算 F1 交付。

## 工作边界

- 可读：`business/media/powertokens.cjs`、`shell/runtime/artifacts.cjs`、`shell/storage/`、`shell/server.cjs` 的媒体结果/下载入口、`docs/refactor/evidence/F1-pt-live-probes-20261024.md` 与相关测试。先核对现有实现，避免重复做已经存在的持久资产机制。
- 只允许新增你独占的 `shell/media/asset-ingest-candidate.cjs`、`tests/regression/f1-media-asset-ingest-candidate-test.mjs` 和 `docs/refactor/evidence/F1-media-asset-ingest-gemini-20261025.md`。不要编辑既有源码、测试、`WORKLOG.md`、配置或其他 Agent 文件。若路径已存在，停止写入并报告冲突。
- 不读取、复制、输出或存储 PT Key、Cookie、签名 URL；不发真实 PT 请求、不下载现有真实资产、不提交生成任务、不重投未知的 T2V。测试仅用本地 fake fetch / 内存流。
- 不启动/停止现有服务，不更改数据库结构，不改 `wb copy/`，不 commit、push、merge、打包或部署。工作树已有大量未提交改动，不执行 reset/checkout/clean。

## 候选模块契约

实现 Node 内置依赖的独立函数，输入由**可信宿主**提供：结果 URL、预期种类（image/video）、精确允许主机集合、fake/真实 fetch 注入、字节上限和超时。输出只包含 MIME、字节数、SHA-256 与可交给宿主保存的字节或受限流；不要输出原 URL 或请求头。必须拒绝非 HTTPS、URL 用户名/密码、IP 字面量与本地/非允许主机；`redirect: 'manual'`，任何 3xx 拒绝；非 2xx、MIME 不符、Content-Length 超限或流读取中超限均失败关闭；异常消息不得带完整 URL。不要从提示词、工具参数或前端传值生成允许主机集合。候选模块不自行写数据库或对话历史。

测试至少覆盖：允许主机的正常图片/视频、域名后缀伪装、私网/IP、重定向、超限与中途断流、MIME 错误、fetch 超时/拒绝、结果中无 URL/Key 泄漏。若认为这个契约不足以安全落盘，请在证据报告中指出并保持模块 fail-closed。

## 交付给主 Agent

报告新增文件、运行的精确测试命令/结果、现有历史 URL 的风险、接入点与尚缺的租户资产归属/下载授权/历史迁移方案。**不要**把候选模块描述为已接入产品；主 Agent 将独立复核后决定是否接线。请直接在这三个新文件工作，并把完成情况发回我。
