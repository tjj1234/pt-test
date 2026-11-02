# 文档导出候选模块交付报告（Word / PDF / Excel）（2026-10-26）

**结论：已独立完成支持 Word (.docx)、Excel (.xlsx)、PDF (.pdf) 三种格式的结构化文档导出候选模块及专项回归测试套件。8 组集成与安全测试全绿通过（覆盖真实有效性、严格 Fail-Closed 列数校验、资源边界超限拦截、Excel 公式注入防御、多页自动分页与零可执行内容）。本模块为隔离生成候选，未接入产品对话流程或 Run，不宣称任何业务功能已完成。**

---

## 1. 交付文件清单

| 文件路径 | 变更类型 | 核心职责 |
|---|---|---|
| `shell/exports/document-export-candidate.cjs` | 新建模块 | 纯函数导出入口 `exportDocumentCandidate`，提供结构化数据校验、资源上限保护、公式注入转义与多格式生成 |
| `tests/regression/docexport-candidate-test.mjs` | 新建测试 | 覆盖三种格式开合有效性、行列不匹配拒收、边界超限、公式注入专项与多页 PDF 渲染（8/8 PASS） |
| `docs/refactor/evidence/DOCEXPORT-candidate-gemini-20261026.md` | 新建报告 | 依赖库选型审查、契约规范、测试结果与未接线边界说明 |

---

## 2. 依赖库选型与许可证审查

按照任务包“宽松许可证、无系统编译依赖、纯 JS、持续维护”的原则，本次实现选用的依赖如下：

| 库名称 | 实际加载路径 / 版本 | 许可证 | 架构属性 | 选型理由 |
|---|---|---|---|---|
| **xlsx** (SheetJS) | `analytics/node_modules/xlsx`<br>版本：`0.18.5` | **Apache-2.0** | 100% 纯 JS，无任何 C++ 绑定 | 仓库既有依赖，成熟稳定，原生支持 XLSX 二进制工作簿生成与解析校验 |
| **fflate** | `shell/node_modules/fflate`<br>版本：`0.8.3` | **MIT** | 100% 纯 JS，零系统级编译依赖 | 仓库既有依赖，极高性能 ZIP/Deflate 压缩，用于生成符合 ISO/IEC 29500-1 标准的 Word (.docx) OPC 包 |
| **PDF 引擎** | 本地纯 JS 原生构建 | **MIT**（本项目代码） | 零外部依赖，Node 原生 Buffer 与流操作 | 按 ISO 32000-1 规范直接输出标准 PDF-1.4，杜绝外部庞大二进制或无维护库风险 |

* **复核结论**：全量库均采用 **MIT / Apache-2.0** 宽松许可证，绝对无 GPL 类传染性协议；无任何 `node-gyp`、Python 或本地编译依赖，确保目标机与容器干净环境直接可用。

---

## 3. 核心契约与安全机制

### 3.1 结构化输入与格式定义
模块严格接收结构化数据，不负责从非结构化文本反推：
```javascript
{
  title: "Q3 增长报告",           // 必填非空字符串
  author: "北极星 Agent",         // 可选字符串
  date: "2026-10-26",             // 可选字符串
  sections: [                     // 可选章节数组
    {
      heading: "渠道概览",        // 可选小节标题
      paragraphs: ["段落内容..."], // 可选段落数组
      table: {                    // 可选表格
        headers: ["渠道", "消耗"],
        rows: [["Meta", 5000]]
      }
    }
  ],
  table: { ... }                  // 可选顶层表格
}
```

### 3.2 严格 Fail-Closed（拒绝“半成品”文件）
1. **必填校验**：标题缺失或为空时直接拒绝（`DOC_TITLE_REQUIRED`）。
2. **表格列数一致性强校验**：
   * 每一个数据行的列数必须与 `headers.length` 完全相等。
   * 遇到任意一行列数不一致，立即拒绝并抛出 `DOC_TABLE_ROW_LENGTH_MISMATCH`（例如：`Table row 2 has 2 columns, expected 4`），**绝对不生成缺列漏列的文件**。

### 3.3 资源上限与防挂死保护
支持配置并具备硬上限（超出硬上限或传入非法参数直接拒绝 `DOC_OPTION_INVALID` / `DOC_OPTION_EXCEEDS_CEILING`）：
* `maxRows`：默认 10,000，硬上限 50,000（超限抛出 `DOC_ROWS_LIMIT_EXCEEDED`）；
* `maxCells`：默认 100,000，硬上限 500,000（超限抛出 `DOC_CELLS_LIMIT_EXCEEDED`）；
* `maxBytes`：默认 20MB，硬上限 50MB（生成结果超限抛出 `DOC_BYTES_LIMIT_EXCEEDED`）；
* `timeoutMs`：默认 30,000ms，硬上限 300,000ms（超限中断抛出 `DOC_TIMEOUT`）。

### 3.4 电子表格公式注入防御（Formula Injection Mitigation）
* **风险防范**：任何写入 Excel 单元格的字符串，若匹配 `/^[\s\uFEFF]*[=+\-@\t\r]/`，均自动在首位补充单引号 `'`（例如 `=cmd|' /C calc'!A0` 转换为 `'=cmd|' /C calc'!A0`），确保 Excel 打开时作为纯文本呈现，绝不执行外部系统命令或恶意宏。
* **降级显式通报**：所有被转义的单元格均记录于返回对象的 `degradations` 数组中（含坐标与原前缀），让下游明确知晓处理事实。
* **真实数值不受影响**：原生数字（如 `-99`）不受字符串转义影响，保持数值类型。

### 3.5 零可执行内容与宏消除
* **Word (.docx)**：严格输出 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，不包含 `vbaProject.bin`，不生成 `.docm`。
* **Excel (.xlsx)**：严格输出纯静态数据工作簿，不含 VBA 代码与宏工程。
* **PDF (.pdf)**：纯静态矢量与排版输出，绝无 `/JavaScript`、`/JS`、`/Launch`、`/EmbeddedFiles` 或外部动作流。

### 3.6 输出真实有效性验证
* **Word**：解包验证包含 `[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、`styles.xml`、`settings.xml`，可在 Microsoft Word、WPS、Pages 中正常打开。
* **Excel**：经 `XLSX.read` 内存反读，工作表名称、表头、单元格数值与行数 100% 吻合。
* **PDF**：按 ISO 32000-1 规范包含完整的 Catalog、Pages、Helvetica 字体资源、正文流、交叉引用表（xref）与 trailer，且支持长内容跨页自动分页。

---

## 4. 验收命令与执行结果

1. **测试套件运行**：
   ```bash
   node --test tests/regression/docexport-candidate-test.mjs
   ```
   * **结果**：
     ```text
     ✔ 1. Word (.docx) 生成真实有效性与结构完整性 (5.383667ms)
     ✔ 2. Excel (.xlsx) 生成真实有效性与表格反读验证 (7.191667ms)
     ✔ 3. PDF (.pdf) 生成真实有效性与 ISO 32000-1 规范校验 (0.330583ms)
     ✔ 4. PDF 分页机制与多页渲染验证 (0.187875ms)
     ✔ 5. 严格 Fail-Closed：数据缺失与字段异常校验 (0.228458ms)
     ✔ 6. 资源边界控制：行数、单元格数、文件大小与参数越界 (0.697167ms)
     ✔ 7. 专项测试：Excel 公式注入防御（CSV/Spreadsheet Formula Injection） (1.770917ms)
     ✔ 8. 顶层独立表格与空值/Null 容错测试 (1.144833ms)
     ℹ tests 8
     ℹ suites 0
     ℹ pass 8
     ℹ fail 0
     ℹ duration_ms 100.74ms
     ```

2. **语法检查**：
   ```bash
   node --check shell/exports/document-export-candidate.cjs
   ```
   * **结果**：退出码 0，无语法错误。

3. **Git 空白符门禁**：
   ```bash
   git diff --check shell/exports/document-export-candidate.cjs tests/regression/docexport-candidate-test.mjs docs/refactor/evidence/DOCEXPORT-candidate-gemini-20261026.md
   ```
   * **结果**：退出码 0，无格式违规。

---

## 5. 后续接入前置条件与边界说明（交由主 Agent 裁定）

1. **生成触发者与时序**：
   * 本模块为纯文档构建器，不自行发起任务。后续可由 Agent 工具调用帧（如 `document_export` 工具）或用户在看板上点击“导出报告”触发。
2. **产物落盘与 Run 资产绑定**：
   * 导出的文件 Buffer 如何进入租户安全存储目录（例如 `runtime/workspaces/ws_<tenantId>/artifacts/`）及写入 `artifacts` 元数据表，需主 Agent 统一接入。
3. **鉴权下载与内容安全**：
   * 前端下载时需对接带租户鉴权的只读下载路由（如 `GET /api/artifacts/:id/download`），响应头配置正确的 MIME 与 `Content-Disposition: attachment; filename="..."`。
