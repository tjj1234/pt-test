# Gemini 单任务包：结构化文档导出输入门禁候选

目标：为后续 Word/PDF/Excel 报告导出做一个独立、纯函数、可审阅的输入校验候选。当前 `document-export-candidate.cjs` 已有行/单元格数量上限，但未覆盖标题、段落、表头、单元格字符串总量；本包仅补该缺口，不改生成器或产品接线。

**文件独占边界：只新建以下三个文件，不编辑任何现有文件或其他 Agent 正在修改的文件。**

1. `shell/exports/document-input-guard-candidate.cjs`：导出 `guardStructuredDocumentInput(value, limits?)`。接收 `{title, author?, date?, sections?, table?}`；校验纯 JSON 结构、未知字段、字符串与有限数字/null 类型，拒绝 getter、Proxy 异常、循环引用和共享可变对象；限制总 UTF-8 输入字节数、单字段 Unicode code point 数、章节数、表格数、行数、单元格数、列数及嵌套深度，所有边界可配置且有不可突破硬上限。返回深冻结的规范化副本及只含计数的诊断，不回显用户单元格内容或文件路径。任一问题 fail closed，稳定错误 code；避免先复制超大输入后才统计。
2. `tests/regression/docexport-input-guard-candidate-test.mjs`：覆盖边界值、中文与 emoji UTF-8 字节计数、极长无表格段落、非有限数、公式样字符串保留为文本、缺列、未知字段、循环/共享对象、getter 与 Proxy 抛错、错误脱敏、冻结副本和输入不变。
3. `docs/refactor/evidence/DOCEXPORT-input-guard-gemini-20261026.md`：记录接口、默认/硬上限、测试原始结果、与现有 `document-export-candidate.cjs` 的未接线边界。

约束：不引入依赖、不发网络请求、不写文件、不执行导出、不猜测缺失数据，不改变 PDF/XLSX/Word 代码。`timeoutMs` 的可中止执行和 PDF 中文字体不在本包内；不得宣称三格式产品功能已经交付。完成后只交付上述三个新文件与定向测试结果，主 Agent 再审阅接线。
