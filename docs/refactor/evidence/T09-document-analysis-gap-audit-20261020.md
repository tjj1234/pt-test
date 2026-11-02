# T09 document analysis gap audit — 2026-10-20

**结论：** 聊天文档路径目前支持 `.txt`、`.md`、`.csv`，CSV 具备来源身份、单元格坐标、上下文限额和历史快照保护的局部实现与回归证据。它没有证明模型答案引用正确，也没有普通聊天中的确定性表格计算器。任务包列出的 Office/PDF/OCR/ZIP 格式和其余验收场景仍未闭环；T09 保持 `partial`，AC10、AC21 保持 `untested`。本次只读盘点，未运行测试或修改代码。

## 聊天附件与 CSV 已有覆盖

`shell/server.cjs:163–166` 将文档路径定义为纯文本 v1，白名单仅 `txt/md/csv`，上传上限默认为 5 MiB，默认上下文上限为 100,000 字符；上传处理在 `server.cjs:1738–1773` 做扩展名、字节大小、严格文本解码检查，并对 CSV 解析错误明确拒绝。前端白名单同样仅含这三种扩展（`shell/public/app.js:1348–1353`）。

CSV parser 保留原始字符串值、空值、`0`、重复行及 quoted multiline 的逻辑/物理坐标；parser 默认安全上限包括 20 MiB、100,000 行与单元格，但产品上传 5 MiB 上限更早生效（`shell/attachments/csv-parser.cjs:3–10`）。`csv-source.cjs:8–18, 34–63` 以原字节 hash、tenant upload ref、行列坐标构造不可伪造的来源文本，只输出完整单元格前缀并说明覆盖/截断；它明确不推断表头、类型或数值语义。

`server.cjs:319–378` 在当前租户作用域读取文档，检查 realpath、symlink、打开文件 inode/大小及内容快照；普通文本注入正文，CSV 则注入带 hash/ref hash/坐标的字面单元格。历史用户消息保存 `documentEvidence`，regen/branch 复用原快照；变更或缺少旧快照会在历史写入和 runner 调用前拒绝（`server.cjs:562–572`，以及工作区已记录的 CSV HTTP 回归）。

现有局部验证记录见 [`T09-csv-source-20261019.md`](T09-csv-source-20261019.md)：parser/source 合计 14/14 PASS，受控本地 HTTP/PGlite 路径 1/1 PASS。HTTP fixture 使用合成 CSV 字节，通过真实本地上传/聊天 handler，并由 dry-run tenant 捕获上下文；覆盖空值与 `0`、原字节保留、来源坐标/截断、坏 CSV、跨租户、未变文件 regen、变更文件 regen/branch 拒绝及历史不变。该结果不是真实用户文档样本或真实模型问答验收，也没有证明模型回答遵从或正确引用这些来源。

CSV 来源目前用于模型上下文与 `attachment.status` 元数据；消息 UI 只显示“附带 N 个文档”（`shell/public/app.js:481–487`），没有可点击的来源定位 UI。哈希、坐标和来源 token 是输入来源元数据，不是对答案事实或引用正确性的核验。

## 尚无证据的任务包范围

任务包 v2.0 T09（`docs/北极星一期生产级重构完整任务包-v2.0.md:286–294`）列出 XLS/XLSX、PDF（含扫描件）、DOC/DOCX、PPT/PPTX、ZIP；要求页码/标题/段落/sheet/行列定位、跨文件比较、后续追问、OCR 失败提示、长文档覆盖范围披露、受控确定性计算、解压后资源限制、宏/脚本不执行，以及删除后不再引用失效资料。当前聊天附件白名单和 `docsToNote` 路径没有这些格式的解析器、OCR、文档索引/跨文件检索或计算工具。

仓库另有 `business/attribution/parsers/tabular.js` 的 CSV/XLSX 解析与 X 广告导入 fixture（`tests/attribution/a15-a16-country-join-import.test.js:71–82`）。这是广告数据导入/多 sheet join 路径，不进入聊天文档问答上下文，不能算作 T09 的 Office 文档解析验收。当前回归未覆盖通用 XLS/XLSX 聊天附件、PDF/OCR、DOC/PPT、ZIP 炸弹/部分失败、宏/内嵌脚本、恶意指令隔离、跨文档不混源、golden 表计算、答案引用可点击性或删除后派生数据不可检索。

AC10 仍要求每种约定格式真实样本、跨文件引用与确定性计算标准答案（`docs/refactor/ACCEPTANCE-STATUS-20261018.md:84`）；AC21 仍要求扩展格式/ZIP 安全、部分失败和原文件/派生数据删除证明（同文件 `:95`）。当前 CSV evidence 仅支持附件/来源子范围结论，不能改变 T09 `partial` 或 AC10/AC21 `untested` 状态。

## deadline 前最小高价值切片

若只再做一个窄切片，优先限定 CSV：提供含空值与字符串零、重复、多单位/日期的 golden 表，使用受控确定性计算工具得出精确答案，并为每个输入/结果给出可定位单元格来源；通过现有上传/HTTP 路径用合成数据验证，不调用付费模型。此切片只补 CSV 计算/来源子范围，不覆盖 Office/PDF/ZIP，不证明跨文件能力或完整 T09；若没有时间接入计算器，应保留当前状态并如实报告缺口。
