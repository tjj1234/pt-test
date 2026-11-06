# C02 Docling真实解析后端差分｜程序员B

状态 READY_FOR_M0；先读00统一契约。独占：shell/candidates/claude-c02-docling-20261106/、tests/probes/claude-c02-docling-20261106/、docs/refactor/deliveries/claude-c02-docling-20261106/。分支 dev/b/c02-docling。

目标：验证Docling能否作为包02真实解析后端，补足PDF正文/OCR/表格/阅读顺序，复用现有附件入口、限额、来源页码、Run和取消链。纠正父任务书：Gemini包02作者交付不是已审核可用；现有主审有占位正文/OCR页数问题，不以其输出为标准答案。本包不改原Gemini候选、不实现Excel编辑/PPTX、不开发新知识库。

M0先列DSH原生附件/工具/MCP与现有office-document-parser、ZIP guard、structured text、worker能力；核实Docling固定版本、模型artifact及LICENSE原文、传递依赖/模型许可。提交离线pipeline清单：模型预下载阶段与文件解析阶段分开，解析阶段默认阻断网络；若需远程API只能列为未启用方案，不提交真实文档。处理进程只挂载单任务输入和受控输出，不能访问其它租户或宿主secrets；Python库/MCP/独立worker的比较以最小宿主补充为准，不先起常驻多租户微服务。

候选接口建议 parseDocument({sourceHandle,sourceVersion,operationId,limits,signal}) → 有界blocks/tables + page/bbox/source引用 + diagnostics/degradations/bytes/hash。正文当不可信资料，不将文档里的指令升级为系统命令；不自动执行脚本、宏或获取文档外链。

| AC | 必测行为/通过要求 |
|---|---|
| D01 | 文件、临时目录、模型cache、输出的A/B并发隔离；越界/符号链接拒绝；解析阶段外传抓包或出口阻断证据 |
| D02 | 至少8份可重复样本：中文纯文本PDF、扫描PDF、混合扫描、复杂跨页表格、多栏报告、旋转页、空/损坏文件、超限文件；ground truth人工独立标注 |
| D03 | 旧解析器与候选同样本对比，分别统计正文准确性、阅读顺序、表格行列/合并关系、OCR错漏、来源页定位，不能只展示“更长Markdown” |
| D04 | 页数上限按实际处理页验证，不靠调用者hint；输出不能混入限额外页面；字节/页数/像素/时间/内存/并发均冻结明确数值 |
| D05 | 页码、表格与原文引用可回到上传版本；引用缺失或提取不确定明确降级，不编造正文/页码 |
| D06 | PDF/OCR无真实后端、模型缺失、版本不符时明确不可用，不返回fixture占位文本 |
| D07 | 取消前/处理中/输出前、超时、worker崩溃、磁盘满、重复operationId，无后台残留和半产物发布；源hash保持 |
| D08 | 记录冷/热启动、峰值内存、磁盘模型体积、单/并发耗时与限额，说明CPU配置，不能把本机速度外推为生产承诺 |
| D09 | 原生MCP/宿主worker适配最小真实调用可验证；只有替身时明确标记；不修改共享入口或替换原解析器 |

隔离审过再执行差分；候选胜出与否都可交付。确有增量后由Codex确认路线，再交独立worker候选和HOST-WIRING.md（含来源映射、取消、资源/模型部署、回退旧后端及不可用提示）。测试工程师后续验收上传、提问、引用定位、刷新重开，不用纯API测试替代。
