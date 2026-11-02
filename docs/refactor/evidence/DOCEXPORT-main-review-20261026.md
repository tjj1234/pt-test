# Word / PDF / Excel 候选主审阅（2026-10-26）

结论：Gemini 的三个新文件边界合格，主 Agent 在当前工作树复跑 `docexport-candidate-test.mjs` **8/8 PASS**；可保留为后续“办公表格与报告导出”的候选，不接入产品或宣称可交付。当前 F2 仍专注 CSV。

接线阻断：

1. PDF 把非 ASCII 文本写为 UTF-16BE hex，但页面字体只有 PDF 标准 Helvetica/Helvetica-Bold，没有 Unicode CID 字体、映射或嵌入字形。结构测试只检查 hex 字节存在，不能证明中文可见或可复制；中文报告必须用独立 PDF 阅读器做渲染和文本提取验收后才能启用。
2. XLSX 引擎从 `analytics/node_modules/xlsx` 回退加载；`shell/package.json` 不声明 `xlsx`，目标 Shell 单独安装/打包时可能报 `XLSX_ENGINE_UNAVAILABLE`。必须把运行依赖纳入目标候选包并核验锁文件与干净安装。
3. 输入门禁候选现已接入导出入口：对标题、段落、表头、单元格与总体 JSON 字节数、段落总量、表格维度作前置限制，生成器仅接收冻结副本；布尔、对象、undefined 等单元格值拒绝。`timeoutMs` 仍只在同步生成前后检查，不能中断阻塞中的 ZIP/XLSX/PDF 生成；需进程隔离或可中止机制才可开放不受信任的导出请求。
4. XLSX 工作表名非法字符、大小写重名、长标题冲突及 UTF-16 截断问题已于 2026-10-27 修复并由 XLSX 反读确认所有表和数据保留；重命名以 sheet_name_normalized 元数据记录。PDF 表格多页时没有重复表头，也没有列宽裁切/换行；视觉验收尚无证据。

已确认本地许可证元数据：`analytics/node_modules/xlsx` 为 Apache-2.0，`shell/node_modules/fflate` 为 MIT；这只证明当前工作树安装实例，不证明目标安装闭包。后续完整流程验收要求：结构化报告输入→租户 Run 产物版本→独立阅读器可读/中文可见→鉴权下载→重开历史→失败与超限拒绝，且 F1–F3 已发布功能不退化。

2026-10-27 复核 Gemini 输入门禁 13/13 与原导出 8/8 通过后，主 Agent 加固门禁并接线：补累计段落数上限、表格行数分配前预检、确切 JSON UTF-8 字节复核及单元格 `string | finite number | null` 限定；导出入口先校验并复制为深冻结对象，再进行格式校验和生成。新增生成前 getter/段落/布尔拒绝集成测试，组合 **23/23 PASS**，`ci-check` **444 个 JS 文件、0 失败**，`git diff --check` 通过。该结果仍仅是模块级生成验证，未进入 Run/下载/历史，且上列 PDF/XLSX/超时阻断仍未解除。

### 2026-10-27 后续主审加固：不执行输入对象代码
输入门禁拒绝所有 Proxy（含已撤销及嵌套 Proxy）后再做反射；限制选项采用纯对象/自有数据描述符读取，拒绝 getter、Symbol 及自定义原型，不执行陷阱。未知字段/选项名不再回显。字符串先按 code point 上限作有界检查，再分配 JSON 转义副本，标题空白 trim 也置于长度检查之后。新增反例验证 getter/Proxy 执行次数为零、敏感键名脱敏、百万字符字段在 JSON.stringify 前拒绝。门禁加原导出组合 **25/25 PASS**；该加固不解除 PDF 中文/XLSX依赖/同步超时和产品链路阻断。

XLSX命名反例加输入门禁及原导出组合 **26/26 PASS**；不改变其他尚未解除的接线阻断。
