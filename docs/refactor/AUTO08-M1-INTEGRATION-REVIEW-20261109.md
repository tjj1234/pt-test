# 08调用前AUTO M1：主程接入验证记录

结论：LOCAL_INTEGRATED_AND_FROZEN；R34本地候选已通过集成验证，尚未部署、未获同版独立QA。代码分支 integration/auto08-pre-dispatch-20261109，基线88d6535，生产代码f5fa39aa3328086fd259350ad84a3346efd5f869。不能称08整包完成或“零费用安全降级”上线。

## 最终范围

1. 宿主PT_AUTO08_ROUTE_CONFIG_FILE以固定版本/原文SHA配置textChat或imageUnderstanding的有序候选，未配置时保留原目录顺序；manual不受AUTO名单改选。配置只排列候选，实际资格仍用现有routeChatTask，拒绝重复身份、未核准能力和缺失任务；没有新增模型工具、Agent循环或供应商重试框架。
2. 模型调用前，已有northstar.model_request_intent RPC在宿主重新核验目录scope、所选模型capabilityRevision和资格；将配置版本/hash及所选模型绑定入持久记录。这里绑定的是目录scope和所选模型revision，不宣称拥有额外的全目录全局版本服务；未选模型的变化不自动否定已选且仍合法的模型。
3. 生产宿主统一调用taskStore.reserveModelRequest。新增030表以Run/purpose/turn/step唯一，另约束Run/attemptId；Run行锁后实际读取租约，许可与Run事件同事务。每Run最多100许可，原有模型/时间/输出预算另外约束。记录不是计费回执，统一写reserved_submission_unknown，不将未知当0元。
4. 同一handler重复RPC也不再次授予许可；重建handler、重开数据库或新RPC UUID不能绕过逻辑请求唯一性。旧worker被lease fence拒绝；接管worker发现旧worker曾获许可时，整个Run后续自动模型调用被保守阻断，等待核对。没有自动清除记录/重发接口。
5. 同一Run的正常工具后续轮次与compaction由purpose/turn/step区分；新对话Run独立。核查锁定DSH agent-loop/lib/index.js：request-error恢复retry在相同turn/step的while循环重建请求，因此同一逻辑请求第二次在provider之前会被持久许可门禁拒绝；provider maxRetries=0保持不变。本项代码核对不是已完成真实供应商重试实验。

作者08候选中的配置顺序/不可变与明确失败原则已沿用；未把旧选择器并成第二套资格/路由引擎，而是由小型宿主配置模块直接复用生产routeChatTask。原Gemini候选不修改、不覆盖。本候选不含04、发送后自动fallback、价格真实性修复、第三批Bug abb3851或审批/FS/脚本。

## 已执行与证据层次

| 验证 | 结果 |
|---|---|
| 完整默认回归 | 272/272套件通过，AUTO08-FULL-REGRESSION-20261109.txt |
| Linux精确归档 | Node22 x64锁定安装；495包/31007文件生产闭包一致；原39+新增2+配置HTTP1，共42项通过，AUTO08-R34-EXACT-LINUX-20261109.txt |
| 生产仓库/PGlite | 并发唯一许可、相同handler/重建handler、跨租户、旧owner、重开、event写失败整笔回滚、手动与AUTO资格/配置顺序，AUTO08-FOCUSED-FINAL-20261109.txt |
| PostgreSQL | 真实适配器与生产仓储回归通过；双连接持有Run行锁越过lease expiry，确认pg_stat_activity实际等待后释放，拒绝且无许可/事件，AUTO08-POSTGRES-LOCK-20261109.txt |
| 实际HTTP/DSH SDK | 合成供应商，默认提问/推理/Skill/原生工具4项通过；开启配置AUTO的HTTP记录验证选择、配置hash/revision及持久许可，配置与推理2项通过 |
| 语法/归档 | 全仓656 JS语法通过；后续修改的store/handler另经回归加载；独立archive审计及builder --check通过，225源/428成员 |

PostgreSQL锁测试首次PG未就绪导致连接失败，单独日志保留；加pg_isready前置后完整测试退出0，不归责产品。此前PGlite原始probe非UUID租户夹具失败亦保留，不作为产品缺陷。测试使用合成用户/临时库，不访问生产数据，不调用真实PT或读取用户密钥。专属PG容器已停止自动移除，Linux容器也已完成自动退出。

没有新的UI布局变更；本轮HTTP/SDK合成回归不是实际用户浏览器独立验收，也不是供应商零收费证明。生产切换和同版本浏览器验收尚未进行。一次性写了许可却没有实际发送的情况也按未知阻断，属于刻意保守的恢复策略，发布说明必须显式告知，不把它包装成自动恢复完成。

## 冻结身份与发布前置

归档 northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.tar.gz，SHA256 70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d；225绑定生产源/428成员。R33及其它历史归档保留。默认配置未开启；若需开启，主程须选定实际已核准模型列表，不把测试fixture或未验证模型拷到正式配置。

正式发布需单独获得R33→R34切换授权，再核对实际线上版本、在途Run、目录/配置/依赖与备份空间；独立安装，不覆盖旧release；停服排空后备份并在隔离恢复库验证新增030及幂等/旧数据计数，再切换并独立核验服务PID/健康/225源及公网资源。旧R33在新增表存在时仍能运行；回退unit/profile和配置，保留表与证据，不自动恢复覆盖liveDB。备份/迁移/回退尚未在目标机执行，本报告不宣称已演练。

用户目前不需让Gemini重复做08选择器。Gemini继续04主审修订，两位程序员原C01/C02/C03不变，Bug作者另按第三批返修单修订。发布后使用R34-AUTO08-M1-QA-REQUEST-20261109.md，Bug-12仍DEGRADED_PREVIEW，R33普通澄清继续回归。
