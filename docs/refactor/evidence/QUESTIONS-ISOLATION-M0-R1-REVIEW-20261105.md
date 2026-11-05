# 05/06 M0修订复审：部分认可，仅放行问答与关闭执行的切片
结论：M0_PARTIAL_ACCEPT / M1_QUESTION_ONLY。主程确认可复用UserQuestionService/registerProvider/ask与原生ask_user工具；候选仅补宿主问答待决记录、可信身份/Run关联、取消/期限、幂等和原生答案适配。批准schema标识为2026-11-04.1的普通问答预览基础（非完整授权schema验收通过）。任意脚本关闭；尚无可信安全FS读取方案，只读也BLOCKED。完整批准签发/消费接线尚未认可。不得把本切片称05/06整包通过。

## 本轮实证
逐项计算回应报告的32个完整依赖SHA，32/32匹配。固定主线bbd9997、候选ref fb250a9未变；作者已撤回整项COVERED，5个新增失败反例已正确纳入。SpillStore更正、options保序、DB提交后响应、普通answered与approved分离、脚本关闭方向认可。SHA匹配证明依赖一致，不证明真实运行装配或SDK审批链通过。
原作者3个SVG实际存在，大小与声明一致；其render-report的3个source hash均不匹配当前文档，第一张状态图的diagram hash也不匹配，其他两图diagram hash相同。主程已独立重渲染当前源，证据单独存m0-mermaid-main-review-20261105/render-report.json，不覆盖旧报告；渲染仅证明语法和产物生成。

## 必须随下一份设计修订闭合的原项（不新增范围）
| 项/已有门禁 | 核实结果与本次明确处理 |
|---|---|
| M01：真实参数接缝 | 真实ApprovalRequest仅agent/toolName/callId?/reason?/signal?；不存在req.tool、ApprovalRequest.spec或报告所称ToolCallSpec导出。本地dsh-tools类型确有tools/pre-execute与ToolExecution.arguments、name、callId、agent，以及单调拒绝guard，但这是待验证接缝，不等于可直接从approval/request取参数。审批切片先做真实SDK探针，说明按Agent/Run/call绑定服务端不可变规格、最终执行参数不漂移、无callId时拒绝。未核实前不签发可消费Grant、不另造审批循环 |
| M04：安全只读 | O_NOFOLLOW只约束叶子；fstat确认文件类型不证明该fd属于可信根，随后realpath检查的路径可被换回。FIFO以O_RDONLY同步open可能在fstat前阻塞；本机fs.constants.O_CLOEXEC未导出，不能把undefined按位或当有效保障。当前方案不能放行只读，删除“safe open就安全”的承诺；保留关闭，后续明确可信句柄/安全路径机制及平台支持再申请。不得直接拿原生fs读取始终放行作租户隔离 |
| M03：真实事务 | grants.run_status字段条件不自动保证与权威Run取消一致；需同一仓储事务/锁定顺序或等价机制明确撤销与claim线性化，启动前检查不能消灭检查后的取消窗口。不得宣称取消后绝无已开始副作用。本轮无执行切片先不实现运行进程；PG/PGlite沿现有仓储，不因AC例子引入SQLite。原生approval审计与宿主DB不在同一事务，须说明允许结果与Grant可用性的时序及故障状态 |
| M07：所有权/工作树 | 禁止所列worktree remove --force、add -B及吞错误的恢复方案：旧目录是否丢失原因未经证明，先不清理注册或回退同名分支。后续从fb250a9329d5be0a36b5c000a463f644c7a61949建全新名称与唯一目录的worktree，不改旧ref。保护shell/server.cjs/auth.cjs等真实入口及所有共享依赖；原有questions-isolation主审探针归主审，不授予通配修改权 |
| M06：验收责任 | 作者列表实际28项，不是24；与主程6项、外部6项共40，统一文字。F02“已捕获allowed-once”和F03“tool循环原型”缺实际命令/源码绑定证据，先标未经本轮核实。F27本包安全FS责任不能全交外部QA；作者先设计/自验，QA独立复测。旧8+5断言按相应切片重放，FS关闭只证明拒绝安全，不代表读取能力通过 |

## M1本次实际允许范围与交卷
允许新分支fix/questions-m1-slice-20261105，唯一独立worktree目录；在执行前核对base与目录未占用，禁止重置/移除旧分支或共享工作区。候选改动仅questions/isolation两候选目录，新增作者探针限定tests/probes/questions-isolation-author-m1-20261105.mjs；设计继续原目录，交卷报告放docs/refactor/deliveries/questions-isolation-m1-20261105/。不覆盖主审探针、历史JSON、包正文、锁或共享入口。
1. 实现普通问答原生provider适配、持久待决/权威状态接口与真实隔离仓储测试；缺宿主鉴权/仓储时fail-closed，不以Map测试替代生产权威。候选可提供注入接缝，主程后续统一装配。
2. 任意脚本执行和未获批准的FS入口无条件拒绝，包括hasIsolationBackend=true等旧绕过，不启动子进程、不打开用户路径。无真实审批参数映射时批准操作返回明确不可用，普通custom/选项永不签发执行Grant。
3. 源码与探针绑定固定tip，至少覆盖普通答复/自定义、NO不授予权限、快照、异参、deadline、取消、provider失效、身份拒绝、存储失败、重启不复活Promise与禁执行所有入口。原13反例按切片明确保留/通过/因关闭而拒绝/未完成功能，不虚报全部能力完成。
4. 交M1补丁与逐AC证据后主审。M01授权接缝和M04只读仍可独立补方案，不阻塞已准普通问答施工。共享profile/SSE/UI集成由主程审后执行，staging及执行后端保持后续门禁；未授权部署或真实PT调用。
