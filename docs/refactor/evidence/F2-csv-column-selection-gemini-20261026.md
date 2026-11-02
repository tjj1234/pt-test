# F2 CSV 列选择与类型证据候选模块交付报告（2026-10-26）

**结论：已独立完成「不可变 CSV Source + 显式用户选择 { headerRow, startRow, column } → 受控列选择预览与类型证据诊断」的纯函数隔离候选模块及定向回归测试套件。16 项测试全部通过（覆盖表头分离、首行数据、稀疏行、空值与零区分、重复行、前导零、模糊日期、区域分组歧义、超长截断、越界与伪造 source 等）。本模块为隔离候选，未修改既有代码，未接入生产入口，不宣称 F2 交付完成。**

---

## 1. 交付文件清单

| 文件路径 | 职责 | 依赖与隔离 |
|---|---|---|
| `shell/attachments/csv-column-selection-candidate.cjs` | 显式列选择与类型证据诊断纯函数 `selectCsvColumn` 与有界上下文渲染函数 `renderCsvColumnSelection` | 仅读取既有 `csv-source.cjs`，零第三方外部依赖 |
| `tests/regression/f2-csv-column-selection-candidate-test.mjs` | 定向回归测试套件（16/16 PASS） | `node:test`, `node:assert/strict`，纯内存 CSV 源 |
| `docs/refactor/evidence/F2-csv-column-selection-gemini-20261026.md` | 契约规格、测试证据与未接线边界报告 | — |

---

## 2. 输入输出契约规格

### 2.1 输入契约
1. **`source`**：必须是由 `buildCsvSource` 创建并通过 `assertCsvSource(source)` 校验的不可变源对象。伪造对象或经 `structuredClone` 克隆的对象直接拒绝（`CSV_SOURCE_INVALID`）。
2. **`selection`**：必须为显式对象，包含：
   * `headerRow`：`null`（无表头）或 1-based 正整数。若指定表头，严格要求 `headerRow < startRow` 且 `headerRow <= source.rows.length`；
   * `startRow`：1-based 正整数，且 `startRow <= source.rows.length`（空数据区间强拒 `CSV_SELECTION_OUT_OF_BOUNDS`）；
   * `column`：1-based 正整数，且**必须在数据区间（startRow 至末行）至少出现一次**（不在任何数据行出现强拒 `CSV_SELECTION_COLUMN_OUT_OF_BOUNDS`）。
3. **拒绝隐式回退**：严禁静默默认第一列或第一行。

### 2.2 核心处理与类型规则
1. **表头严格隔离**：
   * `headerRow` 单元格仅作为 `columnLabel` 的显示来源（若表头单元格缺失或纯空白，回退为 `C<n>` 且 `labelSource: 'index'`）；
   * 表头单元格**绝不计入**数据区间扫描、类型判断、样本抽取或后续运算。
2. **数据区间严格扫描**：
   * 仅扫描 `[startRow, source.rows.length]`；
   * **严格区分三类状态**：
     * `missing`：稀疏行中不存在该列（`column > row.length`）；
     * `empty`：单元格存在但值为空字符串 `""`；
     * `nonempty`：单元格存在且 `value !== ""`（包含数值零 `"0"`，被确认为 `decimal`）。
3. **保守类型与原因诊断**：
   * `decimal`：无歧义的标准十进制数（不允许无小数点的多前导零如 `001`，不允许千分位歧义形态）；
   * `iso_date`：符合 YYYY-MM-DD 的合法公历日期（含闰年 2024-02-29 判定）；
   * `ambiguous_date`：斜杠日期（如 `01/02/2024`，月/日未知）；
   * `ambiguous_grouping`：常见区域千分位分组形态（如 `1.234`、`12.345`，匹配 `AMBIGUOUS_DOT_GROUPING`）；
   * `mixed`：数据区间出现多种不同类型（如数值与日期混杂，或数值与普通文本混杂）；
   * `untyped_text`：前导零编号（如 `001`）、非法日期（如 `2024-02-30`）或常规文本；
   * `empty`：数据区间所有单元格全为空字符串或缺失。
4. **样本截断与错误脱敏**：
   * 样本最多抽取 3 个非空单元格，每个样本设 80 代码点（codepoint）上限，记录完整坐标 `{ row, column, sourceLine, sourceColumn, value, truncated }`；
   * 抛出的错误信息仅描述坐标或参数违规，**绝不回显原始单元格值、文件上传路径或敏感数据**。
   * 纯诊断输出，**不执行任何单元格数值转换或导出类型授权**。

---

## 3. 验收命令与执行结果

1. **测试套件运行**：
   ```bash
   node --test tests/regression/f2-csv-column-selection-candidate-test.mjs
   ```
   * **结果**：
     ```text
     ✔ 1. 表头与无表头选择：表头仅作标签，不参与数据区间运算 (1.640541ms)
     ✔ 2. 首行即数据：headerRow: null, startRow: 1 纯数据列判定 (0.108ms)
     ✔ 3. 稀疏行（ragged rows）与列存在性 (0.286458ms)
     ✔ 4. 空值、缺失与零严格区分 (0.52025ms)
     ✔ 5. 重复行与坐标定位 (0.10825ms)
     ✔ 6. 前导零编号保持 text，不误判为 decimal (0.126375ms)
     ✔ 7. 日期判定：有效 ISO 日期 vs 模糊斜杠日期 vs 无效日期 (0.103834ms)
     ✔ 8. 区域千分位数字歧义（ambiguous grouping）保持 text (0.0635ms)
     ✔ 9. 混合列（mixed types） (0.082833ms)
     ✔ 10. 多行引号单元格（multiline quoted cells） (0.180083ms)
     ✔ 11. 超长样本截断保护（MAX_SAMPLE_CODEPOINTS: 80） (0.183042ms)
     ✔ 12. 非法选择参数校验与错误脱敏 (0.229708ms)
     ✔ 13. 越界与空数据区间 (0.078875ms)
     ✔ 14. 伪造或未认证 source 拒绝 (0.087958ms)
     ✔ 15. 错误消息安全性：不回显单元格数据或文件路径 (0.048833ms)
     ✔ 16. renderCsvColumnSelection 上下文渲染与预算控制 (0.157583ms)
     ℹ tests 16
     ℹ suites 0
     ℹ pass 16
     ℹ fail 0
     ℹ duration_ms 38.68ms
     ```

2. **语法检查**：
   ```bash
   node --check shell/attachments/csv-column-selection-candidate.cjs
   ```
   * **结果**：退出码 0，无语法错误。

3. **空白与格式门禁**：
   ```bash
   git diff --check shell/attachments/csv-column-selection-candidate.cjs tests/regression/f2-csv-column-selection-candidate-test.mjs docs/refactor/evidence/F2-csv-column-selection-gemini-20261026.md
   ```
   * **结果**：退出码 0，无格式违规。

4. **既有 CSV 测试回归验证**：
   ```bash
   node --test tests/regression/csv-column-profile-test.mjs tests/regression/csv-analysis-test.mjs
   ```
   * **结果**：13/13 PASS，既有模块零退化。

---

## 4. 剩余缺口与未接线边界说明

1. **纯函数候选，尚未接入服务端 API 与 UI**：
   * 本模块为纯函数数据诊断层，尚未连接 `server.cjs` 的上传预览路由（如用户在上传 CSV 后请求列预览与起始行确认的接口）。
2. **下游分析与导出适配接线边界**：
   * 用户显式选择确认后，下游执行计算由 Codex 子 Agent 负责的 `shell/tasks/csv-analysis-adapter.cjs` 驱动；结果导出文件由 `shell/exports/csv-analysis-result-candidate.cjs` 承接。
   * 本模块不直接触发计算任务或文件下载，各模块之间的编排由主 Agent 在整体集成时统一接线。
