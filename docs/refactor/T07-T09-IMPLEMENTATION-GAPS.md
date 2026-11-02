# T07–T09 实现差距与最小切片

**状态：静态映射；T07、T08、T09 均不得据此标为 PASS。** 本文按任务包 v2.0 的范围、依赖和验收逐项对照当前可见源码；上传接口、能力字段、提示词或模块测试都不等于真实模型理解与产品验收。

## 任务包约束

| 任务 | 依赖与顺序 | 必须交付的行为 | 关键验收 |
|---|---|---|---|
| T07 AUTO 与模型切换（v2.0 §8，约 266–275 行） | T03、T06；多模态完整验收还依赖 T08、T09。先验文本路由，再验完整 AUTO。 | 以请求、附件、任务所需能力路由；先过滤能力、权限、适配、可用性和预算；手动选择不静默换模型；偏好绑定对话，用户偏好只作新对话默认；热切换下一轮生效，不重复历史工具。 | AC01 新用户真实进入 AUTO；AC05 热会话 X→Y 的实际请求确为 Y、历史/附件保留、日志一致；T07 验收 ⑥ requested/resolved/上游模型分别记录，未知不能伪造。 |
| T08 多模态理解（约 276–285 行） | T03、T05、T06；接入统一 Attachment。 | 图片/OCR/图表，多图；音频原生理解或 ASR 时间戳；视频原生理解或抽帧及音轨分析；受控文件引用、进度、失败、超限与保留策略。 | AC08/09；真实素材答案正确，时间戳和视频采样边界可回查；同轮多附件不串、后续可追问；至少一条 PT 真实图片、音频、视频理解链路通过；某类无端点要明确阻塞。 |
| T09 文档检索与表格（约 286–297 行） | T03、T05、T06；附件/引用契约共用 T08/T10，不另建上传和权限系统。 | TXT/MD/CSV/XLS/XLSX/PDF（含扫描）/DOC/DOCX/PPT/PPTX/ZIP；解析保留页码、标题/段落、sheet/行列；按规模检索；跨文档比较；表格用确定性计算并保留公式来源；限制解压/页数/单元格/时长，宏不执行。 | AC10/21；每种格式真实样本、引用可回原位置、跨文件来源不混、含空值/重复/单位的标准答案精确、删除后派生索引不再引用、超限/错误不伪装已读取。 |

任务包还规定共享文件由单一集成人接线：`server.cjs`、`tenant.cjs`、`persistent-runner.mjs`、`public/app.js` 等是共享接缝；模型目录复用现有 `model-catalog` 与 T06 能力契约；附件/产物共用一个 Attachment/Artifact 契约。批次上 T07/T08/T09 属于批 3（任务包约 548–555 行），依赖接线应在 T03/T05/T06 契约可用后推进，而非三支各自建立目录或权限体系。

## 当前可复用实现与实际缺口

| 领域 | 现有基础（可复用） | 尚未满足的部分 |
|---|---|---|
| 模型能力/T06 | `shell/models/capabilities.cjs:4-7,30-70` 已表达 text/image/audio/video 任务、模态、来源、权限、local policy、adapter 与 verification；unknown 不授予资格。`shell/model-catalog.cjs:234-253` 有基于文本关键词的 AUTO 初版，`server.cjs:463-490` 对 AUTO/手动执行资格再校验。 | `routeModelFor` 仍以代码/长文/推理关键词和候选名称作文本规则；尚未根据附件/步骤任务选择 image/audio/video understanding 或生成任务，也没有在路由决策中验证预算/质量/延迟策略。能力 schema 存在不表示模型端点已验证或可用。 |
| 用户选择与切换 | `/api/models` 新用户当前返回 AUTO；`persistent-runner.mjs:292-298` 每轮更新热 session 的 selection，`dsh-adapter.cjs:785` 把选定模型写入 task frame。 | 选择状态实际存为用户 `$model`：`memory.cjs:65-80`，而 `server.cjs:465,1610-1638` 对所有对话读取/写入同一用户偏好；不满足“按对话绑定、用户值只作为新对话默认”。热切换代码路径可复用，但仍需在真实请求端点和 AC05 中独立验收；当前实现没有本文件可引用的 T07 验收证据。 |
| 图片输入 | `server.cjs:1641` 起有图片上传；`chat-request.cjs:24-57,115-169` 对 durable 上传引用作租户、symlink、realpath、文件变化和 hash 校验；`server.cjs:311-321,632-645` 将图片转 data URL 并构造生成提示。 | 图片被放入用户消息和 prompt 提示，但当前可见 DSH `runDshForUser` 将 `question`/文本提示传入 runtime（`tenant.cjs:218-242`），persistent runner 发送文本 content（`persistent-runner.mjs:597`）；没有在可见主对话路径把 image 内容作为多模态模型输入，也没有 OCR/图表定位证据。不能把 image-to-image 生成输入当图片理解。 |
| 音频/视频输入 | `/api/upload-media` 依据魔数识别 mp4/webm/mov/mp3/wav/m4a，按租户存储并限大小（`server.cjs:1769-1804`）；UI 上传和播放器已接入（`public/app.js:1420-1428,1730-1771`、`public/chat-media.js:120-165`）。 | `/api/chat` 只将媒体 URL/类型归档，系统提示明确告诉模型不能解析内容（`server.cjs:511-529,653-659`）；没有原生理解/ASR/抽帧、时间戳/采样覆盖记录，也没有受控供应商文件引用。上传与播放器不满足 T08。 |
| 文本文档 | `/api/upload-doc` 仅收 `.txt/.md/.csv`、UTF-8、5MB（`server.cjs:1723-1767`）；`docsToNote` 将纯文本直接加入上下文并受字符上限限制（`server.cjs:362-390,647-650`）；durable attachment hash 校验可为后续复用。 | 无 PDF/OCR、Office、ZIP、跨文件检索、来源定位和可点击引用；对无法解码/读取的文档，`docsToNote` 会跳过（`server.cjs:371-377`），可能把错误表现成缺少上下文。暂无解析结果、索引版本或删除清理契约。 |
| 表格 | `business/attribution/parsers/tabular.js:6-57,126-160` 有业务归因 CSV/XLSX 表格解析逻辑，可参考 CSV quoting、sheet→matrix 形状。 | 该解析器服务归因导入的 header/noise 规则，不是员工文档通用解析器；不提供单位/空值/重复值/公式来源的确定性分析契约，不可直接宣称满足 T09。`shell/package.json:13-39` 未列 XLS/XLSX、PDF、DOC、PPT、OCR、ZIP 专用解析器。 |
| 产物/附件基础 | `shell/runtime/artifacts.cjs:24-41,94-159` 可扫描 PDF/HTML/MD 产物并生成同源链接；durable chat attachments 有 T03 重放前 hash 验证。 | Artifact 扫描不是输入附件解析，也未形成用户文件版本/页码索引/派生内容删除路径；CSV/XLSX 和图像/音视频不是此预览清单。T10/Artifact 与 T08/T09 的引用关联仍需集成。 |

## 最小切片与文件范围

以下是可先做、可独立审阅的实现边界；完成一个切片不等于对应任务或 AC 通过。

| 优先级 | 最小切片 | 建议文件（按所有权拆分） | 通过边界 |
|---|---|---|---|
| 1 | T07 文本 AUTO：将候选选择规则提取为纯函数，输入是规范化能力/权限/适配/验证/预算快照；先保留仅 textChat 的范围，未知资格拒绝，手动选择不做静默回退。 | 新增 `shell/models/task-router.cjs` + 针对性纯逻辑测试；随后由唯一集成人接 `shell/model-catalog.cjs`、`shell/server.cjs`。 | 可证明候选过滤和拒绝边界；不能证明线上 DSH 真实模型切换。当前 `memory.cjs` 的用户级偏好须独立后续改为 conversation preference，至少涉及 `shell/db-migrations/018_conversation_model_preference.sql`、`shell/conversations.cjs`、`shell/server.cjs`、`shell/public/app.js`（migration 序号须由集成人复核）。 |
| 2 | T09 CSV 确定性解析基础：把无归因业务语义的 CSV tokenizer/行列来源抽为纯 parser，保留 source row/column，空值不转 0；先不接向量检索或上传 UI。 | 新增 `shell/attachments/csv-parser.cjs` + parser fixtures/测试。可参考但不可直接复用 `business/attribution/parsers/tabular.js` 的 CSV tokenizer；文件调用方和业务 header 推断保持隔离。 | 可独立覆盖逗号/引号/CRLF/空单元格/行列引用/损坏输入；不是 AC10 完成，后续需 XLS/XLSX、PDF/OCR、Office、ZIP、跨文档索引、权限/删除和 UI 接线。 |
| 3 | T08 真实图像理解 feasibility slice：先由 T00/T16 确认一个实际 DSH provider content contract 和 PT 可调用且有权限的 image-understanding endpoint，再做单图、单轮、受控文件引用的纵向闭环。 | 新的 `shell/runtime/multimodal-input.cjs`/provider adapter（契约验证后定名）+ 精简 fixture 测试；接线涉及唯一集成人维护的 `shell/server.cjs`、`shell/tenant.cjs`、`shell/runtime/dsh-adapter.cjs`、`shell/persistent-runner.mjs`、`shell/models/capabilities.cjs`。 | 只证明一个已确认 endpoint 的真实图像输入/失败语义和附件归属；未有真实素材答题证据前仍是 partial。音频、视频应作为后续独立片，不共用虚构的“多模态已支持”标记。 |
| 4 | T09 引用响应契约：先统一 parser 输出的文件版本与来源坐标（CSV 行列；后续 PDF 页、Office 段落/sheet）。 | 新增 `shell/attachments/source-locations.cjs` 或纳入 parser；接线后续在 `shell/tasks/chat-request.cjs`、`shell/server.cjs`、`shell/public/app.js`。 | 引用能稳定指回附件原始页/行列，并在附件版本变化时失效；不以模型自由文本声称来源。 |

CSV parser 当前纯函数接口为 `parseCsv(input, { limits }) -> { rows, bytes, cellCount }`；每个 cell 返回 `{ value, row, column, sourceLine, sourceColumn }`，空字段保留为空字符串，行列坐标从 1 开始。支持 UTF-8/BOM、quoted comma/newline、双引号转义及 LF/CRLF；输入字节数在解码前按默认或调用方更严格的 `maxBytes` 检查。该接口不推断 header/类型/数值，不接上传、检索或 UI；默认解析器上限不代表产品额度，仍需 fixtures、错误样本和调用方额度契约验证。

集成顺序：T03 的 Run 与附件 durable snapshot 已提供可复用接缝，但真实格式理解依赖 T05 的受控 executor/权限、T06 的任务能力证据和 T16 对 SDK 输入结构的验证。先做纯解析/路由模块可避免改共享文件；接线阶段由主集成人串行维护 `server.cjs`、`tenant.cjs`、runtime 与 UI，不让 T07/T08/T09 各建附件目录、credential 或权限状态。

## 不能据此宣称的结果

目前可见源码支持“文本 AUTO 初版”“模型能力元数据形状”“图片与音视频上传/展示”“TXT/MD/CSV 文本上下文”“文件产物预览”这些局部能力。它们不能证明 T07 的对话级偏好和实际模型请求端点、T08 的真实内容理解、T09 的格式矩阵/引用/计算/删除，也不能通过 AC05/07/08/09/10/21。任务包验收还要求受控真实素材与请求/来源证据；本次是静态盘点，不生成任何验收 PASS。


## 2026-10-19 增量状态（覆盖上文对应历史缺口）

T07已接conversation preference/migration018与UI上下文隔离；用户默认只作新对话初值，queued v3请求保存服务端模型选择。纯router已接catalog/server的权限/policy/可用性/适配门禁，目录fresh/backoff本地撤销即时生效。受控HTTP与UI独立通过，证据见`evidence/T07-conversation-model-20261019.md`；真实模型、上游身份和模型费用预算仍未闭环，不标T07或AC05整体通过。

T09 CSV parser/source模块独立14/14通过，server已接合法CSV上传校验与版本/行列来源上下文，明确完整cell截断与省略量。上下文错误前不改消息历史；原用户消息保存documentEvidence供再生/分岔复用，缺历史snapshot明确拒绝。仍缺XLS/XLSX、PDF/OCR、Office/ZIP、跨文件检索、计算/公式来源、答复引用校验、点击定位UI及派生索引删除闭环。CSV局部实现不等同AC10/21通过。
