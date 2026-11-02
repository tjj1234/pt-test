# F2 CSV 本地完整链路复核（2026-10-27）

结论：当前源码已贯通 CSV 上传、列预览确认、专用预算、锁定 SDK 的工具调用、宿主计算、Run 产物、鉴权下载及历史重开；真实模型传输、浏览器操作和目标环境验收尚缺，F2 不标正式交付。普通聊天默认0工具不是已确认CSV的接线阻断。

| 证据 | 执行范围 | 已证实 | 限制 |
|---|---|---|---|
| csv-document-http-test.mjs | HTTP、隔离PGlite、目录及tenant决策替身 | 原始BOM/CRLF、预览/选择、变更拒绝、真实registry与宿主计算、产物下载/历史、跨租户404 | 替换tenant调用，不证明Adapter |
| f2-csv-real-sdk-runner-test.mjs | 实际锁定SDK与runner，确定性模型适配器 | 2 model/1 tool、主机RPC、产物生成、默认预算拒绝CSV、调用前台账拒绝阻断模型 | 直接发task帧，绕过HTTP/tenant/Adapter |
| f2-csv-http-sdk-integration-test.mjs | 真正server→tenant→Adapter→托管profile→runner→锁定SDK→宿主 | 上传→预览确认→sum=4→Run completed→同Run产物、来源SHA、MIME/下载头、文件SHA、未登录/跨租户拒绝、conversation/Run历史重开下载200 | 模型目录及模型适配器启动器为离线替身，不证明真实PT或生产部署 |

一体测试对适配器只替换子进程启动命令，保留发布安装验证、profile生成、任务协议和托管runner源码；未替换tenant.runDshForUser或宿主处理器。数据库/runtime/profile在临时目录，拒绝外部PT_PG_*配置，使用虚构Key，不调用PT，不执行付费请求。定向执行1/1 PASS；该文件也已进入默认全量回归（目录自动发现）。

## 预算与归属

server.cjs依据当前用户回合恰好一个已确认csvSelection传入budgetProfile=csv；tenant及Adapter双路径透传；runner读取run-budget-csv.json：最多2次模型、1次工具、仅csv_analyze，输出512token。未确认范围不享用此profile，宿主仍验证当前回合附件、用户/租户、源SHA、确认列/起始行及decimal类型。

下载通过已有/api/artifact，以当前租户工作区解析csv-results/<runId>/路径；历史保留精确runId及本地规范化产物链接。未新增旁路下载接口。

## 尚未完成

真实用户浏览器上传/确认/提问/下载/重开、同Key真实模型工具触发、目标候选安装与回滚仍需验收。本次没有部署、提交、推送或合并。F1媒体R2仍为独立并行候选，不受本地CSV通过替代。

默认全量复核184套件：179通过、5项旧候选/当前源码绑定失败；F2一体测试通过。详见default-regression-20261027.log，不代表发布通过。
