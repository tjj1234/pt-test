# C03 PPTX固定版式产物｜程序员A后续队列

状态 QUEUED_AFTER_C01_REVIEW；M0可在C01审查后领取，不能与C01同时实施。先读00统一契约。独占：shell/candidates/claude-c03-pptx-20261106/、tests/probes/claude-c03-pptx-20261106/、docs/refactor/deliveries/claude-c03-pptx-20261106/。分支 dev/a/c03-pptx，从主程当时确认基线创建，禁止从未审Excel分支叠加。

目标：包03第四种输出格式，生成可下载重开的固定版式演示文稿。复用现有产物版本、ZIP/OPC guard、图片资产授权和worker；不新增资产库、发布协议或通用Office引擎。原任务书“必须手写OOXML/只能纯fflate”不作为选型结论：M0先比较锁定DSH/现有能力和成熟库（如PptxGenJS、python-pptx）的许可、部署、中文/图片/布局、资源和产物安全；证明确有不足才提出最小自研，Codex审定后实施。

M1范围：固定内置模板，标题、bullet、经宿主验证的图片、speaker notes；不含用户模板、图表、动画、转场、音视频、OLE、宏及外链。候选输入为结构化内容，不猜测自然语言授权；不扫描文字中的“转场”等词然后擅自改意图。明确不支持字段/操作给可解释错误或degradation，合法普通文字原样保留。输入限额与图片尺寸/解码限额先冻结。

建议 generatePresentation({operationId,slides,ownedImageHandles,limits,signal}) → {buffer,mimeType,bytes,sha256,degradations}。imageRefs由宿主解析授权和版本，候选不按URL下载图片；不得把租户ID回显当作已经校验所有者。未知图片拒绝，不产生断图的“成功”产物。

| AC | 必测行为/通过要求 |
|---|---|
| P01 | 单/多页、中文/英文混排、长标题/长bullet、空页、notes、图片横竖/透明、缺图样本，覆盖至少8份固定fixture |
| P02 | slide/bullet/字符/图片/输入输出字节/像素/时间/内存/并发上限在重操作前验证；未知字段、异常嵌套和XML非法字符有明确策略 |
| P03 | 生成文件反读文本、页数、notes、图片，OPC关系完整，无VBA/OLE/外部target或偷偷联网依赖 |
| P04 | 实际PowerPoint/LibreOffice打开并渲染所有页，检查中文字体、换行、溢出、遮挡、图片比例；提交PNG/PDF及字体/软件版本，不能只验ZIP头 |
| P05 | PowerPoint未获得时该兼容检查记BLOCKED，不用库自读自写替代；纯结构PASS不代表排版PASS |
| P06 | 资产越权、跨租户ID、任意路径/URL、符号链接和A/B并发隔离；图片仅来自宿主授权输入 |
| P07 | 取消、超时、worker崩溃、写失败、重复operationId：无半产物发布、源文件不变、进程和临时数据清理 |
| P08 | 回传hash/字节/mime确定；下载、刷新、重开与产物不可变版本由Codex集成后交独立QA，不冒称候选已接入 |

M0附最小用户步骤表：请求→确认内容/降级→生成→下载/重开，给Mermaid成功/错误分支。验证报告获审后交独立候选；附共享接线建议，不修改现有包03文件。不得将未经审核的Gemini文档生成候选作为新公共基线。
