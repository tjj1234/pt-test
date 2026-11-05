# 北极星开发者入门与架构说明
版本：评审稿1｜2026-11-03｜读者：首次参与的两位程序员、Gemini、独立测试Agent。本文基于本轮源码只读核对，不是干净安装/线上重测报告。先读本文，再读[协作流程](ENGINEERING-DELIVERY-WORKFLOW.md)和领取的任务包。
## 1. 产品、现状与宗旨
北极星是基于DSH的多租户Agent产品，PT提供模型推理和媒体等供应商能力。用户登录、绑定自己的PT Key，在对话中使用工具、资料、记忆和Skill，并查看持久结果。产品目标是最大化DSH：原生可用直接复用，未接通只接线，插件/受控升级可满足时不重复开发，确有缺口才补最小宿主桥。
r28部署事实见[交接](HANDOFF-20261103-R28-ONLINE.md)；本地链通过、已部署、真实业务验收严格分开。263/263是历史r28验证，不是领取任务后的结果。当前分支参考feature/northstar-integration-20261102、HEAD参考bbd9997；领取时重新git status/log，不能把本文件当实时Git状态。完整范围见[路线图](PRODUCT-ROADMAP-AND-RESOURCES-20261103.md)。
## 2. 已核实技术栈与入口
| 层 | 当前实现/版本证据 | 开发约束 |
|---|---|---|
| 服务入口 | shell/server.cjs，Node内置http、手写路由；shell/package.json的npm start | 主壳不是Express/Next.js，不为任务擅自换框架 |
| 前端 | shell/public/index.html、app.js、styles.css及功能脚本 | 主壳主要静态HTML/CSS/JS；依赖有React18.3.1不代表整体React应用，先复用现组件/DSH UI |
| Agent | shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz；runtime/dsh-adapter.cjs、persistent-runner.mjs | 锁定DSH，引擎/工具/模型协议复用；默认profile只装dsh-base |
| 存储 | db.cjs/db-pg.cjs；pg8.23.1、PGlite版本以lock为准（声明^0.5.8）；storage/index.cjs | 配置PT_PG_*明确选PG，失败不能静默退PGlite；仓储复用同连接 |
| 迁移 | shell/db-migrations/*.sql，按文件名记录schema_migrations | storage/migrations是历史兼容目录；不改已发布SQL，迁移编号由负责人分配 |
| 身份与Key | auth*.cjs、auth-google*.cjs、keys.cjs、tenant.cjs | Google登录保持；用户/租户/Key绑定由服务端可信上下文决定 |
| Run与工具 | tasks/store.cjs、execution.cjs、host-tool-handler.cjs、runtime/session-scheduler.cjs | Session不替代业务Run；工具调用须绑定当前Run/call/权限/预算 |
| 文档与产物 | attachments/*、exports/*、runtime/artifacts.cjs、artifact-open.cjs | DOCX用mammoth等受限解析，XLSX有现成实现；新增格式先复用，下载保留ACL |
| PT与媒体 | model-catalog.cjs、models/*、business/media/powertokens.cjs、shell/media/* | 当前PT分散接入，31包负责收敛；Python媒体部分不能靠Node测试宣称全覆盖 |
| 测试 | tests/regression、tests/probes；scripts/run-regression.mjs；.github/workflows/ci.yml | E2E目录现由Gemini负责，本轮未读取；独立测试Agent接手须先明确文件所有权 |
| 运行时 | package声明Node>=18；现有CI矩阵20/22；r28目标回执Node24.22.0/Python3.14.4 | 新人建议与目标同Node24.22.0（方案，仍需干净安装验证）；保持原CI兼容门禁，不能视三者等价 |

## 3. 系统与数据流
~~~mermaid
flowchart LR
 U[浏览器] --> S[Shell身份/路由/ACL]
 S --> R[持久Run与调度]
 R --> A[DSH Adapter与Runner]
 A --> P[DSH模型provider → PT]
 A --> T[原生工具或宿主RPC]
 T --> H[租户/Run/预算/执行边界]
 H --> F[隔离文件/产物/供应商任务]
 R --> D[PostgreSQL或PGlite]
 F --> S
 R --> U
~~~
用户是身份主体，tenant是数据边界；conversation是业务对话，DSH Session是引擎上下文，Run是一次可追踪执行；tool call是Run内操作，external operation记录可能计费的外部提交；artifact是带归属/版本的结果。标识通过服务端映射，禁止信任客户端传来的tenant或模型写出的权限。
DSH_HOME必须产品专属，绝不能用开发者~/.dsh。runtime、DB、secrets不能写进不可变release；cwd不是OS沙箱。资料/记忆删除会影响热Session上下文，不能只删列表。
## 4. 新人启动与第一次自测
仓库根没有package.json；shell、analytics、business/attribution是不同依赖根，不在根执行npm install。锁依赖安装使用npm ci，不升级依赖解决安装错误。新增依赖先报版本/许可/平台/闭包影响。
在shell目录运行npm ci；回到仓库根运行node --check shell/server.cjs。首次联调优先使用现有隔离harness，不直接拿生产账号；阅读tests/probes/northstar-local-http-smoke-20261020.mjs及northstar-browser-harness.mjs，检查依赖与fixture，按其实际参数运行，禁止把模拟登录当Google回调成功。
如需手动启动，在独立克隆与受控本地env中设以下变量，配置完成后在shell运行npm start：
| 配置 | 开发/测试值要求 |
|---|---|
| PT_RUNTIME_DIR、PT_DB_DIR、PT_MASTER_KEY_FILE | 各自隔离的绝对路径；不得沿用仓库现有runtime/db/secrets或生产目录 |
| PT_SHELL_PORT、PT_LISTEN_HOST | 空闲端口；默认8098/127.0.0.1 |
| PT_PG_DSN或PT_PG_* | 仅隔离测试DB；未配置才走PGlite；DB环境残留可能误连，先核对目标不打印密码 |
| PT_CHAT_DRYRUN=1 | 仅不启动DSH的页面/接口探索；不是Agent验收 |
| PT_MEDIA_GENERATION=off | 默认不做真实媒体；测试临时开放按授权预算 |
| PT_COOKIE_SECURE | 正式HTTPS=1；本地HTTP配置另行处理，不能降级正式配置 |
这些是已存在配置名，本轮未实际启动验证。默认管理员、Google和analytics代理设置由负责人提供脱敏模板/fixture，禁止自行猜账号或复制生产secrets。不要向日志/截图暴露Key、Cookie、签名URL。
测试命令：仓库根node scripts/ci-check.mjs（语法）；node scripts/run-regression.mjs（默认回归）；隔离PG配置下node scripts/run-regression.mjs --postgres。这些是入口，不要求每次改文档跑全套；按任务测试矩阵先跑受影响门禁。独立Node测试按文件实际入口（部分直接node，部分node --test），不假设有npm test。
## 5. 已存在制度与待补缺口
CI配置目前仅push/PR到main触发，不能声称集成分支自动通过；16包应核实触发/分支保护和目标Node覆盖。测试/正式双环境尚无完整独立证据；现有agent-fat域名名称不证明环境身份，18/33/负责人先确认资源与用户数据用途。
本说明不允许新人绕过已有权限。开发可在独立分支/checkout进行；不要reset/clean他人工作，不全量git add；不读取tests/e2e/、用户未跟踪业务文件或凭据。原01–08归Gemini，其余分工由负责人结合人员能力明确，负责人保留共享入口和发布权。
## 6. 入组完成标准
新人提交：本地Node/npm/OS版本、领取时base/dirty摘要、依赖安装/语法/指定fixture退出码、读过的契约、实际数据流理解、阻断清单。负责人确认后领取独占包；没有测试账号/环境可以继续候选实现，但不填“真实联调通过”。不需要先通读所有旧交接。

