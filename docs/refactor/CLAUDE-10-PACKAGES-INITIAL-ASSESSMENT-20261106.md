# Claude 10包能力增量初评（2026-11-06）

结论：有增强价值，但不建议按10份文档启动10条独立开发线。执行顺序固定为：锁定DSH原生服务/工具 → 当前产品已有能力 → 配置与接线缺口 → 经验证的外部后端 → 最小宿主补充。MCP是传输与工具接缝，不自动提供业务能力、可信身份或租户沙箱。本轮仅评估，未安装插件、未发付费请求、未修改生产代码或正式环境；任务书中的测试步骤不是已完成事实。

范围：逐份读取 claude10个包/ 全部10份文件；原生基线以R33工作树 /private/tmp/pt-questions-m1-r5-integration-20261106 的锁定 @deepseek-ai/dsh 0.1.1-rc.2、实际安装包README和profile为准，不能用主目录旧HEAD代替已上线版本。原文与本地依据指纹见同名 sources.json。外部README仅为当前候选能力声明，尚无本产品隔离/兼容/功能验收结果。

| 任务 | 增量价值 | 原生/现有优先路径 | 初步决定与前置条件 | 工作量主因 |
|---|---|---|---|---|
| Excel原地编辑 | 高：运营报表增删行、保留格式与公式 | 复用现有资产、版本、ZIP防护、worker；DSH文件工具不承担公式语义 | 优先验证候选隔离，再用公式/跨表/命名区域样本做引用调整对照；不替换安全的从零生成器 | 高；公式正确性和真实Excel对照，非MCP接线 |
| PPTX生成 | 高：周报、复盘、提案直接交付 | 复用包03产物存储、下载、图片授权；DSH Skill/MCP仅承载工具 | 可先验证固定版式M1；先比成熟库与最小实现，勿预先锁死手写OOXML | 中；排版、中文字体、图片及跨软件渲染 |
| Office工作流/Word编辑 | 有条件；与Excel/PPTX重叠 | 复用现有DOCX导出worker；原地编辑是另一种能力 | 拆掉泛Office包，只保留Word原地编辑待真实需求确认；不另造总引擎 | 中高；修订记录、样式和复杂对象往返 |
| Docling复杂文档 | 高：复杂PDF表格、阅读顺序、OCR质量 | 复用现有上传、解析路由、来源页码与worker；补解析后端 | 优先验证；同步纳入包02真实解析后端评估，避免再建一套入口 | 中高；模型资源、CPU/内存、复杂样本、页码证据 |
| 数据库/DBHub | 有真实客户库需求时高 | DSH MCP client + 现有owned工具/凭证/审计；GA和归因查询继续保留 | 条件优先：首版只接指定只读库/视图；固定报表先试参数化工具 | 高；账号/行表权限、查询计划和语义口径 |
| Playwright MCP | 有价值：需登录、点击和填写的页面 | DSH MCP client；复用Run预算、取消、工具日志 | 储备；按租户隔离浏览器状态，最先验证只读网页流程；写操作另需审批能力 | 高；浏览器生命周期、登录态、出口和动作权限 |
| Firecrawl网页提取 | 有价值但容易重复 | 先接DSH ctx.web + tool-web；已有HTML→Markdown、超时及输出限额接缝 | 暂不新增服务；只在真实JS页面/批量爬取样本证明原生不足时引入后端 | 原生接线中；额外爬虫服务中高 |
| 知识库检索 | 高，但不必先上向量库 | 先完善现有资料检索、来源引用、记忆及包30 | 先建召回/引用正确性样本；关键词不足再评估语义召回及Qdrant | 中；索引权限、更新/删除传播及评测 |
| 定时任务与工作流 | 高但属两类能力 | 复用原生Schedule、jobs、workflow；不重写编排器 | 分拆会话提醒和持久自动化。先限只读场景，再补宿主后台授权/调度和租约 | 高；重启恢复、时区、幂等、离线凭证及费用 |
| 第三方应用连接 | 取决于首个目标系统 | 复用DSH MCP及现有连接能力、OAuth流程；包25统一管理 | 首个系统未确定前暂缓泛生态调研；别与DBHub/浏览器重复立项 | 取决于系统；撤销/授权/写回语义为主 |

上述优先级是建议验证顺序，不是安装、开发或排期批准。Excel的优先来自文件里明确的运营需求；DBHub、Word和连接器仍有产品条件，不能因为候选有名就判为P0。

## 原生核查与任务书需要纠正的前提

1. 本地锁定DSH依赖中确有 MCP client、schedule、jobs、workflow、fs、skill及tool-web；R33 profile仍关闭tool-web、tool-jobs、tool-workflow、通用文件/命令和子Agent等。关闭或未接线不等于DSH没有能力；也不能直接取消禁用当作集成。原生开放必须仍经可信Run、预算和适用的隔离门禁。
2. dsh-tool-web/README.md明确 web_search/web_fetch 基于ctx.web，已有HTML到Markdown、结果上限及协作超时，但无web专属权限策略。Firecrawl任务书的“当前没有网页提取”应区分产品尚未接入与原生接缝存在，优先复用该接缝、补可信provider，而非并建工具循环。网页输出作为不可信资料，不能因抓取成功获得执行授权。
3. dsh-schedule/README.md写明deliveryMode=session-local，Agent/plugin销毁会停止timer；持久Session事件不等于有常驻跨进程cron服务。dsh-tool-workflow是执行JavaScript编排子Agent，不是开箱即用的运营审批/报表工作流。产品需要的定时唤醒、去重、凭证撤销、租约与费用边界须明确归宿主所有，优先利用原生接缝补齐。
4. Docling任务书声称“包02由Gemini完成”，与 docs/refactor/evidence/GEMINI-01-08-LEAD-REVIEW-20261106.md 的真实PDF正文/OCR页数阻断冲突；作者交付不能当已接入可用。Docling可能填补基础后端缺口，也可能增强复杂结构，须在同一包02矩阵验证。
5. PPTX任务书预定纯fflate手写OOXML，违背先验证成熟能力再决定最小自研的顺序；ZIP/OPC结构检查不能证明视觉排版。需增加实际Office/LibreOffice打开、文本反读、中文字体、溢出、图片权限/尺寸与下载重开；第一版仍可坚持固定模板与有界输入。
6. 本地锁定依赖未发现专用Office/浏览器自动化包，不把Skill加载器、fs工具、MCP客户端误称现成Office/浏览器引擎；也不把某第三方项目的问题泛化为所有社区项目不可用。外部方案须固定具体版本/提交、LICENSE与传递依赖后再做代码及隔离验证。
7. “stdio单进程/每任务进程”只是生命周期选择，不是OS沙箱；cwd也不是权限边界。所有候选共享约束：宿主绑定tenant/user/Run和资产ID，模型不接触DSN/密钥/任意路径；用适用的进程、挂载、网络和数据库权限实现隔离，验证取消、重启、并发与凭证撤销。

## 外部一手依据及当前证据限度

- [DBHub官方仓库](https://github.com/bytebase/dbhub)：当前README列出默认execute_sql/search_objects、只读、行数与超时控制。多连接配置不证明自动租户隔离；只读不等于只能读本租户。不要把SQL执行器叫已验证的自然语言准确率保证。
- [Playwright MCP官方仓库](https://github.com/microsoft/playwright-mcp)：官方明确其不是security boundary，origin allow/block也不是安全边界且不覆盖重定向。需宿主独立隔离browser context/profile、下载和网络，不复用真实用户共享浏览器。
- [Docling官方仓库](https://github.com/docling-project/docling)：支持本地执行、OCR及MCP连接；具体pipeline、初次模型下载、远程服务选项仍要逐项核实，不能仅凭“本地Python库”宣布零外传。
- [Excel MCP Server官方仓库](https://github.com/haris-musa/excel-mcp-server)：当前宣称可选目录约束、公式安全和原子保存；可选约束必须验证实际部署是否强制。README公式能力不能证明本文要求的增删行引用一致性。
- [Firecrawl官方仓库](https://github.com/firecrawl/firecrawl)：仓库说明主要AGPL-3.0、部分SDK/UI为MIT，云版与自托管能力有差别；不能用SDK许可替代服务端许可结论。版本/许可及数据路径列为后续选型核实项，本轮不作法律结论。

本轮没有完成各项目源代码级安全审计、真实文档/数据库/浏览器对比测试、License原文及所有依赖核验；不宣称最终选型或即装即用。建议下一步按“Excel隔离→公式样本、Docling包02差分、PPTX成熟生成器差分”三个有界验证推进；数据库等具体客户需求出现后再启动。R33正式QA继续原队列，不被这批调研替代。
