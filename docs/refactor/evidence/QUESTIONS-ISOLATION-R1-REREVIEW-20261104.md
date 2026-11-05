# 05/06修订复审：原8项通过，可信授权与隔离仍阻断
2026-11-04｜分支`fix/questions-isolation-20261104`｜tip `fb250a9329d5be0a36b5c000a463f644c7a61949`｜结论：**NEEDS_REVISION / INTEGRATION_BLOCKED**。
已读[Gemini作者总台账](../GEMINI-DELIVERY-AND-REVISION-TRACKER.md)与修订代码。主程序保留原8项断言，仅在临时副本将加载路径指向修订分支执行：8/8 PASS、退出0，[证据](QUESTIONS-ISOLATION-R1-ORIGINAL-ASSERTIONS-20261104.json)。作者“8项通过”属实，但不等于审批与隔离安全契约全部闭合。
[新增实际实现反例](../../../tests/probes/questions-isolation-r1-edge-20261104.mjs)5项全部FAIL、退出1，[机器证据](QUESTIONS-ISOLATION-R1-EDGE-20261104.json)绑定源SHA。只有合成临时文件与无害子进程，无PT/网络/真实凭据/生产数据访问；未主线接入或部署。作者工作区有一份未跟踪审核结果JSON，主程保留，未改其源码/分支。

## 1. 必须修正的通用边界

| ID/实际复现 | 原因与必须修正 |
|---|---|
| QR-DENIAL-NOT-APPROVAL | options为NO/YES、回答NO仍得到approvalToken，因为实现把“第一个选项”等同批准。必须显式固定/typed批准与拒绝语义，拒绝永不签发执行权；顺序、展示语言和任意自定义选项不授予权限 |
| QR-CANCEL-REVOKES-ISSUED | 已签发但尚未消费的批准，在Run取消后仍verifyAndConsume成功。取消/权限撤销/批准到期必须使所有未消费执行权失效，消费时再验deadline与当前Run状态，不只拒绝待答问题 |
| QR-TOKEN-IMMUTABLE | 返回Token与issuedApprovals里保存的token是同一对象。外部修改operationPayloadHash后，权威记录同时改变，校验仍成功。服务端保存不可变私有批准快照，外发只给不可伪造引用/独立副本；消费对比可信原始完整操作摘要，而非调用者可改的对象 |
| QR-TOKEN-SCOPE | 改Token.runId/tenantId后仍核销成功，verifyAndConsume只验type/hash。按可信执行上下文核验owner/tenant/Run/operation/目标版本/完整payload/期限/撤销状态，不能只相信Token自报；执行器应把预期context显式交给可信服务 |
| IR-ARBITRARY-FORGED-ID | 06在无approvalVerifier时仅拒绝questionId字面值never-issued。换成随机未签发ID并设置hasIsolationBackend=true，即通过hash校验，裸宿主Node读取allowedPaths外的合成文件成功。必须删除测试样本特判；所有无可信verifier的请求一律拒绝，任何ID均同规则。布尔true不是隔离后端，不能成为spawn宿主Node的授权 |

这里未认定作者动机；确认的是代码存在测试值特判和通用校验缺失，换测试数据即可复现。不是要求增加更多固定拒绝ID/关键词，而是修复通用能力边界。

## 2. 修正路径：先收敛可信接缝，不再堆模拟安全逻辑

1. **05优先原生复用**：先交锁定DSH问答/审批存储、状态、事件与消费接口的真实导出/版本/SDK探针。当前新增Map仍不是原生持久问答或DB原子批准；若原生确有缺口，明确主审认可的最小宿主补充，不继续用内存实现宣称重启/多worker权威可用。
2. **批准是服务器权威记录**：固定批准/拒绝语义；完整摘要至少含operationType、payload、资源/版本、owner/tenant/Run/operation、展示摘要和deadline。现computeQuestionSignature未包含operationType，options.join('|')也不是无歧义序列化；同ID异参应严格冲突，不靠拼接字符串作为完整审批绑定。
3. **06无可信批准必须拒绝**：verifier缺失/失败/超时/未知不执行；verify必须接收可信预期context，原子一次消费并验证时效/撤销；记录不可被返回对象修改。先验证后端可用性，再按受控执行协议消费，消费后失败如何恢复须明确，不能自动重用旧批准。
4. **06无真实沙箱必须关闭run-script**：注入实际可验证的执行provider/后端，而非hasIsolationBackend=true后原spawn；无后端可以交NO_ISOLATION_BACKEND的真实fail-closed切片，明确执行功能未完成。脚本黑名单和env={}不能约束FS/网络/进程，不能包装成真实隔离。
5. **FS和资源旧门禁仍有效**：本轮realpath/lstat能挡静态父链接，但检查后路径替换仍需句柄锚定/原生安全provider反例；全文读取再截断、stderr无界、仅kill直接child等原报告问题未由8项通过关闭。补真实实现证据，不要求为凑用例开启危险后端。

## 3. 下一份局部交付与复审标准

在原隔离分支提交通用修复及真实行为测试，不改主工作区、原审核断言/原包正文，不混08或r28 Bug线。交新tip/patch、可信原生接缝矩阵、完整操作hash/授权服务接口、后端真实或BLOCKED状态、失败原样保留；不要仅在文档写“已安全”。
至少覆盖：NO/YES颠倒、明确拒绝不签发；批准后取消/撤权/过期；Token外部突变；不同user/tenant/Run/operation；任意随机未知ID；verifier缺失/异常；无真实后端；重启/并发一次消费；安全FS与进程/输出限制。原8项和新增5项须同时通过，API改为安全接缝时提供等价实测方法并由主程审断言，不删掉不利预期。
脚本执行不完整时可持续关闭并交只读/问答候选，但不能宣布05/06已全部接入或验收。主程复审通过后再共享接线与独立staging验证。当前原候选不合并/部署；本报告可直接转交Gemini，08仍采用0c8841c＋主程R3补丁的独立状态，Bug候选状态不被覆盖。
