# 离线证据：可移植 XLSX 产物生成候选独立验证（2026-11-01）

## 1. 依赖与基准环境

- **Node.js**: v24.14.0 (Darwin arm64)
- **底层压缩库**: `shell/node_modules/fflate@0.8.2` (MIT，纯 JS 零原生编译)
- **现有反读验证库**:
  - `shell/attachments/office-zip-guard.cjs` (`inspectOfficeZip`)
  - `shell/attachments/ooxml-structured-text.cjs` (`extractStructuredOffice`)
  - `@xmldom/xmldom@0.8.10`
- **运行环境**: 本地独立运行，零公网依赖，零系统级编译，零外部未授权目录回退。

---

## 2. 关键设计与安全闭环

### 2.1 彻底剥离 SheetJS (`xlsx`) 路径依赖
- **历史缺口**：早期文档导出模块依赖从 `../../analytics` 或 `../../business/attribution` 搜索 SheetJS，导致在 shell 独立部署或无 analytics/business 目录的环境中无法独立运行。
- **可移植落地**：
  - 基于 ECMA-376 (SpreadsheetML) 标准规范，纯代码直出最小标准 OOXML；
  - 仅复用 shell 自身锁定的 `fflate` 进行 ZIP 归档，无其他第三方运行依赖；
  - 探针验证将候选文件复制至 `os.tmpdir()` 临时独立目录，并在同级放置假冒 stub 文件，证明其解析链严格指向 shell 锁定目录，绝对不从不受信 cwd 补依赖。

### 2.2 前置限额 (Reject-before-Scan)
- 暴露明确 schema（`PORTABLE_XLSX_SCHEMA`）与公开 limits（`PORTABLE_XLSX_LIMITS`）；
- 工作表（`sheets`）、行（`rows`）、列（`cols`）在遍历前均进行 O(1) `length` 先验；
- 限制单个单元格字符串最大长度（32,767，与 Excel 规格一致），总单元格数硬上限 50,000；
- 超限数组或对象直接抛错拒绝，Proxy 监控验证元素访问计数严格为 0；
- 遇到 `NaN`、`Infinity`、非法 XML 控制字符（`[\x00-\x08\x0B\x0C\x0E-\x1F]`）、非法工作表名字符（`:\/?*[]`）或重名，立即阻断。

### 2.3 强类型与无猜测存储
- 仅支持 `string`、`finite number`、`boolean`、`null` / `undefined`；
- 字符串数字（如 `"00012345"`）严格以 `inlineStr` 存储，绝不猜测转换为数值或日期；
- 中文字符、空格、多行换行符完全保留。

### 2.4 公式注入防御与零可执行内容
- 针对以 `=+\-@\t\r` 开头的潜在公式字符串，自动前缀单引号 `'` 转义，并将详情记录至 `degradations` 数组；
- 绝不生成 `<f>` 公式节点、宏脚本（`vbaProject.bin`）或外部 OLE 嵌入对象，经由 `inspectOfficeZip` 严格断言通过。

---

## 3. 测试与探针验证结果

### 3.1 单元与回归测试 (`tests/regression/portable-xlsx-candidate-test.mjs`)
- **执行命令**: `node --test tests/regression/portable-xlsx-candidate-test.mjs`
- **退出码**: `0`
- **通过测试数**: `4 / 4`
  1. `Portable XLSX - Valid multi-sheet generation and round-trip readback via existing office parser`: PASS (6.34ms)
  2. `Portable XLSX - Reject-before-Scan: arrays, bounds, sheet names, and control characters`: PASS (0.41ms)
  3. `Portable XLSX - Formula injection defense and no guessing string numbers`: PASS (1.41ms)
  4. `Portable XLSX - Custom limits and resource ceiling boundaries`: PASS (0.10ms)

### 3.2 独立环境探针 (`tests/probes/portable-xlsx-candidate-probe.mjs`)
- **执行命令**: `node tests/probes/portable-xlsx-candidate-probe.mjs`
- **退出码**: `0`
- **探针验证环节**:
  - `[1/4]` 临时目录独立加载与无害同名 stub 依赖防御：通过；
  - `[2/4]` 全谱系（中文多行/小数/负数/布尔/空值/字符串数字）生成，并通过生产 `inspectOfficeZip` 与 `extractStructuredOffice` 100% 成功反读；
  - `[3/4]` 前置限额与异常防御：超限数组立即中断，非法字符与非有限数字全部在生成前拒绝；
  - `[4/4]` Schema 与 Limits 导出符合契约规范，便于主 Agent 接入结构化文档工具。

---

## 4. 主线接缝说明

- 主 Agent 后续可直接在文档产物或工作空间导出工具中调用：
  ```javascript
  const { generatePortableXlsx, PORTABLE_XLSX_SCHEMA } = require('./exports/portable-xlsx-candidate.cjs');
  const res = generatePortableXlsx({ sheets: [...] }, optionalLimits);
  // res: { buffer, mimeType, bytes, sha256, degradations }
  ```
- 保持为独立候选文件，不改动生产产物存储、Runner 或前端 UI。
