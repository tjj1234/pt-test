# 05/06 M0设计审核：方向认可，尚未放行M1
日期：2026-11-05。结论：M0_NEEDS_CLARIFICATION / M1_NOT_AUTHORIZED。只修订设计与证据，不继续候选实现。依据仍为《统一修订任务书》F01–F40；以下均为既定条目的具体缺口，不新增平台开发范围。

认可：复用原生问答/审批/执行接缝；缺真实后端关闭执行；持久记录不复活旧原生Promise；05问答与06只读可分切片验收。五份材料及索引齐全，但“材料齐全”不等于架构门禁已通过。主审负责核实接缝和后续共享装配，作者不需要自行建设全部环境或承担全部E2E。

## 一次性设计修订清单

| 编号/既有AC | 当前证据与风险 | M0应补的具体结果 |
|---|---|---|
| M01 / F01–04、30 | REUSE表称dsh-spill导出SpillService；实际ESM加载为SpillStore、SpillLocator、default，类型为抽象存储服务，不能由此推断输出限额已实现。未附锁/源码SHA、装配探针；shell/runtime/dsh-adapter.cjs生成配置中user-questions默认disabled | 更正spill接口，逐包附安装/锁/导出证据，标出实际profile配置生成与provider注入点、唯一注册/销毁方式。批准事件如何取可信完整tool参数须指明真实源，不能只画Adapter盒子。主程负责最终共享profile改动 |
| M02 / F07、10、11、16、18 | Digest明列范围漏user/serverActor/callId/operationType/question/detail/deadline/revision/commandDigest，schema还缺operationId/root/args/完整生效payload/权限/后端策略版本等。按id排序options抹去展示顺序差别；摘要自身在metadata中又未明确排除 | 给唯一versioned canonical preimage与完整字段类型/限额/缺省规则，明确排除digest/signature等派生值；数组保序，不做JCS以外隐式重排；同ID重试如何处理createdAt等服务端生成字段须明确。05和06共用同一函数和完整预期context，附变更字段反例表。M0无需实现该函数 |
| M03 / F06、12、17、19、20 | “展示即批准”措辞危险；isApprovalAction可能来自模型；问答状态机只有APPROVED而无普通回答终态。CAS仅id/status/expiry，未写撤销/身份/Run与claim的事务关系。网络响应不能与数据库处在同一事务 | 改为“展示不授予权限”；授权语义由可信宿主typed action定义，不信模型标记；区分普通answered与批准。明确原生allowed-once到宿主记录的关联、审计提交失败处理、取消/撤权与claim原子化顺序、claim后启动前复核及unknown恢复；DB提交后再应答，重复请求查权威状态。HMAC可选，opaque私有记录即可，签名不替代权限检查 |
| M04 / F24、27、28、29 | 将realpathSync+nlink当“物理防穿透”；它不保护检查后替换，也不限制任意脚本后续打开文件。宿主读provider与脚本内核隔离混在同一方案 | 分开受控FS工具读取和任意脚本；前者列真实安全打开/句柄/根约束方案、平台限制、竞态处理和有界读取/特殊文件策略；无法保证时只读也BLOCKED，不能凭关闭脚本自动放行。后者必须靠实际挂载/后端，不能用路径预检查替代 |
| M05 / F22–26、30–34 | 仅凭bwrap/Docker名称标FULL；“Seatbelt只能限制写”把当前原生profile限制推广成机制限制。detached+kill(-pgid)不保证setsid逃离进程组的子进程或fork bomb被收容。示意argv未证明原生provider如何加载、具体root/temp/凭据/资源边界 | 批准范围暂定所有任意脚本关闭；bwrap/容器仅为待验证后端提案，无需现在建设多平台。补能力按具体配置/探针报告而非名称，受控进程树/资源约束与原生jobs交接、失败分类、backend revision绑定方案；未证实则BLOCKED。后端预检可先于claim，若先claim则明确无执行失败不会重发授权 |
| M06 / F01–40 | F06、15、22标COVERED与fb250a9既存失败反例直接冲突；F04尚无主审通过；F07/08/09/27/33只跑局部或无完整证据，不能整项通过。F17允许内存CAS冒充持久并发，F25拟curl/ping公网偏离本地fixture边界；F39扩大到全部35包无必要 | 每项分“设计映射/已测子项/未测子项/整项状态”，没有固定源码SHA+命令+完整断言不标COVERED。必须纳入原8及新增5反例；仓储并发用真实隔离持久库，网络用合成本地端点，凭据只用合成值。F39只回归实际受影响已有链。明确所谓作者24项的具体编号，其余逐项分主程/QA/环境责任 |
| M07 / 交付范围 | PATCH-PLAN允许整个tests/probes和evidence目录，且声称主工作区干净可重置；实际有大量他人改动。指定worktree路径已不存在。图无本轮渲染证据 | 独占范围收窄到精确新增文件名和两候选目录，现有主审探针不可覆盖；package-lock与实际入口也纳入共享保护。保留现有脏工作，禁reset/clean/prune。说明以仍存在的fb250a9对象建立新唯一worktree的计划，实际建立由后续施工执行；对3张Mermaid提交真实渲染结果，不靠人眼 |

## 主审本轮实证与边界
主线HEAD仍bbd9997d1e19920dc1c850c31ec6c71dbc5994d1；修复ref仍fb250a9329d5be0a36b5c000a463f644c7a61949。git worktree list标/private/tmp/pt-fix-05-06为prunable，目录不存在；未清理注册或恢复工作树。git show固定tip确认hasIsolationBackend布尔和never-issued字面值分支仍在。既存QUESTIONS-ISOLATION-R1-EDGE-20261104.json为5/5失败历史证据，本轮未假称重跑。
通过node ESM实际加载questions/approval/shell/bash-sandbox/sandbox-local/fs-sandbox/spill导出，并读本地类型，发现spill错误；导出能加载不证明真实Agent装配和OS隔离。主线代码搜索定位dsh-adapter.cjs的禁用配置；不推断所有已部署profile相同。未执行待审脚本、联网、调用PT、修改候选、合并或部署。本轮3张作者图未渲染，列为材料未完成，不宣称图语法通过。

## 修订交卷与放行条件
只更新原5份设计材料和索引，另附一份M01–M07逐项回应及证据索引；无需重复发送历史修复报告或重写任务包。下一轮主审确认：原生接口/宿主缺口、统一schema、可信状态与仓储事务、具体FS方案、脚本关闭策略、精确所有权和适用AC。确认后可放行“05原生问答/审批适配＋06经验证只读＋无条件拒绝脚本”的M1切片；执行后端保持独立BLOCKED，不能宣称完整06交付。
