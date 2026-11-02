# Gemini 独立任务包：F2 CSV 列选择与类型证据（2026-10-26）

**任务边界：只交付可审阅的隔离候选，不接生产入口。一次只做本包。** F2 用户流程要求上传 CSV 后先看到“列名｜样本值｜判定类型”，再显式选择计算列和数据起始行。现有 `csv-column-profile.cjs` 对全文件给出诊断，但不能表达“第几行是表头、从第几行开始计算”的显式选择。请为这一步建立独立契约，不推断表头或日期语义。

## 文件独占

只允许**新建**以下三个文件，不改任何现有文件：

| 文件 | 产出 |
|---|---|
| `shell/attachments/csv-column-selection-candidate.cjs` | 纯函数候选；可读取现有 `csv-source.cjs` 与 `csv-column-profile.cjs`，不得修改它们 |
| `tests/regression/f2-csv-column-selection-candidate-test.mjs` | 本候选的定向回归 |
| `docs/refactor/evidence/F2-csv-column-selection-gemini-20261026.md` | 契约、测试证据、剩余缺口 |

主 Agent 独占共享 `server.cjs`、runner、UI、工具注册和整体验收；两个 Codex 子 Agent 分别独占 `shell/tasks/csv-analysis-adapter.cjs` 与 `shell/exports/csv-analysis-result-candidate.cjs` 及各自测试。不要触碰这些文件，不要启动真实 PT 请求，不要使用聊天中提供的 Key，不要提交/推送/部署。

## 输入输出契约

候选接收由 `buildCsvSource` 产生且通过 `assertCsvSource` 的不可变来源，以及用户**显式**给出的 `{ headerRow, startRow, column }`。`headerRow` 可以是 `null`（无表头）或正整数；`startRow` 与 `column` 必须是 1-based 正整数。若指定表头，要求 `headerRow < startRow`；表头单元格只作显示标签，绝不作运算输入。列必须在至少一个数据行中出现；缺失单元格、空字符串和数字零严格区分。拒绝越界、空数据区间、非法选择，不静默选择第一列或第一行。

输出是有限、可序列化的选择预览：明确 `source.sha256`、显式选择坐标、列标签来源（表头或 `C<n>`）、最多三个带 `R/C/sourceLine/sourceColumn` 的样本，以及对**所选数据区间**全量扫描后的证据类型与原因。建议复用既有 `profileCsvColumns` 的类型规则，但它当前对全文件扫描且含表头；若复用不合适，可在新文件中实现同等保守规则并说明差异。有效 ISO 日期可标 `iso_date`，斜杠日期、混合类型、前导零编号及区域分隔符有歧义时都保持 `text`；不得把类型证据转成单元格转换或导出类型授权。样本值设字符上限，错误消息不回显原始单元格、上传路径或敏感值。

## 验收与报告

覆盖表头/无表头、首行数据、稀疏行、空值与零、重复行、前导零、模糊日期、混合列、多行引号单元格、超长样本、无效/越界选择及伪造 source。运行 `node --test tests/regression/f2-csv-column-selection-candidate-test.mjs`、`node --check shell/attachments/csv-column-selection-candidate.cjs`、`git diff --check`。报告精确测试数量、失败数与未接线边界；不要将候选测试称为 F2 完成交付。
