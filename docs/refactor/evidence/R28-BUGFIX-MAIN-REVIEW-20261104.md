# r28 20项Bug修复主程初审：存在阻断，暂不合并发布
2026-11-04｜结论：**NEEDS_REVISION / MERGE_AND_RELEASE_BLOCKED**。已接收[作者交接](../CODEX-BUGFIX-HANDOVER-20261104.md)，核对分支拓扑、五个生产文件diff与四份自测，复跑作者测试和真实PGlite仓储回归，并对新增HTML/错误流式代码执行源码绑定隔离反例。发现3项确定缺口；“20项已全部自测”不能替代修复后独立业务复测。
本报告可直接转交Bug修复作者做局部补丁。08原候选修正属于另一条交付链，不混入本候选；不需要重新做全部20项或重写任务包。

## 1. 接收事实、版本与工作区

| 项目 | 核实结果 |
|---|---|
| 主工作区 | `/Users/mmdn/Downloads/pt项目`，`feature/northstar-integration-20261102`，HEAD仍`bbd9997d1e19920dc1c850c31ec6c71dbc5994d1`；已有文档/证据脏文件保留，未checkout/merge/reset/clean |
| Bug候选 | `candidate/r28-bugfix-full`，tip `d37c7f4c38a0ab6db584a421b30fb7f04d051ca2`；实际worktree `/private/tmp/pt-fix-batch4`在`fix/bug-batch4-presentation-output`，审核前后无未提交改动 |
| 祖先关系 | merge-base为`bbd9997`；13806fa→6b932ce→5b941d6→27f4731→0f0bb52→d37c7f4，最终tip已含四批修复，无需重复cherry-pick |
| 范围 | 5个生产文件、4个测试、7个交付文档；生产代码合计+240/-35，含测试/文档总计16文件+1779/-35；无依赖锁升级。作者“+618/-35”是不同统计口径，不作为最终源清单 |
| 并发 | 已见独立08修复worktree`/private/tmp/pt-fix-auto-08`，未访问/改动其修复内容，本报告只审Bug候选 |
| 证据边界 | 没有SSH/目标配置探测、真实PT/付费、线上测试、服务重启或发布；没有合并此分支 |

报告中“线上未补丁、版本为bbd9997”仍是作者描述，本轮未到服务器核source-binding，不能据此给整份E2E报告绑定精确部署源码。修复后独立测试应绑定新候选归档SHA、配置/profile/迁移及测试版本。

## 2. 三项已复现的接入阻断

| 编号/级别 | 实际代码与复现结果 | 必须局部修正 |
|---|---|---|
| BR-HTML-01 / P1数据正确性 | 候选`server.cjs:1398–1402`每次都写租户根`report.html`，两次生成得到相同URL；执行候选原块两次，第二次将第一份真实文件内容覆盖。旧对话成果引用不再指向原内容 | 使用Run/operation绑定的唯一产物路径及不可变文件/版本，复用既有产物协议；重复同操作幂等，不覆写既有文件，不把同名展示名当实际存储名。测两个Run/会话并行、历史重开/下载及重复完成事件 |
| BR-HTML-02 / P1写入边界 | 同位置`fs.writeFileSync`跟随已有`report.html`符号链接；隔离fixture中链接指向租户目录外的合成文件，运行候选原块后该文件被改写。现有读端openat/O_NOFOLLOW防护不能保护这个新写入口 | 写端也要安全锚定授权根、防链接/竞态/硬链接别名、独占创建及原子发布；复用已有安全产物发布能力或最小受控接缝，不只用生成随机名代替安全打开/发布。测试软硬链、目录替换、磁盘失败、原文件不改。未做安全写端前不启用该物化路径 |
| BR-STREAM-01 / P1原Bug未闭合 | 候选`public/app.js:1299–1303`以整个历史`some(role=assistant)`决定是否保留acc。已有任意旧assistant时为true，即使本轮部分回复尚未落历史，也不会追加；原块执行反例中CURRENT_TURN_PARTIAL丢失 | 以本轮Run/message归属和完整性判断，而不是历史是否出现过assistant；失败/取消/重连都保留本轮已接收且未持久化的内容，同时防重复渲染/跨会话串入。同步核对约1357行另一处同类逻辑，实际浏览器测第二轮及多轮异常 |

上述验证**执行的是交付commit中的原代码块**，没有复制重写业务算法：HTML部分使用真实临时文件及真实artifacts.normalizeArtifact，前端部分执行原错误分支并记录渲染调用。它们是源码绑定的隔离行为证据，尚不是完整HTTP/浏览器E2E。软链接反例证明写端缺保护，但未证明生产普通用户能远程创建该链接，不宣称已发生越权事故。所有fixture独立创建并清理，未写用户/生产文件。

## 3. 测试结果与作者证据差距

| 检查 | 结果/限制 |
|---|---|
| 作者四套Bug测试 | 本轮在候选worktree实际复跑13/13 PASS；其中batch1为硬编码CSP/复制意图与预算函数，batch2为复制粘贴/输入/取消模拟，batch3部分真实模块但selectChatModel与UI过滤为复制实现，batch4主要源码正则和mock SQL。通过不能证明真实入口/交互正确 |
| 原task-store回归 | 首次缺worktree的PGlite依赖而失败，属于测试环境缺依赖，不记代码回归失败。通过现有文档支持的PT_PGLITE_PATH指向主工作区已安装模块后，真实隔离仓储回归1/1 PASS，无生产DB配置 |
| 新独立反例 | [探针](../../../tests/probes/r28-bugfix-main-review-20261104.mjs)：3项全部FAIL，退出1，错误原样保留；[机器证据](R28-BUGFIX-MAIN-REVIEW-20261104.json)绑定candidate tip及server/app源码SHA |
| 作者UI声明 | 交接标AUTHOR_UI_TESTED，但所读TEST-EVIDENCE未提供可绑定当前候选的实际浏览器步骤/截图/trace证据。需补，不能以13项模拟断言代替 |
| 图片/媒体真实链 | 原E2E提供历史样本，但未证明此修复tip的409、原流式保留、冷缓存视觉及完整视频结果链已通过。配置待办与代码待验分别列，不凭补配置即可宣称全解决 |

复现命令（均无PT请求）：

```sh
# 在 /private/tmp/pt-fix-batch4 运行原13项，退出0
node --test tests/regression/batch1-bugfix-test.mjs tests/regression/batch2-bugfix-test.mjs tests/regression/batch3-bugfix-test.mjs tests/regression/batch4-bugfix-test.mjs
# 同一候选工作区，显式使用已安装PGlite，仅使用测试自身的临时DB/密钥
PT_PGLITE_PATH='/Users/mmdn/Downloads/pt项目/shell/node_modules/@electric-sql/pglite/dist/index.cjs' node --test tests/regression/task-store-test.mjs
# 在主工作区运行独立反例，当前已交付tip预期退出1
node tests/probes/r28-bugfix-main-review-20261104.mjs --candidate /private/tmp/pt-fix-batch4 --report docs/refactor/evidence/R28-BUGFIX-MAIN-REVIEW-20261104.json
```

## 4. 仍需补证据的共享改动（不是本轮已确认的新事故）

| 范围 | 复审需要 |
|---|---|
| 资料删除 | 新onRevoke在等待约1秒后直接将cancelling/queued推进cancelled。必须证明真实worker/租约/旧Session已安全停止或隔离，不能只改DB终态使drain检查通过；用实际source store/执行器与活动Run测试 |
| 工具预算 | 时间工具直接绕过budget.admit。验证总模型/时长/取消仍有效、重复时间工具不会绕开全部上限；原测试手写admit不能证明Runner包装层有效 |
| 模型资格/环境 | 标准媒体目录条件由`===standard3`扩大到`!==off`，AUTO视觉失败改用manual候选。给出明确允许范围、provider配置和当前Key资格/审批证据；不借Bug修复解锁原受限模式或未经授权收费验证 |
| 内部鉴权 | 新ensureTenantAnalytics实际会请求内部token签发，需要真实本地业务服务验证身份/tenant绑定、缺配置/服务故障/缓存失效/并发；原batch1没有验证该链，配置项存在不证明403修复 |
| 日志分页 | 真实task-store全套通过，但新增created_at分页需同时间戳/跨页/无效或他租户cursor专项；cursor时间查询当前未带owner/tenant过滤，要明确拒绝或安全作用域语义，不宣称有直接数据泄露 |
| 会话恢复 | 删除agentMap后仍有sessionKey/原生Session/close语义需证明；真实失败→同会话下一轮与历史/来源/审批/外部未知状态完整。源码出现delete不能证明恢复 |
| 上传文件修改 | persona解释只读不能替代修改后文件；Bug-07对文件任务需真实新产物可下载重开，不能在复测标准中用“回答中给出表格或文件”无条件替代 |
| 复测版本/性能 | RETEST-CHECKLIST仍标27f4731，当前tip d37c7f4为后续文档提交，需明确二者生产源码相同并统一版本引用；<50ms/内存<5ms不等于浏览器全链已测，须有测量条件 |

这些要求与[已交给作者的交付要求](../BUGFIX-INTEGRATION-REQUIREMENTS-20261104.md)一致，不新增整套重构。代码错误先修；配置/真实PT缺证据按CONFIG_PENDING/BLOCKED保留，不让作者自行改生产env/Nginx/白名单。

## 5. 原作者下一份补丁交付与放行门禁

1. 在原隔离修复工作区/分支或新独立修复分支，基于明确tip提交BR-HTML-01/02与BR-STREAM-01局部修正；不要往主工作区覆盖文件，不混入08修复、原8包或新功能。保留当前交付证据，不改写历史报告为“此前已通过”。
2. 针对真实实现补行为测试：产物不可变/安全写入/同操作幂等、旧assistant历史下本轮增量保留；优先可测试接缝，不用另一份手写函数替代原实现。原静态测试可保留辅助，但不能仍作为主要关闭证据。
3. 对第4节逐项给结果或明确依赖；必要的代码修正保持局部，涉及行为变更/权限范围扩大先提出可审方案，不自动放宽门禁。没有真实PT授权则交本地协议证据及受控真实复测方案，不试跑收费模型。
4. 交base/完整tip、文件清单、逐Bug状态、真实命令/退出码/证据、配置差异与未决风险。主程复审通过后才集成测试候选，交独立工程师对精确版本复测，再决定正式发布。

当前决定：**不快进合并、不上线、不改生产配置。** 原作者局部修正待交；本报告已写入总台账作为Bug候选接入门禁。缺陷修复和配置验证分别收口，不能以13项PASS或报告“20项完成”跳过本门禁。
