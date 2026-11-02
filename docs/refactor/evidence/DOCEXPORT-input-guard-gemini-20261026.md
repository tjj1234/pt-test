# 结构化文档导出输入门禁候选交付报告（2026-10-26）

**结论：已独立完成结构化文档导出（Word / PDF / Excel）输入门禁候选模块 `guardStructuredDocumentInput`、专项回归测试套件与审计证据。13 组测试用例 100% 通过（覆盖边界值、中文与 Emoji UTF-8 字节/Code Point 增量统计、无表格长文、非有限数拦截、公式样字符串保留为纯文本、行列失配 Fail-Closed、未知字段拦截、循环/共享可变引用检测、Getter/Proxy 陷阱防御、错误信息脱敏、深冻结与入参不可变性）。本模块为隔离门禁候选，未接入现有 `document-export-candidate.cjs` 或业务流程，不宣称任何产品功能已上线。**

---

## 1. 交付文件清单

| 文件路径 | 变更类型 | 核心职责 |
|---|---|---|
| `shell/exports/document-input-guard-candidate.cjs` | 新建模块 | 纯函数输入校验门禁 `guardStructuredDocumentInput(value, limits?)`，提供增量 UTF-8 字节统计、Code Point 计数、原型与 Getter/Proxy 陷阱防护、Fail-Closed 校验与深冻结规范化副本 |
| `tests/regression/docexport-input-guard-candidate-test.mjs` | 新建测试 | 13 项全量专项回归测试，覆盖所有安全边界与异常防御（13/13 PASS） |
| `docs/refactor/evidence/DOCEXPORT-input-guard-gemini-20261026.md` | 新建报告 | 契约接口规范、默认上限与硬上限清单、原始测试结果、与 `document-export-candidate.cjs` 的未接线边界说明 |

---

## 2. 接口与资源上限规范

### 2.1 门禁入口函数签名
```typescript
function guardStructuredDocumentInput(
  value: unknown,
  limits?: Partial<DocumentInputLimits>
): {
  normalized: Readonly<StructuredDocument>;
  diagnostics: Readonly<DocumentDiagnostics>;
}
```

* **入参 `value`**：待导出的结构化对象，根级别仅允许 `{ title, author?, date?, sections?, table? }`。
* **出参 `normalized`**：深冻结（`Object.isFrozen` 递归生效）的规范化纯对象副本，原入参完全不被就地修改。
* **出参 `diagnostics`**：只含结构计数指标的冻结诊断对象：
  ```javascript
  {
    totalBytes: number,    // 增量统计的总 UTF-8 字节数 (含结构开销与内容)
    sectionCount: number,  // 校验通过的章节数
    tableCount: number,    // 顶层与各章节表格累计总数
    rowCount: number,      // 所有表格的数据行总数
    cellCount: number,     // 表头与数据行单元格累计总数
    maxDepth: number       // 遍历达到的最大嵌套深度
  }
  ```

### 2.2 默认资源边界与不可突破硬上限

所有边界支持在调用时自定义配置，但设有不可突破硬上限；若用户配置超过硬上限，门禁将直接抛出 `DOC_LIMIT_EXCEEDS_CEILING` 阻断：

| 配置项 (`limits` 键名) | 默认值 (`DEFAULT_INPUT_LIMITS`) | 不可突破硬上限 (`HARD_INPUT_LIMITS`) | 超限错误码 (`err.code`) | 说明 |
|---|---|---|---|---|
| `maxBytes` | 5,242,880 (5 MB) | 20,971,520 (20 MB) | `DOC_BYTES_LIMIT_EXCEEDED` | 总输入 UTF-8 字节数，边遍历边统计，超限立即中止 |
| `maxTitleCodePoints` | 500 | 2,000 | `DOC_CODEPOINTS_LIMIT_EXCEEDED` | 顶层标题最大 Unicode code points |
| `maxCodePointsPerField` | 10,000 | 50,000 | `DOC_CODEPOINTS_LIMIT_EXCEEDED` | 单个字段（作者、日期、小节标题、段落、单元格）最大 Unicode code points |
| `maxSections` | 50 | 200 | `DOC_SECTIONS_LIMIT_EXCEEDED` | 文档最大章节数 |
| `maxTables` | 20 | 100 | `DOC_TABLES_LIMIT_EXCEEDED` | 表格总数（顶层表格 + 各章节表格累计） |
| `maxRows` | 10,000 | 50,000 | `DOC_ROWS_LIMIT_EXCEEDED` | 所有表格累计数据行数 |
| `maxCells` | 100,000 | 500,000 | `DOC_CELLS_LIMIT_EXCEEDED` | 所有表格累计单元格数（含表头） |
| `maxColumnsPerTable` | 100 | 500 | `DOC_COLUMNS_LIMIT_EXCEEDED` | 单个表格最大列数（由表头确定） |
| `maxDepth` | 8 | 16 | `DOC_DEPTH_LIMIT_EXCEEDED` | 文档最大嵌套层级 |

---

## 3. 核心安全防御与设计原则

1. **增量 UTF-8 字节统计（避免先复制超大输入后才统计）**：
   * 采用增量式追踪 `totalBytes`，每遇到一个对象键名、字符串字段或基础数据类型即通过 `Buffer.byteLength(val, 'utf8')` 累加。
   * 一旦累加值超过 `effectiveLimits.maxBytes`，立即抛出 `DOC_BYTES_LIMIT_EXCEEDED` 提前中止，彻底杜绝先深拷贝或拼接超大输入导致的内存尖峰。
2. **精准 Unicode Code Point 统计**：
   * 采用零堆内存分配的代理对（Surrogate Pair）扫描算法 `countCodePoints`，正确区分 UTF-16 代码单元与实际 Unicode code points。
   * 对多字节汉字（1 code point = 3 字节 UTF-8）与多字节 Emoji（如 `🎉` 1 code point = 4 字节 UTF-8 = 2 个 UTF-16 surrogate units）实现精确统计与边界限制。
3. **Getter、Setter、Proxy 异常与原型篡改防护**：
   * 所有对象与数组在访问属性值前，使用 `Reflect.ownKeys` 与 `Object.getOwnPropertyDescriptor` 探测属性描述符。
   * 若发现 `desc.get` 或 `desc.set`，立即抛出 `DOC_GETTER_PROHIBITED` 阻断，**严禁触发执行任意 getter 代码**。
   * 对 Proxy 抛错行为严格包裹 try-catch，捕获后统一转换为稳定错误码 `DOC_GETTER_PROHIBITED`。
   * 严格校验 `Object.getPrototypeOf`，拒绝自定义类实例与原型篡改；若包含 `__proto__`、`constructor` 或 `prototype` 自身属性，立即抛出 `DOC_PROTOTYPE_POLLUTION`。
4. **循环引用与跨分支共享可变对象阻断**：
   * 维护 `activeStack` 与 `seenObjects` 双集合：
     * `activeStack.has(obj)` 命中：判定为循环引用，抛出 `DOC_CIRCULAR_REFERENCE`；
     * `seenObjects.has(obj)` 命中但不在当前调用栈：判定为跨分支复用同一个可变对象或数组（Shared Reference），抛出 `DOC_SHARED_REFERENCE`，防止后续下游修改时产生隐式副作用。
5. **公式样字符串保留为纯文本**：
   * 任何以 `=+\-@\t\r` 开头的字符串，在门禁层作为纯文本对待，原样校验保留于 `normalized` 副本中，不进行强制剥离或命令转换（生成器层负责按需转义）。
6. **非有限数与异常类型 Fail-Closed**：
   * 单元格取值仅允许 `string`、有限数字（`Number.isFinite` 为 true）、`boolean`、或 `null`。
   * 遇到 `NaN`、`Infinity`、`-Infinity` 抛出 `DOC_NON_FINITE_NUMBER`；遇到 `undefined`、函数、Symbol、BigInt 或嵌套对象抛出 `DOC_INVALID_TYPE`。
7. **错误信息严格脱敏**：
   * 抛出的 `TypeError` 错误信息中**绝不包含用户单元格文本、敏感字符串或服务器文件路径**；仅呈现数据结构位置（如 `root.table.rows[0][0]`）与计数值，彻底杜绝数据回显泄露。

---

## 4. 原始测试套件运行结果

### 4.1 测试命令
```bash
node --test tests/regression/docexport-input-guard-candidate-test.mjs
```

### 4.2 原始终端输出
```text
✔ 1. 基础合法结构化文档输入校验与深冻结规范化副本 (1.012792ms)
✔ 2. 中文与多字节 Emoji UTF-8 字节数与 Unicode Code Point 统计 (0.170417ms)
✔ 3. 增量 UTF-8 字节超限立即阻断 (0.127541ms)
✔ 4. 极长无表格纯段落文档合法性 (0.266917ms)
✔ 5. 非有限数 (NaN, Infinity, -Infinity) 严格阻断 (0.169083ms)
✔ 6. 公式样字符串原样保留为文本 (0.352875ms)
✔ 7. 表格行列失配与空表头 Fail-Closed (0.5045ms)
✔ 8. 未知字段与数组自身属性污染拦截 (0.142167ms)
✔ 9. 原型篡改与危险属性拦截 (0.124209ms)
✔ 10. 循环引用与跨分支共享可变对象阻断 (0.168208ms)
✔ 11. Getter, Setter 与 Proxy 陷阱拦截 (0.142417ms)
✔ 12. 错误信息脱敏：绝不回显用户单元格内容或敏感文件路径 (0.105458ms)
✔ 13. 资源边界上限与不可突破硬上限 (0.214958ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38.670292
```

### 4.3 语法合规性检查
```bash
node --check shell/exports/document-input-guard-candidate.cjs
```
* 输出：退出码 0，无任何语法或静态解析错误。

---

## 5. 与现有 `document-export-candidate.cjs` 的未接线边界说明

1. **当前现状**：
   * `shell/exports/document-export-candidate.cjs` 原先内置了基础的 `validateStructuredDocument`（覆盖行数、单元格数、缺列与数据类型校验），但未覆盖标题/段落/单元格的总 UTF-8 字节数、Unicode Code Point 上限、Getter/Proxy 防御与对象共享检测。
   * 本次新建的 `shell/exports/document-input-guard-candidate.cjs` 为独立的纯函数门禁候选模块。
2. **严格隔离原则**：
   * 按照任务包约束，**未修改 `document-export-candidate.cjs` 现存代码**，未向其中强行注入 `require('./document-input-guard-candidate.cjs')`。
   * 现有 `tests/regression/docexport-candidate-test.mjs` 测试集（8/8 PASS）依然保持完全独立且全部绿灯。
3. **后续建议接线路径（由主 Agent 统一裁定）**：
   * 后续在主 Agent 规划的重构节点上，可在 `exportDocumentCandidate` 的最前置入口处引入该门禁：
     ```javascript
     const { guardStructuredDocumentInput } = require('./document-input-guard-candidate.cjs');
     // 在 exportDocumentCandidate(docData, options) 开头：
     const { normalized, diagnostics } = guardStructuredDocumentInput(docData, options.limits);
     // 后续生成逻辑统一使用深冻结的 normalized 对象
     ```
   * 如此可形成多层防御闭环：前端/调度层前置门禁拦截（快速 Fail-Closed，零额外开销），后置生成器安全消费标准数据。
