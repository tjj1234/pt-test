# r19原生工具Run归属与预算门禁
结论：Runner在DSH原生tools/execute接缝补齐身份、当前调用轨迹、取消和白名单预算；既有宿主工具保持单次计数。默认产品没有因此打开联网/Skill/提问，公网provider、用户问答/审批和Skill发布仍需产品接线。复用原生工具与执行器，不重写搜索、Skill loader或OS工具。

## 实际新增行为
- 执行对象必须引用当前Run确切Agent对象，且其rootCallId/callId属于本轮原生tool/call轨迹；直接调用名称必须一致。热会话复用同一Agent时，旧Run记录不能自授权新Run。
- 取消/已abort、过期、预算未配置、未知或未白名单的原生工具、工具次数耗尽均在body/provider前拒绝，固定脱敏错误，不回显身份/参数。
- 原生候选仅ask_user_question、skill、web_search，全部还要求显式allowedTools与当前Run预算。web_fetch与OS/代码工具未放行。没有更改默认模型/工具次数、输出token上限或媒体授权规则。
- 已有get_current_time、media_route、csv_analyze、GA等宿主工具仍由原包装器及RPC做预算/RBAC/持久处理；原生门禁验证归属后不再重复计数。

## 验证
| 层次 | 证据 | 结果 |
|---|---|---|
| 原生真实工具/服务 | native-tool-run-gate-sdk-test.mjs及native-tool-run-gate-root-call-20261031.log | 真正加载dsh-tool-web的applyWebSearchTool；显式允许后native provider被调用1次、工具计数1；热会话撤销允许后provider不再调用、工具计数0 |
| 负向 | 同测试 | 错Agent、旧Run callId、错名称、取消/abort、过期、未配置、OS工具及0预算均拒绝；provider为内存替身，无公网流量 |
| 宿主兼容 | native-tool-run-gate-focused-20261031.log | 5/5；真实SDK两会话并发/取消/热切换，B实际2次宿主工具计数仍为2、3次模型为3 |
| 产品链兼容 | native-tool-gate-product-compat-20261031.log | CSV、媒体与Office真实SDK/HTTP同链3/3（rootCall补强前）；rootCall补强后另做确切r19验证 |
| 确切r19 Linux归档 | r19-exact-archive-linux-20261031.log | closure495/31007 PASS；原生门禁、原宿主SDK及Office/媒体/CSV共5/5 |
| 冻结后完整默认 | r19-default-regression-20261031.log | 239/239，0失败；未将未交付Context R3自动发现测试当正式主审或生产接入 |
| PostgreSQL层 | r17-postgres-regression-20261031.log | 本轮真实PG16多连接4/4；r19未改SQL/存储源码，沿用同源码证据，不声称又跑了PG |

r19 SHA `7eb6d84fe8f2aa810f7f966071f0c11bed2b5a3a6f46b3ce10bc3b03dc6798eb`，198源码/399成员；build/check/audit/活动指针PASS，仍DRAFT_NOT_FOR_DEPLOYMENT。r17办公文档链保留；r17/18旧归档未覆盖。r18默认回归虽238/238，但运行期间补了当前调用轨迹检查，作为开发过程日志保留，不替代冻结后r19的239/239。

## 原生接缝核对与剩余范围
user-questions服务是ctx.userQuestions，模型工具为独立dsh-tool-ask-user；approval是dsh-user-approval的approval/request与原生日志事件，不能误用credential authorization服务代替工具审批。下一接线复用原生协议，宿主仅负责owned持久等待/回复、取消/超时与UI。普通提问或plan-review答案不能扩大媒体/OS工具授权。
锁定tool-web支持search-only配置；当前安装的搜索provider为dsh-web-search-deepseek，含额外模型HTTP调用，不等同免费DuckDuckGo。settings中的web-search-pro段不能证明插件存在或生效；打开公网搜索前必须解决可信provider配置/调用归属/预算/同Key资格。任意fetch继续关闭。
推理R3正式交付后独立主审仍有缺口；主线改用现成DSH resolveModelInfo/resolveCallWithInfo，见GEMINI-DSH-REASONING-R3-MAIN-REVIEW-20261031.md。不等待运维即可继续这些代码接线；目标配置和真实上游验收继续单列。
