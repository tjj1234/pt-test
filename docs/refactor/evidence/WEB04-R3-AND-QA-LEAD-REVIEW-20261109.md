# Web04 d3de8d0独立复审与QA报告核对（2026-11-09）
结论：Web04新版本仍不放行，未合并候选、未接共享入口、未部署。新版确有改善，作者5组专项、28断言、首轮3反例及原生接缝10项复跑通过；真实锁定DSH的web_fetch执行/渲染仍失败，取消时序及原transport/流式边界仍未闭环。QA报告主要架构纠偏已确认，不等于R33缺陷已修复或QA重新通过。

## 输入与可复查证据
作者提交 `d3de8d07e5978997feb68322911267f57b6c6d7b`，源码SHA256 `1e8a5b8053e092cb4405ff9416849783301226932ee10bc2fc4db2e24747e28f`，从Git导出至独立目录；作者工作树及共享原回复不改。
[源指纹清单](WEB04-R3-REVIEW-MANIFEST-20261109.json)绑定候选、锁文件、SDK实际源码及QA修订文件。作者锁与本轮SDK安装的package-lock SHA同为 `eb54f12313941e09c569058836b5662b2db82069a1fa721ae1a8b6c0113610d4`。没有依赖全局CLI，没有自建替代模型工具。累积补丁SHA256为 `553b5470aa33ee7af4fcff60eebcf84c0a42ccfe265df8eee5f226977b198004`；在f4a3d39基线隔离应用成功，7文件逐字节匹配当前Git提交。作者DELIVERY-REPORT的完整commit写为 `d3de8d067c29e64d9db6b39ec42c4883ea23cf9e`，与实际 `d3de8d07e5978997feb68322911267f57b6c6d7b` 不符，须修正元数据；这不改变补丁源码匹配的核验结果。
新增探针 `tests/probes/web04-r3-native-lifecycle-lead-20261109.mjs` 实际导入锁定Cordis、WebRuntime和dsh-tool-web；仅模拟工具注册服务、提示服务及后端，真正调用native web_fetch.execute与output.render。见[反例实测](WEB04-R3-NATIVE-LIFECYCLE-LEAD-20261109.txt)。退出0表示探针成功重现所述缺陷，不表示功能验收通过。零网络、零付费调用，所有挂起fixture最终释放。

## 改善确认与完整原矩阵判定
构造及请求maxBytes有限整数/10MB校验、DNS等待纳入联动signal、500/404拒收及常见token脱敏改善确认。向后端传递AbortSignal证明取消通知接通，尚不能证明实际socket/流/后台任务已销毁。

| 原门禁 | 实际源码/运行结果 | 本轮判定与一次性完成要求 |
|---|---|---|
| W04-R1-01 IP与域名 | 旧私网IPv6/回环等样本通过 | 保留原完整地址/DNS矩阵，不以有限样本替代完整策略 |
| W04-R1-02 transport | customFetcher请求只收到url/timeout/maxBytes/signal，没有绑定已审DNS地址；hops/finalUrl仍在fetch返回后检查，默认DNS无resolver直接空数组 | 未闭环。交付实际受信transport接缝及配置/依赖证据，请求前每跳检查并绑定连接；后验拒收不能证明没有请求私网。先核查锁定原生实现，确有缺口才最小补充 |
| W04-R1-03 生命周期 | DNS及后端超时可结算并收到signal，但超时被记RUN_CANCELLED；同步启动customFetcher时触发外部abort，因先启动后监听漏事件，40ms后仍pending（timeoutMs=5） | 未闭环。先安装监听并检查already-aborted，再启动；统一覆盖DNS/连接/重定向/读取/cleanup。保留FETCH_TIMEOUT和用户取消区别；证明实际资源关闭，不只断言signal.aborted |
| W04-R1-04 资源上限 | maxBytes=Infinity已拦截；实际计数仍在fetch返回完整content后进行，search先遍历全部命中再slice，title等总输出未闭环 | 部分通过。真实读取/解压/输出有界，证明早停；对所有返回字段类型及状态做严格验证。NaN statusCode本轮仍被当作成功 |
| W04-R1-05 证据/错误 | search摘要hash仍命名contentSha256；sanitizeError保留合成Cookie及本地私有路径 | 未闭环。摘要与正文证据分型，可信宿主身份由主程绑定；错误按公开结构返回，保留字段不得泄漏Cookie/内部路径或通过cause带出原始敏感内容 |
| W04-R1-06 原生接缝/可用性 | 实际DSH要求body.kind，作者返回body.type；成功execute产出kind=undefined、render抛错；HTTP500分支没有body，execute抛TypeError。fetchBackend可使available=true但fetchPage未使用它、实际返回403 | 未闭环。按锁定SDK完整返回类型适配；真实web_fetch execute+schema+render+历史回放、非2xx和取消全部覆盖；available与实际后端一致，注册/撤销及并发仍按原矩阵验收 |

作者DSH10项探针只执行了web_search模型工具；ctx.web.fetch断言还要求body.type，未检查真实web_fetch的body.kind及渲染。这解释了“10项通过”和本轮真实工具失败能同时出现。依赖路径复跑仅把测试的root改为已有锁定安装，未改候选或断言。首次旧反例脚本因未设置WEB04_REVIEW_ROOT启动失败，补上必需环境后通过；该启动错误不算候选缺陷。

## 给Gemini的可直接转发指令
继续当前独立分支，按W04-R1-01～06原矩阵一次性闭环，不只修主审样本。优先修native web_fetch契约：body使用SDK的kind字段，非2xx保持真实status并满足native返回结构，不能缺body导致TypeError，也不能将失败正文包装成功引用；transport异常使用正确类型错误。覆盖真实工具execute、输出schema、render、历史回放，而不是只测service或web_search。
其次统一生命周期原语，监听安装先于后端启动，涵盖同步取消、already-aborted、DNS/连接/读取各阶段取消、deadline原因、晚结果及实际资源销毁。transport必须有请求前逐跳/DNS连接绑定与流式限额的真实证据；现有后验hops检查及完整正文返回后计数不可称完成。仍优先复用锁定DSH，确有缺口时提交最小后端接缝，不自建工具引擎。
同步完成返回字段/状态有效性、错误脱敏、后端可用性和证据分型。交付冻结CONTRACT、原矩阵逐项PASS/FAIL/BLOCKED、可复跑命令/退出码、精确commit与补丁SHA；如果真实后端或资源未具备，诚实标BLOCKED并列具体依赖，不写全链路全数完成。共享Run/预算/来源入库由主程接线，不改共享入口、不部署，08选择器不重复开发。

## QA修订报告
已读当前修订版。保留失败Run、有效首参、两阶段错误与STORE_UNAVAILABLE，并撤回路径/RPC推测、明确本地复现不能证明正式根因，这些修订确认。原验收未放行状态不变，无新增生产测试。
另有两处需编辑修正：①真实新表是agent_run_questions、agent_question_scopes，不是报告所写user_questions；本轮最小权限是SELECT/INSERT/UPDATE，不包含DELETE，避免笼统CRUD引导过宽授权。②隔离复现验证的是实际question service的存储失败及补权恢复，没有执行线上原Run或完整宿主RPC/模型重试链；将“并向上波及RPC触发TOOL_REQUEST_FAILED”保留为与线上现象相符的待核验解释，不能写成隔离实验已经完整验证。
原QA文件不整份复制入Git，仅保存指纹与上述非敏感结论；不替QA修改其独立报告。

## 发布边界
R34仍为八包+全部Bug+QA整改统一包，原第三批Bug882f532尚待真实HTTP/持久链证据。运行账号数据库门禁已实现，但未运行生产。没有重复部署、合并候选或覆盖并发工作；整体范围中的其余阻断继续保留。
