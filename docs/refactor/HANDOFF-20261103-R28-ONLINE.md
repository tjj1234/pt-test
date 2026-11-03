# 新会话交接：r28 已上线｜2026-11-03
**优先读取本文件，不要从10月31日的旧交接重新开始。** 本会话已经完成用户授权的r28服务器部署和线上功能清单；当前仅保存交接，不继续开发或修改线上。下一会话先核对Git与用户最新指令，区别“已部署”“本地链通过”“真实线上业务验收”。

## 当前事实与证据
仓库 `/Users/mmdn/Downloads/pt项目`，远程 `https://github.com/tjj1234/pt-test.git`，分支 `feature/northstar-integration-20261102`；交接前HEAD `db2449e`，已推送。源码修复 `3deac76`，精确交付 `062fe47`，上线清单 `8ecfc4f`，原始部署回执 `db2449e`。本文件提交会使HEAD前进，只是文档，不是新产品版本。

| 线上项目 | 已核实值 |
|---|---|
| 入口 | https://agent-fat.adorado.top |
| 服务 | northstar-shell，active/running，PID302282，NRestarts=0 |
| 当前目录 | /opt/northstar/releases/controlled-trial-20261103-candidate-34-r28-draft/shell |
| 旧目录 | /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell |
| 切换完成 | 2026-11-03 15:10:49北京时间（16:10:49日本时间） |
| 最后健康回执 | 2026-11-03T07:23:07.931Z，uptime739秒，PID一致 |
| 目标运行时 | Node24.22.0，Python3.14.4 |
| 数据库 | PostgreSQL northstar，本机5432；迁移24→29；171历史Run保留 |
| 配置 | settings=current；模板/实际SHA 5df264dce03602cc49b201f19e80ccf6b72e8d6d67ea29740240a79bd46fdce9 |
| profile manifest | f2abe3c5074c6319758cab1ce7ebb4c5f42e630b6a9539d78ac1d8eb6ab5fda1 |
| 媒体开关 | PT_MEDIA_GENERATION=standard3；PT_CONTROLLED_MEDIA_AUTHORIZATION=1 |

公开登录页已实际打开并目视检查；既有Google登录configured=true，但未真实登录完成回调。公网app.js SHA与本地冻结文件一致；服务器217绑定源码逐项匹配。未登录的models/skills/memory/sources接口均401。favicon.ico有一项401，非主页面加载失败，不得报“浏览器零错误”。

## 必须维持的范围与验收边界
本期开放：对话、文本模型切换/AUTO、原生推理强度、CSV分析导出Excel、图片理解、Context、确认式长期记忆、资料检索引用、固定版本Skill发布/选择/停用，以及文生图、图生图、文生视频。
- **所有Seedance从AUTO与手动列表排除，代码保留；图生视频关闭。** 三类媒体仅标准接口，Seedream5负责文生图/图生图，Wan2.7-t2v负责文生视频。逐Run明确确认，一次外部提交，零自动重试，无金额硬上限。
- 7个已有Key账号均fresh目录，三项手动路由资格通过，共21组合；**verificationRequired=true，未伪造runtime verification，未解锁媒体AUTO**。此前让运维补目录的异步请求已被服务器只读审核替代，不要重复索取。
- 核心链本地HTTP/存储/锁定SDK/浏览器闭环通过；全量263/263，确切归档Linux23/23＋标准媒体4/4＋独立记忆1/1。目标npm ci、495包/31007文件生产闭包与PTY通过。
- **本次没有真实付费对话或媒体生成，不能声称真实业务生成已验收。** 线上部署和只读资格通过不替代真实执行；如下一任务需要付费探针，先明确授权、模型和次数，不能因已有SSH权限推定无限费用授权。
- Context旧R4的8项主审阻断已由修复后10项独立反例及HTTP/SDK/重启链验收取代；旧blocked报告是历史，不可当当前状态。真实PT摘要质量/成本仍未实测。
- 标准结果URL按PT声明假设永久有效，用户明确接受长期有效性未验证，不再以此阻断上线。默认无需自建CDN或预填CDN域名；宿主处理PT返回HTTPS结果，公网IPv4固定、拒绝私网/跳转、限额与类型检查、本地受权限保护地保存。保存失败/远端结果未知禁止自动重投；停止超时不表示停止计费。
- AV理解、PDF/OCR、联网审批隔离、真实账单等不属于本期完成范围；Gemini8个后续包由用户明确暂缓，不自动恢复。新OAuth文档明确不采用，保持已有Google登录。

## 精确产物与恢复点
最终ZIP：`release-artifacts/northstar-r28-scoped-release-20261103.zip`，SHA `b4ca44ebde755b08710b51632f8d0837d0a531254c33ff0fc63258f64a5771db`，45成员；内44项校验均通过。应用tar：`northstar-controlled-trial-20261103-candidate-34-r28-draft.tar.gz`，SHA `e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501`，217源码/419成员。名称含draft是历史冻结命名，不代表线上仍r14；使用scoped unit。ZIP冻结在切换前，其中TARGET_PENDING是当时状态，之后线上结果见部署记录，禁止改写原ZIP。

目标恢复点 `/var/backups/northstar/r28-20261103T070700Z`，root0700；PG dump已真实恢复到隔离库 `northstar_r28_verify_20261103070701`，PUBLIC CONNECT已撤销；隔离迁移24→29仍保留171Run。runtime/db/secrets/env/旧unit备份可读且校验通过，数据未下载。保留旧release。切换失败恢复旧unit和DSH home的处理已写入服务器脚本，**本次未触发回滚，不宣称真实失败回滚演练完成**；数据库不会随unit自动回退。

## 阅读顺序与继续方式
1. `docs/refactor/ONLINE-R28-FEATURES-20261103.md`：已给用户的线上功能清单及限制。
2. `docs/refactor/evidence/R28-ONLINE-DEPLOYMENT-20261103.md`：线上事实、恢复点、配置事务。
3. `docs/refactor/OPS-R28-SCOPED-RELEASE-20261103.md`：安装/升级/回滚操作。
4. `docs/refactor/evidence/R28-SCOPED-ACCEPTANCE-20261103.md` 与 `*-r28-final-20261103.json`：本地主审和源码/日志绑定；六份 `northstar-r28-*.log` 为脱敏目标回执，另有同名部署证据tar包。
5. 必要时读WORKLOG末尾；不要从头扫描旧日志或全仓库，也不要重新跑已通过的全套测试，除非改动或新失败需要。

下一步由用户新会话指令决定。若继续验收，优先补获授权账号的真实对话/切换/推理、CSV下载重开、图片理解，以及三类标准媒体生成→展示→历史重开的生产证据；不能用再跑替身替代。若发现缺陷，先复现、独立修复、精确冻结新版本并跑受影响门禁，再按备份/回滚流程切换，不能直接改r28目录或覆盖旧归档。

## 安全与工作现场
用户已明确授权自行SSH部署，目标47.237.22.191，端口22，账号tongjiawan；**密码不保存在摘要、脚本、仓库或交付包**，不要搜索会话日志取密码或复制进新提示。若未来确需重新认证而无可用安全方式，再请用户提供授权方式。已结束本次SSH并清除sudo缓存，验收浏览器已关闭；没有本助手部署/测试任务仍在后台运行，线上业务服务正常运行。

保留用户未跟踪文件和现有脏工作，不能git reset/clean或全量git add。`tests/e2e/`由Gemini负责，不读取、修改或纳入本助手交付。不要复用会丢失的/private/tmp开发工作树保存未提交成果。用户要真实进度、明确阻断、可验证同版链，不要承诺未经证实的交付时间，不把任务包COMPLETED标记当正式验收。
