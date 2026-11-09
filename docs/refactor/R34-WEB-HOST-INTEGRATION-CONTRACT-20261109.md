# R34可信联网：主程共享接缝与集成验收契约（2026-11-09）
结论：本契约固定Codex负责的接线和证据范围，尚未实现或启用这些新接线；不把主程缺口转给Gemini。Gemini33fc6240的provider修复与真实transport/资源/脱敏三项待交付仍按WEB04-R4报告处理。普通问答预算、05问答provider、08持久预留及现有发布物不改。

## 锁定原生与本轮实际核验
锁定SDK已具备ctx.web registry及原生web_search/web_fetch；33fc候选真实native fetch execute/render已验，不需要自建工具引擎。当前主程persistent-runner的native工具集只有ask_user_question、skill、web_search，尚无web_fetch；默认maxToolCalls=0，questions profile仅允许ask_user_question，adapter也没有web专属profile传递。不能将“SDK存在工具”当作产品入口已开启。
`tests/probes/r34-web-host-characterization-20261109.mjs`复用既有真实DSH SDK/Runner门禁夹具，记录native provider请求字段，并增加web_fetch调用前拒绝断言；1单元通过，零网络/付费调用。结果：native search请求没有可信runId/tenantId；即便传入包含web_fetch的policy，当前guard仍拒绝、body执行0次且不扣预算。证据`evidence/R34-WEB-HOST-CHARACTERIZATION-20261109.txt`。这些是当前缺口的特征验证，不是新web能力PASS。
现有native-question-provider已用AsyncLocalStorage及真实execution/active-turn/step关联校验；主程可沿用该模式增加web专属绑定或提取共用机制，保持问答既有合同。`resolveContext(request)`不能从native query/url推导可信身份，不能填dsh-run/dsh-tenant占位值来宣称隔离。

## 责任与接口
| 层 | Codex共享接线责任 | Gemini04候选责任 |
|---|---|---|
| 产品准入 | 冻结现有产品入口及服务端启用条件、当前用户/Run权限，缺配置诚实不可用；不暗增默认预算 | 返回明确可用性和依赖/后端配置契约 |
| 工具执行 | 复用DSH tools/execute实际execution，在native预算成功准入后绑定当前active对象、agent、session、run、tenant、call/rootCall、signal | provider只消费主程注入的resolveContext，不接受model参数覆盖身份 |
| 可信授权 | 宿主从当前认证身份与Run闭包取得user/tenant；每次调用前和异步准入后复核owned Run、lease、期限、当前配置/版本、取消状态 | 执行已批准域名收敛、受信transport逐跳/连接策略与有界读取消费 |
| 预算 | 显式web profile、单次工具只扣一次；多query/fetch/redirect网络次数与总输出有界；额外模型调用复用同Run模型预留和审计，未纳入时不得启用该计费后端 | 报告真实backend是否调用额外模型/产生费用，不用provider名称或布尔值充当计费资格 |
| 来源持久化 | 在owned Run事务/事件及现有来源/产物接缝中保存结构化证据，UI/历史可恢复、跨用户拒绝；按现有schema实际适配后才定迁移 | 标明search_snippet/page_content、实际最终URL、状态、时间、正文或摘要各自hash、真实字节数与明确错误；不得伪造正文hash |
| 生命周期 | 暖agent换Run后旧执行不可复用；失租约/取消/过期后旧结果不可发布；同call/操作幂等与重复异参拒绝 | 实际连接/流资源终止，晚结果不继续发布，错误公开层不泄漏原始凭据/cause |

## 冻结的执行顺序
1. 原生工具execute触发已存在的Run guard；校验agent、当前call/rootCall及step log，再按显式profile准入并只扣一次工具预算。
2. 作用域绑定只来自trusted active turn及host cmd闭包。provider所见query/url不具有授权含义；候选resolveContext读取当前绑定。工具执行退出时作用域自动退出，异步尾回调仍需检查active对象是否仍为当前Run。
3. 调用宿主前检：owned Run/lease/期限/政策/后端来源在权威事务点复核；慢等待跨取消/期限/换Run后拒绝。网络分支和额外模型分支分别受有限准入，重放不能重复未知提交。
4. 受信provider执行真实transport策略。wrapper的signal与maxBytes转发本身不足以证明连接/读取政策完成，先验收具体backend。
5. 接收结果后复核身份、活跃Run及deadline；结构化区分摘要与抓取正文，在受约束的来源持久化点线性化。持久化失败不能宣布来源已保存，不能靠重发外部操作补偿；取消后不出现孤立来源/错误成功提示。
6. native工具按锁定schema执行、渲染并记录历史；前端从owned接口取得引用，刷新/重开与原Run一致。

## 主程集成测试矩阵
| 范围 | 固定验收条件 |
|---|---|
| 身份/并发 | 缺Run、伪造tenant/user/call、跨agent、旧暖Run、并发两session、rootCall不符均在网络前拒绝；真实同Run成功 |
| 预算/费用 | 默认不放宽；search多query/fetch路径有界、每工具只扣一次、重复键受控；额外模型请求记入同Run并经过08 gate，未知费用不重提 |
| 生命周期 | 前检前/等待授权/网络中/结果返回后/持久化中取消与过期，慢存储跨期限，失lease、旧结果/重复终态、cleanup均测 |
| 协议/来源 | search及fetch实际native execute+schema+render+历史；非2xx不冒充成功正文；摘要/正文hash可追溯真实fixture响应 |
| 持久/租户 | 真数据库重开、跨user/tenant读取拒绝、同call同参幂等/异参冲突、来源删除与重新打开、不留孤儿结果 |
| 产品 | 真实本地HTTP与浏览器点击/输入/刷新/重开/引用查看，配置缺失/撤销与错误清晰；最后同版本正式QA |

测试用既有真实SDK、受控本地服务和生产仓储；无真实后端的阶段标BLOCKED。profile、闭包锁、adapter映射、Run/服务端启用、结构化来源、UI/历史须一同验收，单独把web_fetch加入known set不等于完成。
本契约与原04任务书/WEB04-R4复审共享边界；若作者真实后端仍缺依赖，应记录具体依赖，由主程协调，不继续让用户循环转发零散反例。
