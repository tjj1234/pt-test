# 05/06 M1 Revision3主审：两项原事务/Run边界尚未闭合
固定tip 469beb12cd40d5c4896748a5b5c23af88893af75，作者15/15本轮复跑通过。认可取消落盘、终态重开、单选schema的本轮改进及审批/执行/FS仍关闭。当前M1_NEEDS_REVISION / INTEGRATION_BLOCKED，以下只修既有F09/F10/F17/F19，不扩大执行/审批范围。

| 问题 | 实际反例与原因 | 一次性修订条件 |
|---|---|---|
| 期限未在最终事务时判断、超时不能可靠持久终态 | 实际manager用timeout40ms，submitAnswer在期限前进入，但仓储answered CAS延迟60ms后执行；返回ok:true，等待Promise已timeout，数据库却answered。原因constraints.now为调用前捕获时间，仓储当旧时间使用；timer写expired也复用“deadline必须未过”的CAS门禁，过期后反而无法写expired | 仓储按事务取得锁后当前权威时间判定；answered条件要求期限仍有效，expired要求期限已到，使用不同合法状态转换。超时、答复、取消并发只有一个权威终态；返回/Promise须基于同一终态，不能用冻结测试时间伪装实际写入时间。补持锁跨期限、timer延迟/未运行、重开过期记录和答复晚落盘；PG/PGlite真实验证 |
| 管理器Run范围未约束查找/提交 | 建rA问题后，用绑定rB的另一manager、同tenant/user提交该questionId，返回ok:true；submitAnswer仅比对答复者与stored tenant/user，未比对manager run/tenant/user，CAS也不含预期Run | get/创建/答复/CAS/取消均按可信tenant/user/run作用域；错Run管理器拒绝且不得影响原问答。客户端身份参数由共享鉴权提供，不能取代manager上下文。补同user双Run、双tenant、同ID并发及错Run终态查询。仓储取消键也必须在约定的可信作用域内 |

附随实现一致性：activePending存getTimer/setTimer而cancelRun仍clearTimeout(entry.timer)，未清除真实计时器；复用权威deadline时更新同一entry截止时间和timer引用，清理须走实际句柄。abort监听取消要处理异步拒绝并在问答结束后解除，避免旧工具signal取消后续问答或产生unhandled rejection。这些是同一生命周期边界，不新增产品流程。
证据来自实际候选模块+合成延迟store，输出lateCAS accepted=true/promise=timeout/stored=answered，wrongManagerRun accepted=true。无网络/PT/真实用户数据。主程本轮没有改候选代码、原探针或历史证据。
提交一份局部补丁与上述分组行为测试，不重做已通过schema/关闭执行部分。持久层生产接缝可继续由主程统一装配，但作者仓储协议和PGlite实证不能以调用方旧now当最终期限证明；整包仍不结项。

## 交卷方法补充（用户再次提醒后的统一要求）
仍使用本文件作为唯一当前修订清单，不另发互相冲突的施工文件。请将期限/取消/身份与Run作用域作为同一仓储事务问题一并检查；交状态转换和锁内判定说明，附创建前中后取消、慢写跨期限、双worker、终态重开、跨Run、存储失败、清理的全部适用结果。逐项PASS/FAIL/BLOCKED，不仅复跑原15项，不为用例改动而开放关闭功能。若结构无法保证，先明确方案阻断交主程，不再只给下一个样本补丁。主程随后按同一矩阵完整复审；新增产品范围另记变更。经验入口../PROJECT-REVIEW-LESSONS.md。
