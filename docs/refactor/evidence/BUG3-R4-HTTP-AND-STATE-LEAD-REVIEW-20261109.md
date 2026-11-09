# 第三批Bug ee30815独立复审与收尾清单（2026-11-09）
结论：新增测试是实质进展，生产HTTP/server/Run/adapter与磁盘PGlite链路可复跑通过；当前批次仍不整体放行。三项实际状态问题已重现，另需补齐原生命周期矩阵中实际断连、双活会话和运行中租约丢失的证据。无合并、生产连接或部署。

## 版本、运行与边界
本轮从Git导出 `ee3081570236881b4e1e01a08ef4545729aa48cf`，相对882f532只改流式测试，未改运行源码；独立目录npm ci --offline安装639包成功，作者工作树无写入。[源与执行指纹](BUG3-R4-REVIEW-MANIFEST-20261109.json)。
新HTTP测试1单元/9场景通过，约9.4秒退出0；专项、来源关闭、静态流式及产物预览共10测试单元通过（预览内部64断言）。[HTTP实测](BUG3-R4-HTTP-LIFECYCLE-LEAD-20261109.txt)、[专项实测](BUG3-R4-FOCUSED-LEAD-20261109.txt)。首次沙箱listen EPERM发生在测试服务启动前，已保留[环境失败记录](BUG3-R4-HTTP-LIFECYCLE-SANDBOX-20261109.txt)；经允许本地监听后相同源码复跑通过，不把EPERM算产品缺陷。失败fixture的临时存储已清理。
DSH runner与目录/发现由测试fixture替换，服务端、adapter和持久库使用真实生产实现；这证明宿主协议链，不证明真实模型供应商、完整DSH工具循环或浏览器点击。HTTP GET回查不替代后续独立浏览器刷新/重进验收，源分支也尚无R34新增问答/08接线，不能用其通过替代集成后回归。
本轮开始时主工作区旧补丁为 `a39a5dc551182e53b4b9cb03648853e8cc7c3328192ccad118bbd1ecd891173b`。随后读取作者新交接：交付tip a69bcaf，ee之后仅改报告，运行源码/测试与本轮已跑ee一致；作者工作树新补丁SHA为 `e051f51f8247b8365f8996bece2bb80b22b20393a708ba305b909ed9e324b9fd`，已同步新HTTP测试。新补丁在fd1f11e隔离应用成功，12个最终文件逐字节匹配a69bcaf，在R34的apply --check也通过。主工作区旧文件保留不覆盖。分支与R33/R34历史已分岔，未来应选择性应用已审差异，禁止整分支合并覆盖问答、08及主审探针。正式再次交付需统一tip、patch、报告和指纹。

## 三项代码状态问题（原B3-R2-04完整矩阵内）
| 项目 | 实际复现 | 完成要求 |
|---|---|---|
| firstConnectedAt首次值不可变 | 真实store两实例中已有null元数据缓存可覆盖另一实例已写的首次时间；另用两个真实worker、同一初始空目录、读取barrier固定时序，两个writer都看到文件不存在，B先提交后A仍覆盖B的首次时间 | 对“首次写入”提供跨worker原子条件写/协调；cache不能遮蔽外部提交；临时文件唯一与rename只防破碎，不能单独保证首值不被重写。验证首次值、并发成功/失败语义、重开及真实I/O失败 |
| 当前轮保留提示误判 | 执行作者app.js实际hasPartial表达式，历史中有旧assistant回答、当前轮只有用户问题且零输出时，结果仍true，会显示“已保留生成的部分内容” | 根据当前runId/当前轮终态消息判断实际partial；覆盖历史完整回答、历史partial、当前空白/零输出、当前有文本、换会话及刷新。仅把some换另一条历史匹配条件不能闭环 |
| 调度页面把真实故障伪装为未接通 | 执行实际bizLoadSchedule函数，bizRead抛503后仍显示“尚未接通（待首次导入）”“还没有上传记录” | 仅在确认未初始化/空记录时显示未接通；网络、权限、500/502/503、损坏与格式异常显示无法读取/重试，不返回裸内部错误也不伪造空状态。作者报告声称的NOT_INITIALIZED/WAITING分支在该候选相关源码中未找到 |

[状态反例记录](BUG3-R4-STATE-BOUNDARY-LEAD-20261109.txt)，探针 `tests/probes/bug3-r4-state-boundary-lead-20261109.cjs` 导入真实store并执行实际UI表达式及schedule loader函数；worker仅在真实existsSync读空后设置调度barrier，未复制store实现或模拟Map持久层。退出0表示成功重现问题，非功能PASS。无外部网络；worker及临时目录已释放。
主审探针初版把“无文件返回null”当作可缓存缺失，断言未复现；查明生产load不缓存不存在文件后改为“已保存null行”并增加两真实worker的初始空目录调度实验。该初版fixture假设错误不算产品失败，最终上述可复跑证据为准。

## 原生命周期矩阵的证据补齐
| 当前场景 | 本轮实际覆盖 | 尚需验证 |
|---|---|---|
| 客户端断连 | fixture同步发完delta+done，客户端200ms后abort | 在首段已到而done尚未发时真实断开；用barrier确认断开时Run仍运行，按既有策略完成或取消并验证最终落库，禁止仅靠固定sleep推断已断流 |
| 双会话隔离 | B同步完成，350ms后停止A | A/B同时处于等待/流式中时停止A，确认B仍可继续产出并只提交一次；分别核对历史与Run终态 |
| lease loss | 停服后直接用错误owner调用store被拒绝；另手动改过期时间测回收 | 在真实HTTP/Run运行中失去租约/转移owner，旧worker迟到结果、错误/close到达均不能改写新状态；验证有权结果是否完整持久化 |
| cold reopen/幂等 | 关server后重开磁盘库、重复幂等键不重复写对话 | 保留本轮证据；补按具体conversation/run比对文本与partial/stopReason，并确认重复请求没有第二次实际执行，后续集成版再跑 |
| error/close/取消后迟到 | 有error与done后迟到delta；用户停止、超时可保留正文 | 加入实际runner进程close、取消后的迟到done/step及重复终态，按完整适用矩阵逐项登记 |

不要把上述测试补齐当作要求另造DSH。协议fixture适合故障调度，真实SDK和独立浏览器各保留自身证据层。当前测试中Array.from循环同步save不属于跨进程并发；实际多writer校验需独立worker/process与确定性barrier。

## 可直接转发给Bug工程师
已独立复跑ee30815：HTTP/Run/server/adapter/磁盘库的9场景及相关10单元回归通过，进展确认。请按本报告一次性修复firstConnectedAt跨worker覆盖、当前轮partial提示误判和503伪装未接通三项代码问题，并补齐上表原矩阵的实际中途断连、双活会话、运行中lease loss/进程close/取消后迟到与重复执行计数。使用信号/barrier证明故障发生时机，保留现有通过证据，明确fixture协议链、真实SDK和浏览器证据边界。
交付精确tip、同步包含新E2E的累积patch及SHA256、逐项PASS/FAIL/BLOCKED和原始命令/退出码。B3-07价格审核与导入仍由主程负责，不填造假快照。独立分支继续，不写共享工作区或部署；主程未来仅选择性接入已审差异，保留R34问答/08/预算及列宽整改。

## 新交接报告及bug26114映射核对
已找到并阅读 `BATCH3-LEAD-HANDOVER-REPORT-20261109.md`，位于独立brain目录；分支镜像为docs/refactor/evidence/R33-BUGFIX-BATCH3-COMPLETE-REPORT-20261106.md。用户给出的文件名无需再次提供路径。指纹已记录，作者原文及镜像不改。
其“1–23行四项全部修复、无新增未修Bug、合入上线即可全关”不能作为主审结论：
- B3-01：删除猜测模型/零token假补录是已确认底线，尚不证明seedream实际媒体用量已在原Run及全局日志展示；需实际owned external operation与Run/task/provider证据、接口与UI映射，覆盖成功/失败/未知/未发/取消及重复回调。媒体消费与文本token分开，未知不补造。
- B3-02：12组意图函数测试证明分类改善，不证明真实DSH scope grant及媒体工具链已完整通过；交付相同用户请求的实际SDK/宿主授权链证据，避免将正则命中直接称scope修复完成。不要求为补证擅自发起付费生成。
- B3-03：禁脚本沙箱保持DEGRADED_PREVIEW，64项中相关断言是源码/DOM模拟证据，不能称已实际浏览器验证脚本与Cookie全部拦截，也不能称完整HTML执行恢复。需真实受控产物加载/预览及边界验证。
- B3-05：现有真实503被UI展示成未接通，且首值跨worker覆盖已重现；与交接表的PASS和NOT_INITIALIZED/WAITING实现描述不符。
线上基线也需纠正：fd1f11e是作者R31开发基线。仓库2026-11-06已核验R33部署记录对应生产代码b714e69、54c758c，部署归档和223源指纹见R33-DEPLOYED-FOR-QA-20261106.md及HANDOFF-20261106-R33-QUESTIONS-M1.md；本轮未再次连生产，不把历史状态当当前实时核验。不能写“线上R33旧基线fd1f11e”，更不能据此证明四项失败唯一原因是未合补丁。
作者brain报告头当前标a69bcaf/e051f51，分支镜像头仍标b41dfbc/62425eeb；最终交付应分别冻结运行源码commit ee30815、交付元数据及patch，统一对应关系。ee之后本轮所见提交只改文档，因此无需为上述文档提交重复运行同一源码测试。

## 统一发布状态
本报告不改变R34八包+全部Bug+QA统一范围。Web04的33fc6240已确认native契约及时序局部修复，仍有实际transport/资源/错误脱敏三项原门禁；QA双轨定义修订确认，计费快照及同版本复测未完成；正式部署暂停，Bug-12保持DEGRADED_PREVIEW。
