# 05/06首批主程审核：NEEDS_REVISION，禁止原样接入
2026-11-04｜审核范围：实际questions/isolation候选、CONTRACT及作者探针。本轮没有修改两包原实现、接线主包或部署。独立探针只使用合成临时文件和无害本地子进程，未访问网络/PT/真实凭据或生产数据。

作者探针本轮分别22/22、30/30通过，退出0；[新增独立探针](../../../tests/probes/questions-isolation-main-review-20261104.mjs)8项全部FAIL、退出1，[机器证据](QUESTIONS-ISOLATION-MAIN-REVIEW-20261104.json)绑定两份实现SHA。失败是拒绝性断言未满足，不是测试设施启动失败，也不代表已发生生产攻击。

## 05：审批与问题管理必须局部修正

| 编号/已复现 | 风险与修正要求 |
|---|---|
| Q-OPTIONS | CONTRACT说approval必须有options，实现允许缺失且接受任意答案。必须验证审批schema与批准/拒绝语义，不以任意字符串作同意 |
| Q-ID-CONFLICT | 同questionId换成不同问题/目标仍返回原Promise。绑定规范化身份/Run/操作/参数/问题及选项摘要；同ID同参幂等，异参冲突，不复用旧批准 |
| Q-DEADLINE | 超过timeout后，只要事件循环未执行timer，submitAnswer仍接受。保存绝对deadline并在回答/消费时检查，timer仅唤醒机制，不是授权有效性的唯一依据 |
| Q-OPTIONS-MUTATION | 创建后修改原options数组即可接受用户未看到的答案。冻结/复制全部展示及目标快照，提交/消费绑定同一digest，不保留可变调用方引用 |

另外必须补齐原合同承诺的APPROVAL_PAYLOAD_MISMATCH真实路径：目前approvalPayloadHash计算后没有消费/核验，submitAnswer不返回可信可核对的精确操作批准证明。不能把displayedToUser=true这个输入布尔值当成真实用户已批准的证据。同tenant其他用户回答clarification仍需要明确授权策略，不默认同租户即有权。
持久化/进程重启及UI/SSE原报告已标BLOCKED，本轮不能解除。当前模块只有内存Map和计时器，未实际调用DSH问题/审批服务；优先接锁定DSH原生持久问答/批准接口与宿主ACL，不为修本反例再造另一套审批引擎。先交真实原生接口/版本与接缝，宿主只补必要身份/Run/一次消费绑定。

## 06：沙箱与可信批准是接入前提

| 编号/已复现 | 风险与修正要求 |
|---|---|
| I-PARENT-LINK | 只lstat叶子；allowed/jump指向外目录，读取jump/fixture.txt成功。授权根到叶子逐段锚定、防跟随链接及TOCTOU；复用既有安全FS/provider能力，不能只校验字符串前缀 |
| I-HARDLINK | 授权目录内硬链接可读到外部合成文件，违反合同。验证文件类型、nlink及来源；补真实OS反例，不只测叶子symlink |
| I-FORGED-APPROVAL | questionId任意、script hash正确的自造对象即可执行，无已签发批准查询、owner/tenant/Run绑定、到期/撤销/消费校验。内容hash不是授权证明；执行前可信服务核对并原子一次消费，绑定完整操作摘要 |
| I-SCRIPT-ROOT | 未配置真实隔离后端时默认hasIsolationBackend=true，直接spawn宿主Node；脚本可用fs读取allowedPaths外的合成文件。必须默认fail-closed，实际执行由已验证原生/OS隔离后端承载，不可用布尔开关或正则冒充隔离 |

当前env={}不是FS/网络沙箱，静态模式黑名单不能提供可信边界。修复应先提供可验证后端/权限/挂载与资源契约；不可用时保持run-script关闭，不继续堆正则绕过测试。取消当前只kill直接child，尚无进程树证明；stderr无字节上限、read-file先全文读取再截断也未实现有界资源使用，须补真实后端/流式限额、取消树及并发测试。
05→06联动原探针自行组装token，未证明拒绝/过期/篡改/重放/跨Run无法执行。两包需统一规范化操作摘要（当前05对JSON payload哈希，06对裸script哈希，语义不同），可信批准引用必须由05服务签发/消费，06不能只相信客户端声明。

## 交付要求与后续顺序

1. 两包原作者分别在隔离分支交局部补丁/明确依赖；不改共享server/runner、原任务包正文、08或r28 Bug修复线，不覆盖本轮审核证据。
2. 05先冻结原生复用接缝、不可变批准摘要、严格schema/身份/deadline/幂等与持久恢复；06冻结真实隔离后端、可信批准原子消费和安全FS。外部能力不可用明确BLOCKED，不伪称完成。
3. 原作者补真实实现反例、源码SHA、命令/退出码及失败保留；主程再复审。现独立8项需通过，但不能只针对测试字符串修补，范围/重启/原生SDK/进程树/限额反例仍须补。
4. 通过后才在隔离集成候选接线，并交独立staging点击E2E；真实PT/付费另按既有授权，不能把本地脚本成功当真实模型验收。

当前首批状态：05/06均NEEDS_REVISION / INTEGRATION_BLOCKED。08仍为“作者0c8841c＋主程R3补丁”选择器局部通过，r28 Bug候选仍有3个阻断，状态互不覆盖。其他02/03/04/01/07尚未因本轮开始而自动主审通过；可独立开展其审核，但所有依赖05/06的写入/执行接线先保持关闭。
