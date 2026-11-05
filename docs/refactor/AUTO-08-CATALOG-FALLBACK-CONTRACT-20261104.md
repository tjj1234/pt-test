# 原08已交付后的补充接线契约：自动目录与安全候选切换
2026-11-04｜状态：INTEGRATION_SPEC_READY；原08最新为0c8841c＋主程小补丁选择器局部通过，见第9节；尚未主包接入/上线；执行拒绝后切换默认关闭，等待PT确认适用错误语义。归属：17维护目录/资格快照及审计，08保留纯选择器，31映射PT语义，现有Run/Runner负责一次尝试的执行与状态；负责人统一接共享入口。不是另一个Agent引擎或改写08正文。

## 1. 原08交付核对
本轮读取了原包、交付报告、CONTRACT、实际实现和探针，交付报告的三个文件SHA与现场一致；用户亦已确认原8包交付。结论为**原08作者已交付，报告标CANDIDATE_TESTED、INTEGRATION_PENDING**；首次规格核对时26/26仅为原作者报告；后续已复跑并新增独立反例，见第8节。不能说已主线接入。

| 文件 | 本轮核对SHA256 |
|---|---|
| 原08任务包正文 `GEMINI-AUTO-DELIVERY-PACKAGE-20261103.md` | `98f13fe7e506716909479871c89be8885b93a5f9c452652367662562ceaf94cb` |
| `shell/candidates/auto-20261103/CONTRACT.md` | `1e2ebfe0efad5cecb20ecff151bc891aaeed738dfe6eb70ceba39377a0e9df2f` |
| `shell/candidates/auto-20261103/index.cjs` | `d8875ac8a9fd2ee2427b81edc633a53b24a15b5a39c7c940f1798bfc9591fea9` |
| `tests/probes/auto-delivery-20261103.mjs` | `795b2074afb736797f33d03724f758afaba480f1c16394494324ffe1026d5002` |

原08通过`createTaskRouter(config).selectModel(taskType, eligibilityResults, options)`返回候选，不执行真实调用，也不接收PT acceptance_state/费用确认信息。原实现按eligible集合遍历primary，部分payment/charge等reason只跳过该候选；`dispatched`限制发生在fallback分支，不是覆盖所有primary的执行重试护栏。因此**不能把执行结果未知转换成eligible=false再重调选择器**，也不能仅凭原接口声明“已禁止所有执行后换模型”。这属于集成主审关注点，不在本轮修改原候选。
原报告“付费结果未知(QUOTA_EXHAUSTED)跳过选次优”只能在明确的调用前资格拒绝语境使用；若来自已发出的执行尝试，必须先按本契约判断，未知即停止，不能以原因字符串匹配当零费用证明。

## 2. 已确认规则与接口边界

| 阶段 | 接口/数据与行为 | 禁止行为 |
|---|---|---|
| 目录维护（17） | 定时读取完整可信PT `/v1/models`；原子生成镜像与按tenant/当前Key/task构建的候选revision；自动增删并留痕，详见[17第3.1节](REFACTOR-GOVERNANCE-PACKAGE-20261103.md#31-自动目录同步本轮已确认需求) | 不逐模型人工审核，不因同步失败清空目录，不用真实推理探活 |
| 资格预筛（17/31→08） | 规范化当前Key allowed/reason/时效、明确任务/端点/参数、协议条件及DSH配置，生成可信eligibilityResults；明确无权者不调用，缺失/过期/未知不进入新候选 | 配置/模型名/目录存在不授予权限，目录不代填runtime verification；新模型无需人工逐个批准，但原全局安全开关、已配置provider和任务门禁仍生效 |
| 首次选择（08） | 用已批准任务范围、候选顺序、routeConfigVersion及catalog/eligibility revision确定性选取；选择前剔除本次已经尝试的模型 | 不在选择器内验证资格或发探针，不扩大未开放媒体AUTO/任务 |
| 一次执行（现有Runner） | 先持久operation/attempt及请求摘要，再向选定模型提交；每次attempt只发一次，记录request/task引用、实际受理证据 | 不允许底层SDK/transport隐式自动重试绕过本契约，不在流中断后重新提交 |
| 执行失败决策（新补充接缝） | 先分类原attempt，仅满足第3节全部条件才创建下一个候选attempt；其余停止本次自动执行并保留核对入口 | 不复用“pre-dispatch”标签洗掉已提交事实，不改旧attempt状态、清空未知operation或重新选择primary碰运气 |
| 候选耗尽 | 返回具体原因/可读下一步，区分预筛无候选、明确零费用拒绝后耗尽、受理未知停止 | 不统一显示“DSH执行失败/通用失败”；未知停止不得展示“未产生费用，请重试” |

目录资格false是调用前预筛，未发生外部提交，可直接跳过；它不属于“执行失败后切换”。目录接口本身失败则保留last-good/stale并按时效门禁处理，不凭错误猜其他候选资格；不会自动调用收费模型验证。

## 3. 唯一允许的执行失败自动切换条件
以下是逻辑AND，缺一项即不切换，且仅用于AUTO选择；用户手动指定模型的失败不得悄悄换模型。

1. 有负责人登记的、可追溯的**PT官方确认**：适用base/endpoint/channel/error_code及语义版本明确，确认该拒绝未受理且确定零费用。对特定模型/Key作用域的确认不得扩大到其他作用域；到期/撤销的确认不再生效。`PT-API-REQUIREMENTS`当前是需求稿，不是该确认。
2. 实际响应是确认范围内401/402/403类明确拒绝；HTTP数字、error文字、retryable=true、not_accepted单字段均不足以证明零费用。适配器须同时得到not_accepted与confirmed_zero或PT确认的等价可信证据；字段冲突/缺失按未知处理。
3. 没有accepted/queued/running/task已受理等相反证据，没有已输出内容/工具副作用；任一已受理迹象都阻止切换，不能用后来的错误抹除。
4. 当前Run未取消、批准/权限/预算仍有效，下一候选仍在当前合法范围且满足任务能力/参数/当前Key资格。换模型超出原批准范围时先重新确认；不为AUTO切换新增未获准付费权限。
5. 有未尝试且预筛通过的下一候选，遵守固定顺序；每模型至多一次，总attempt上限不超过配置上限、剩余预算与可用候选数。身份级全局拒绝已证明所有候选无资格时直接给具体错误，不无意义逐模型调用。

| 实际结果 | PT确认gate | 本契约动作 |
|---|---|---|
| 401/402/403＋not_accepted＋确定零费用，适用语义已确认且其余条件满足 | 有效 | 记录原attempt为明确拒绝；可顺序选择下一候选，留原因与关联，不重试原模型 |
| 401/402/403但未确认、字段缺失/矛盾、费用pending/unknown | 无/不适用/证据不足 | 不切换，受理未知处理，保留原operation核对；不从HTTP代码推免费 |
| 超时、断网、5xx、429、无响应、流中断 | 任意 | 本轮规则固定禁止切换/重提，受理未知处理；Retry-After仅用于允许的只读查询，不转成推理重试许可 |
| 明确已受理或出现任务/内容/工具副作用 | 任意 | 继续原任务状态/结果查询或保留待核对，不换模型 |
| 无更多预筛合格候选，且所有已发attempt均已确认未受理且零费用 | 有效 | 具体“候选耗尽”错误及下一步；不能无限循环 |
| PT尚未确认错误码/受理/零费用语义 | 默认gate=false | 任何已发执行尝试的失败均不自动切换，按未知受理分支处理；候选预筛仍可运行 |

PT确认是策略事实的版本化登记，不允许客户端请求传`semanticConfirmed=true`自行解锁。本文定义的confirmed_zero为内部规范化语义，不要求PT使用某个既定字段；PT可给等价字段/错误码保证，但须经31/34登记可验证映射。`acceptance_state=not_accepted`也不自动代表未产生网关/上游费用。

## 4. 持久数据与接缝建议
新增接缝优先复用现有Run/operation/调度记录，只补必要字段；原08候选接口不改，确有必要修改时交**独立、可审查补丁**及反例，由负责人决定是否应用，不能直接覆盖原交付。

| 数据/操作（目标语义，非现有API声明） | 必须包含 |
|---|---|
| CatalogSnapshot/Eligibility | scope=provider/base/tenant/KeyRef/KeyRevision/task、完整性与来源版本、allowed/reason/checkedAt/expiry、DSH配置revision、catalogRevision；未知与false区分 |
| SemanticConfirmation | confirmationRef/来源与日期、适用endpoint/channel/error/范围、normalizedAcceptance/billing语义、版本/失效；默认禁用无证据映射 |
| RouteAttempt | operationId/attemptId/attemptNo/model、route/catalog/eligibility/confirmation版本、提交前intent、request摘要、upstream引用、outcome与脱敏原因 |
| FailureDecision | accepted/not_accepted/unknown与confirmed_zero/nonzero/unknown分离；是否允许next、具体reason、剩余候选、预算/批准快照；decision持久后才开始下一attempt |
| Stop/Resume | 未知立即设置reconciliation_required，不再调用08选新候选；重启查原attempt，不重提；明确拒绝后的未开始下一attempt可按持久decision及当前权限恢复 |

明确拒绝后继续下一候选不意味着把原attempt“变回未提交”；每个新attempt有新attemptId/HTTP request关联，保留同一逻辑operation及原批准/变更规则。上游幂等键的模型/请求摘要绑定按PT真实契约映射，不能在切模型时复用与另一payload绑定的幂等键；缺安全映射则禁该分支，不靠重发试探。已成功/未知候选不在后续排除集合之外重新尝试。
相同operation并发/双击只允许一个活跃执行attempt；租约/fencing与崩溃恢复复用既有能力，非新增平行调度器。目录同步不得修改在途attempt模型，也不能因模型下架抹掉原任务查询所需元数据。

## 5. 可读错误与费用边界
错误码是目标契约，可映射既有错误；保留稳定machine code＋脱敏message/action＋operation引用，不能把上游原文/Key/其他租户模型名单直接回显。

| 目标错误 | 默认可读信息与下一步 |
|---|---|
| AUTO_NO_ELIGIBLE_CANDIDATE | “当前Key没有可用于此任务的候选：权限不足/模型停用/资格未知/配置缺失（列实际原因）。请检查Key权限或选择已支持模型。”明确尚未提交 |
| AUTO_CANDIDATES_EXHAUSTED | “可用候选均被明确拒绝，已确认未受理且零费用。原因：…。”仅全部已发attempt均有该证据时可显示；给权限/额度等具体处理方式 |
| AUTO_SUBMISSION_UNKNOWN | “本次请求是否受理/计费尚待核对，已停止自动切换，请勿重复提交。”提供运行记录/核对入口，不能建议立即重新生成 |
| AUTO_ERROR_SEMANTICS_UNCONFIRMED | “PT尚未确认该拒绝是否受理及收费，已停止自动切换，正在等待核对。”费用保持未知 |
| AUTO_CATALOG_UNAVAILABLE/STALE | “模型目录同步暂不可用/资格已过期，未扩大候选。”如无法确定资格则不提交，提供重查目录而非收费试跑 |

“未提交”的预筛失败与“提交后未知”不能同文案。所有失败保留候选顺序、跳过原因和每次attempt的证据，不以费用估算0、余额无变化或短时间无账单当确定零费用。

## 6. 补充验收（要求，不是本轮已执行测试）

| ID | 必测结果 | 对应17 AC |
|---|---|---|
| AF-01 | 完整目录增删自动构候选；allowed=false/过期/unknown不触发真实推理；不同Key/task/目录版本隔离 | 17-11–14 |
| AF-02 | 有可信PT语义确认的401/402/403＋未受理＋零费用，顺序尝试下一合法候选；每模型一次、预算/取消/授权有效，全局无权直接停止 | 17-15 |
| AF-03 | PT未确认时所有执行错误零切换；即使HTTP为403/402或retryable=true也不能解锁；客户端伪造确认无效 | 17-15/16 |
| AF-04 | timeout/5xx/429/无响应/流中断/accepted与零费用字段冲突，均停止；重启/晚到仍只查原任务，不重投/不再选primary | 17-15/16 |
| AF-05 | 预筛无候选、明确拒绝耗尽、提交未知、目录失败分别显示具体错误；只有可证零费用时才显示零费用 | 17-17 |
| AF-06 | 原08输入/输出兼容且指纹未改；接线先分类失败，不把未知reason丢入eligible集合后换候选，不重置旧dispatchState | 17-18 |
| AF-07 | 同operation并发、确认过期/范围变更、目录下架/换Key、崩溃于intent/decision/下一提交间、SDK隐式重试均有反例和真实请求计数 | 17-13/15/16/18 |

用真实候选＋本地PT协议fixture＋实际存储/Runner接缝，记录请求计数/模型/operation/attempt/来源版本、退出码及源码SHA；静态字符串断言不替代行为证据。PT官方语义未获确认时，AF-02只能在**模拟确认策略fixture**下测试规则，真实环境分支仍关闭；不能把fixture的true当作PT已确认。

## 7. 分工、交付与当前停止点
17负责定时/快照/差异/审计；31/34负责PT字段/错误语义映射和官方确认；08保留纯选择器；负责人负责目录/资格→08→现有Runner的补充接缝及共享入口，独立测试验证实际请求计数。新增实现/探针交到17独占候选目录内或协调后的独立补丁路径，不越权改Gemini原08候选，迁移/profile/依赖由负责人集成。
指纹清单以实际文件的完整SHA为准；首次规格核对时只读08、未重跑原26项；后续复跑/独立审核见第8节。目录同步及PT调用仍未运行。原报告/源码/任务包正文保留不变。上线前必须完成目录/资格事实核查、补丁主审、本地与staging独立验收；PT未确认零费用拒绝语义时，执行失败后切换保持关闭，不阻断自动目录维护的无依赖工作。

## 8. 2026-11-04独立审核补记
原08已实际复跑并完成独立反例审核：[报告及R1–R6局部修正要求](evidence/AUTO-08-MAIN-REVIEW-20261104.md)。原探针26/26通过，新14项4通过/10失败；本契约第1/7节“未复跑”为规格初写时记录，本节记录后续审核事实。原文件指纹保持不变。当前08为NEEDS_REVISION/INTEGRATION_BLOCKED，原作者局部修正后复审；PT新语义/定时同步仍属主程接线，不由此次原探针通过证明。

## 9. 局部补丁复审更新（2026-11-04）
原08最新作者tip 0c8841c的R1–R6已复审，主程另补R3显式假值门禁并在临时副本验证原14＋新增14＋纠偏26通过，详见[复审报告](evidence/AUTO-08-REREVIEW-20261104.md)。当前基线必须包含主程补丁，状态为选择器局部通过/主线接入待做；第8节为前次审核历史。pinVersion透传不是实际模型revision已验证，PT语义未确认仍禁执行失败切换。作者分支/共享旧候选未改，本轮未主线集成或上线。
