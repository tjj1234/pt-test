# R34 03 结构化文档导出共享接线

状态：本地 HTTP/真实原生 SDK 候选测试通过；未部署、未独立 QA，不代表完整 R34 已完成。

复用 Gemini 结构化输入门禁、DOCX 生成器、可移植 XLSX、现有 PDFKit/中文字体、限额 worker 和不可覆盖产物写入。宿主新增 `document_export` 原生 DSH 注册工具；没有另造 Agent 循环或脚本文件生成引擎。用户显式勾选“生成文件”，本次 Run 仅开放该工具，与其他工具模式互斥；独立预算 180s、3 模型调用（包括一个上下文额度）、1 工具调用、0 重试、2048 输出 token。

输入仅标题/章节/段落/表格的有界结构化 JSON；宿主上限 64KB、20 章节、500 段落、1000 表格数据行/5000 单元格。既有更高生成器上限不能扩大宿主入口上限。文件上限 5MB、worker 128MB/10s、两槽；取消等待 worker 退出，发布前再次验证真实 Run 身份和有效租约。XLSX 公式样字符串按原生成器转义并返回降级记录，不运行公式、不嵌宏或外部自动加载对象。

输出位于 `document-results/<runId>/<randomId>.<format>`，固定命名、不可覆盖、文件哈希记录于 Run 事件及助手历史；路径从可信宿主生成。下载检查同一登录身份对 Run 的所有权，再通过 openat/O_NOFOLLOW 锚定租户路径；Word 仅允许从这个受控产物目录下载，未开放任意工作区 DOCX。Word/Excel 下载，PDF 原有安全预览；刷新与历史重开沿用持久化 URL。

`document-export-http-sdk-integration-test.mjs`：实际宿主 HTTP、锁定 DSH 工具执行与受控模型适配器，三格式均生成后下载并用真实解析器重开；验证中文、编号00123、表格/公式样文本、SHA256、跨身份拒绝和助手历史下载。第一次测试发现 DSH 作者 Schema 要求每个 object 明确 additionalProperties、泛型值使用 type=json；已对齐锁定契约后通过。不是实际付费模型/独立浏览器验收。

另有 `document-export-authority-test.mjs` 验证取消和租约丢失不生成文件或发布事件。待完成：浏览器点击下载/刷新/重开、发布归档收录、正式同版本独立 QA。
