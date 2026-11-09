# Web04 33fc6240复审：接缝修复确认，真实transport仍阻断（2026-11-09）
结论：原生工具契约与已报时序问题的局部整改确认；04整体仍BLOCKED，不合并为可用生产功能、不部署。剩余为原W04-R1-02/03/04/05矩阵中的真实transport、资源上限/关闭和错误脱敏，不增加新功能范围。QA两份文档的双轨计费口径修订已核实，计费发布门禁仍未通过。

## 精确交付与复跑
提交 `33fc6240ce0aa597f766ba99140db5b9e611c625`；源文件SHA256 `617afcfd5cb61d3a357c8a5995975dafc7f778e9ba88c87ab2ff9bfcbe0adc07`；累积补丁SHA256 `e6fa7fcb3b6c8de1ea4599af9725876d6d63d3b77278f7fdbe2d403431b1ce75`。补丁在声明f4a3d39基线隔离应用成功，9文件与提交Git blob逐字节匹配，完整commit元数据此次已改正。
6组真实SDK修复验证、R2的5组、作者28断言、首轮3项及原生接缝10项均复跑通过。SDK使用现有锁定安装，lock指纹与历史同为eb54f123...；10项/3项探针只在临时副本调整依赖根路径，候选和断言不改。[版本与两份QA文档指纹](WEB04-R4-REVIEW-MANIFEST-20261109.json)。原作者工作树、历史主审探针及QA原文均不覆盖。

| 能力 | 本轮独立核验 | 状态边界 |
|---|---|---|
| native web_fetch成功与500输出 | kind字段保留，execute与render可运行；错误分支有body | LOCAL PASS；真实后端及生产接线未验 |
| 同步取消/超时分类 | 后端前安装监听、同步取消及时返回；FETCH_TIMEOUT与用户取消可分辨 | LOCAL PASS；实际socket/流关闭待证 |
| statusCode=NaN与fetchBackend | 无效状态拒收、fetchBackend真正被调用 | LOCAL PASS |
| snippet证据 | 新增snippetSha256和evidenceType，正文有page_content标记 | 改善确认；host来源存储与历史仍由主程接线 |
| 实际transport/DNS/重定向 | 只给callback传resolvedIps，未交付使用它绑定真实socket并逐跳拦截的后端 | BLOCKED，W04-R1-02未完成 |
| 读取/解压限额与资源关闭 | 仍在完整content返回后计数，mock后台可在signal.aborted后继续挂起 | BLOCKED，W04-R1-03/04需实际后端证据 |
| 全路径错误脱敏 | 多项Cookie的后续值仍进入公开provider error.message和原始cause | FAIL，W04-R1-05未完成 |

## 剩余三项完整交付要求
### A. 实际受信transport（原W04-R1-02）
本轮新探针确认resolvedIps参数已传递；传递数组与实际socket lookup绑定是两件事。callback返回后才检查hops，证明的是后验拒收。DNS返回空数组时仍会启动callback并接受正文；尚无可用后端的可信约束证明。以上均是合成callback调用顺序实验，没有实际访问任何私网，不能将实验称为线上SSRF利用。
下一交付应包含具体transport工厂/实际后端实现或锁定原生provider已经落实上述约束的源码与实测证据：连接前审核全部DNS结果、绑定实际连接并保留HTTPS证书/主机名验证、每次重定向请求前审核、最终目标核验。明确失败及无配置时不可用。先核查DSH原生，再复用现有实现；本仓库 `shell/media/pinned-asset-fetch.cjs` 已有固定DNS lookup、manual redirect和signal接缝，可评估复用其连接机制，但媒体专用Accept/IPv4范围/用途不能未经审核直接改宽或宣告适用于web。
锁定ctx.web的WebRuntime是registry/selection/delegation服务，工具包装不构成网络transport保证。现有web-search-pro YAML配置同样不能单凭文本证明插件已加载且满足出口政策；提交实际加载来源、版本与执行路径证据。
### B. transport中的限额和资源生命周期（原W04-R1-03/04）
新增合成测试在maxBytes=8时让backend先消费24字节再返回，wrapper随后拒收；证明wrapper本身不执行流式读取限额。超时可让wrapper返回FETCH_TIMEOUT、signal变aborted，但不配合的fixture仍active，直至测试主动释放。平台无法凭任意callback的Promise强行关闭其内部资源，因此必须由明确受信transport实现并验证socket/流销毁、读取消费停止和迟到结果不发布。
验收必须覆盖连接、重定向、响应头、读取、解压各阶段的限额/超时/取消/异常与清理。交付可检查的request.destroy/流cancel或等效真实后端终止证据、无后台继续请求/读取，以及可复跑的资源计数。所有返回与输出数量/字节边界继续按原冻结矩阵验收，不把全量读取后Buffer.byteLength或signal.aborted单项作为完整证明。
### C. 公开错误与证据边界（原W04-R1-05）
本轮复现合成多项Cookie：`Cookie: sid=first; preference=<合成标记>` 第二项仍进入公开异常message和cause；单字段regex样本通过不足以证明全路径脱敏。建议公开层只返回审核错误码/固定摘要，原始错误仅进入受控诊断并执行结构化脱敏；公开cause不能携带原始敏感消息。覆盖多Cookie、Set-Cookie、Authorization及URL凭据/查询参数、内部路径、嵌套cause，使用合成标记验证，无真实凭据。
完整CONTRACT和逐项矩阵要如实标注哪些由DSH原生保证、哪些由具体backend保证、哪些主程接线；没有实际实现/资源的项标BLOCKED并给具体依赖。下一提交交付以上三项整体证据、精确commit及patch指纹，不再以局部probe数量宣告全链路完成。

## 可复跑主审证据
`tests/probes/web04-r4-transport-evidence-lead-20261109.cjs`，环境WEB04_REVIEW_ROOT指向精确作者导出。[实测记录](WEB04-R4-TRANSPORT-EVIDENCE-LEAD-20261109.txt)退出0表示成功确认局部改善及重现上述边界，不表示04通过。零网络/付费调用；挂起fixture已释放。

## QA双轨计费文档核验
已读取当前 `R33_FULL_INDEPENDENT_QA_ACCEPTANCE_REPORT.md` 与 `MASTER_PRODUCT_FEATURE_AND_TEST_SPEC.md`：官方实扣按相同账号/时段/币种/记录一致，本地估算按审核快照与实际用量可复算，USD/credits无明确规则保持unknown。门禁3及估算FAIL保持。此次定义修订确认，QA可按该口径准备同版本复测，无需继续反复修改定义。
“官方实扣通过”现阶段登记为QA报告结论，并未由主程重新访问供应商或正式环境独立复核。报告展示三次余额变化合计10 credits、官方当期汇总17 credits，二者覆盖范围不同；聚合账单/余额差不能单独证明逐Run逐请求及本地展示一一归因。后续复测应保留相同scope的本地响应与官方记录关联证据，缺少关联字段时登记该关联项BLOCKED，保持账单汇总与单次估算分开。此处不要求为补证重复发起付费调用。

## 协作与发布
Gemini继续以上原矩阵未闭环项，保留已确认的provider修复；共享Run/预算/来源/身份接线仍由Codex负责。08选择器不重复开发，第三批Bug分支已出现新tip ee30815（增加HTTP/Run/adapter/DB测试），本轮仅发现并登记，尚未复审或据此放行。新累积补丁含历史主审探针文件，未来选择性集成应保留主程现有探针，不直接整包覆盖。R34仍按八包+全部Bug+QA统一交付，正式部署继续暂停，Bug-12保持DEGRADED_PREVIEW。
