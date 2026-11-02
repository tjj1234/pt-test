# 2026-10-30 接续摘要：r14线上故障与完整重构开发

> **2026-10-31用户已明确暂停换对话。下一次优先读取 [HANDOFF-20261031-CONTINUATION.md](HANDOFF-20261031-CONTINUATION.md)，不要按本文件旧停点重做。当前r19仍绑定198源码，推理新接线尚未开始写代码。交接后停止，等用户/new。**

> 2026-10-31最新活动草案已到r19：SHA `7eb6d84fe8f2aa810f7f966071f0c11bed2b5a3a6f46b3ce10bc3b03dc6798eb`，198源码/399成员，继承r17办公文档与Word增量，并补确切Agent+当前原生call轨迹的工具Run预算/取消门禁。冻结后默认239/239，确切Linux闭包与5条SDK/HTTP链通过；R17本轮真实PG4/4，存储源码未变。未默认开公网搜索/Skill/提问，未部署。推理R3正式主审仍有缺口，主线改用现成DSH校验API；Context R3未正式交付。最新入口[原生门禁证据](evidence/NATIVE-TOOL-RUN-GATE-R19-20261031.md)、[推理R3主审](evidence/GEMINI-DSH-REASONING-R3-MAIN-REVIEW-20261031.md)、WORKLOG末尾。下方均为历史边界。

> 2026-10-31开发已继续，不等待运维；目标周一2026-11-02。当前活动草案r17 SHA `63c9c22b8b54fdc599791d50453561c0a293ca84ea1651e544631dc612b23715`，198源码/399成员；新增XLSX/PPTX输入与会话Word导出，同版原生DSH/HTTP→Run→Word→历史在确切Linux归档通过。默认236/236、真实PG16 4/4、Linux闭包及10项业务通过；仍非最终包或目标验收。最新入口[本轮证据](evidence/OFFICE-PRODUCT-R17-20261031.md)、[周一完整范围](MONDAY-FINAL-DELIVERY-20261102.md)和WORKLOG末尾。下方r16及更早内容为历史接续点。

> 2026-10-30本次接续已前进：r16冻结SHA `5ca372213a0aa22a9b00777cfe51fccc6542f72b027f116afd3e5205cdeb5119`，193源码/394成员，DSH目录准入/错误分类及DOCX已纳入；Linux依赖和确切归档业务通过。运维logs20261030确认UNKNOWN_MODEL12。默认232套件首轮214/18，后12项独立复跑通过，余6历史绑定，未报全绿。Context R2已交付且主审发现真实插件触发/预算/取消缺口，未接生产。当前操作入口[配置修复](OPS-R16-CONFIG-REPAIR-20261030.md)、[r16证据](evidence/F1-r16-model-config-repair-20261030.md)、[Context R2主审](evidence/GEMINI-DSH-CONTEXT-R2-MAIN-REVIEW-20261030.md)。下文为前一接续边界，勿重做已验证工作。

本次为用户主动要求换新对话的交接边界。先读本文件，再读 WORKLOG 和所列证据；不要依靠聊天记忆重做或宣称后台持续开发。工作区 `/Users/mmdn/Downloads/pt项目`；本次读取 HEAD `b09b1e1`，67个已跟踪文件修改，另有大量未跟踪源码/证据/发布物；保留全部脏工作和 `wb copy/`，不要 reset/clean/覆盖。未提交、推送或自行操作线上服务。

## 目标与合作方式

用户明确：优先放大、复用 DSH 原生能力，必要时才关闭或自研；除需用户/运维协助，持续执行开发，不停在阶段汇报。可独立任务交给外部 Gemini（通过任务文档由用户转交，不存在已连接 Gemini 工具）。所有输出中文、结论先行、证据明确、适合长期保存。

**当前部署的 r14 本次就必须正常 Agent 对话与受控多媒体生成；不能推迟到最终重构包。** 最终包仍需开发；早期用户目标是下周二2026-11-03，后续用户称“周一最终包”，存在日期差异，不能静默把周一等同于11-03。正式范围见 `REFACTOR-REMAINING-AND-DSH-ENABLEMENT-20261030.md`：12个未关闭工作流+5类跨功能验收门禁，不是完成百分比。用户此前授权测试Key的现有余额供测试；不得回显、写入文件/命令或日志，余额未知，不重复提交未知外部操作。本摘要不保存Key。

## 当前线上 r14（优先排障）

入口已由运维确认 `/opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell/server.cjs`，WorkingDirectory同目录；active/running PID223277，本机/public health ok。原先 PROFILE_STALE 已给 `OPS-R14-PROFILE-REBUILD-20261030.md`；不能删home/锁/manifest或覆盖profile。正式运维诊断入口 `OPS-R14-LIVE-AGENT-MEDIA-DIAGNOSIS-20261030.md`，用户通过聊天回传真实结果，原文件此前未真正回填。

故障：新对话“正在同步当前对话的模型”；AUTO无文字资格（生成图片也先经过文字编排）；手动多模型失败 `Agent turn ended without completion (reason=error)`；Run `5bf5c789-ffbd-4419-af3c-63a0a78e8c63` 在回执账号查询详情和事件均404，journal无关联记录。404只能说明该身份无法读取或记录不存在，未证明被删或上游原因。

目录回执 HTTP200 fresh/available，83项；deepseek-flash 与 deepseek-v4-1-flash-260910 均 present/chat=true/adapted_unverified/manual eligibility ok。四媒体任务所有83项均 LOCAL_POLICY_UNKNOWN_OR_DENIED。进一步配置回执：reviewConfigured=false、reviewStatus=not_configured、controlledAuthorization=false、assetHostsConfigured=false。因此目标机媒体审核/授权/托管配置未交付落地，不能归为用户Key问题；责任在交接缺口。审核文件要求同Key scopeId+capabilityRevision、最长24h，不能复制本地试验文件，不能全模型放行或伪造runtime验证。已给浏览器只读命令采集 seedream-5-0-260128、dreamina-seedance-2-0-mini-260615、seed-2-0-lite-260228 的 scope/revision/permission，**尚未收到该回执**。收到后准备精确审核、受限CDN主机与单次授权配置及激活/回滚文档。

`scripts/northstar-dsh-safe-errors.cjs` 为目标机只读诊断：有限扫描JSONL/Zstd、8MiB解压上限、跳软链接、不打印错误消息/路径/Key，只固定错误码/HTTP状态/匿名sessionHash/文件mtime/seq。已通过明文和Zstd敏感标记夹具，但尚非完整安全审计；mtime不是请求时间，汇总不是特定Run证明。27份压缩日志读取后25错误：8 RUN_MODEL_CALL_LIMIT、1 INVALID_REQUEST；更新后4条旧2026-10-22 UNKNOWN、其余12 UNCLASSIFIED。同会话早期未分类、后续预算耗尽，不能先加预算当修复。主审发现实际锁定 pi-ai 会抛 UNKNOWN_MODEL，但先前白名单漏它，**最后一次已补入，待运维复跑**。新脚本SHA `78e713f2d73015d77dbbf629dc9df2105eb9c97be46580e3114cb4976e980801`，文档同步更新。服务器目标 `/tmp/northstar-dsh-safe-errors.cjs`，用户最后尚未回传最新版结果。

**关键待查根因**：PT动态目录有两个DeepSeek ID，但 `shell/dsh-settings.yaml` 静态models均未列它们；锁定 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1648` 对未配置模型抛 UNKNOWN_MODEL。这很可能解释这两个ID失败，但尚无目标对应日志，不得说已定案或解释所有模型失败。需要修目录资格与原生模型registry一致性，优先原生发现/注册接口，不用盲目新增所有ID绕过能力验证。当前Runner把非白名单错误统一AGENT_TURN_INCOMPLETE，须增加安全分类以便产品诊断。

## 本轮主线新增（尚未新冻结）

1. 图片理解 r15：`native-image-message.mjs` 复用 DSH admitEncodedImages/AttachmentStore/ImageBlock；服务器租户/SHA重验、独立图片资格、热会话+冷历史重放。真实PT数量/颜色手动→AUTO→冷重建 PASS，OCR R7K2被识别RTK2保留INCOMPLETE；不代表全面OCR/音视频理解。
2. DOCX：新增 `office-zip-guard.cjs`、`office-document-worker.cjs`、`office-document-parser.cjs`，Mammoth1.13.0/fflate0.8.3显式锁定依赖。20MiB输入、64MiB展开、512ZIP项、最多2worker、超时取消；server docsToNote改async，上传20MiB、原文件/SHA/租户边界、提取块与截断覆盖，前端允许docx。不要假称物理页码。worker/text原有回归通过，最终记录 `docx-input-20261030.log` 曾被沙箱EPERM失败覆盖，不能引用它为通过；后续非沙箱HTTP+严格索引2/2已真实通过但仅工具输出。
3. DOCX索引 Gemini原候选校验缺哈希或篡改仍可通过；保留原件，新增 `shell/attachments/docx-evidence-index.cjs` 严格要求当前hash/version并重建对比全部派生字段，测试 `docx-evidence-index-main-review-test.mjs` 联合原候选5/5。server已调用build索引并在sources写coverageHash，字符单位明确UTF16、块无分隔拼接；尚无跨文件检索/引用UI/持久索引产品闭环。
4. 前端 `app.js`：目录请求失败不再静默永久“正在同步”；modelLoadFailed状态、明确失败、下一次发送仅重试目录，成功后提示再次发送，不自动付费聊天。`ui-model-switch-test.mjs` 50/50通过。未冻结部署，不代表线上已修。
5. Linux DOCX依赖：第一次缺vendor包失败保留；补齐后日志 `evidence/docx-linux-install-20261030-r2.log` PASS，Node22.23.4 linux/x64，495生产包/31007文件，lockSHA44a717ad738446f9ce4298cebd2f8c495d938aa7468d9fccef5c7d3793669cc9。新manifest在 `/private/tmp/northstar-docx-linux-poaesp3q/dependency-closure-docx.json`，尚未整合下一候选。不存在仍需等待的安装任务。

## Gemini状态

- 推理R1、上下文R1完成，但主审 `evidence/GEMINI-DSH-NATIVE-PACKAGES-MAIN-REVIEW-20261030.md`：R1猜reasoning档位、重写hooks；context重复计普通聊天预算、真实session归属未证、探针手动stream不等于原生压缩。未接生产。
- 推理R2 `GEMINI-DSH-REASONING-R2-PACKAGE-20261030.md` 用户确认四文件完成；独立4/4测试通过，尚未完成源码主审/真实探针复跑/主线UI→Run→Runner。候选import写死 `../../shell/node_modules/...`，在生成profile不可直接复用，应改受支持包导入的主审叠加；还要检查map/filter在数量上限前执行等资源边界。不得直接宣称可上线。
- DOCX索引任务已完成，原4/4+真实探针独立通过；报告声称Mammoth1.8/fflate0.8.2与实际1.13/0.8.3不符，需纠正证据；严格包装及接入见上。
- **最新可转交/待交付**：`GEMINI-DSH-CONTEXT-R2-PACKAGE-20261030.md`，四独占新增文件，真实原生自动/手动压缩、与现有agent/request组合预算恰好一次、取消/双会话/审计。尚未收到用户确认转交或完成，不读取临时中间文件当交付。

## 发布边界

r14确切archiveSHA `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`；可用handoff-r3 ZIP SHA `1782eb26006de82a28d26c94c8fa9a5991d71eab12643ffacdac7db891f54ff6`，r1/r2是历史勿部署。
r15 draft SHA `b9ee729f7138f61bd3e0d247b7fe006ebf88bd1e5b511e609ffe25f735c2db67`，187源码/388成员，冻结时build/audit、确切tar Linux closure472/30091及图片业务10/10通过。之后DOCX/前端新源码使r15不能由当前树重建；不得覆盖旧包。`current-draft.json`仍r15，下一步需新r16 builder，加入Office/索引模块，替换冻结包内closure为新manifest，再完整包独立审核/干净Linux验证。当前生产r14不含上述新功能。

## 新对话第一步

检查Git与本文件涉及源码，不重扫整个大仓或输出所有未跟踪文件；继续 UNKNOWN_MODEL/原生模型registry与安全错误分类修复，等待运维最新版JSON和媒体模型scope/revision。并行主审推理R2、收口DOCX依赖与下一次不可变冻结。用户无需重复授权常规开发；真实上线变更由已有运维流程执行，保留回滚与证据。不要把文档/候选通过等同于可用Agent整体交付。
