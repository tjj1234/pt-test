# 05/06 M1 Revision2主审
固定tip 2eb0f2c68f4be4867445b01acf8ee9195e02acae。结论M1_NEEDS_REVISION / INTEGRATION_BLOCKED。认可本轮身份必填与普通回答同受约束、审批请求/校验关闭、06前置关闭且不调用verifier、缺store拒绝与等待初次落盘。此前问题不是全无修正，但以下原F05/07/12/17/19/20/21范围尚未闭合，不新增完整审批或执行要求。

| 必须闭合项 | 独立实际复现 | 最小修订及验收 |
|---|---|---|
| 取消与初始落盘的原子顺序 | 用实际manager+延迟savePending：ask→cancelRun完成→释放save，权威记录变pending；相同Run新manager可submitAnswer成功。结果persistAfterCancel=pending、restartAcceptsCancelled=true | cancel不能只更新当时已有问题；Run权威终态/撤销标记必须持久，创建与答复的事务都受它约束。补落盘前/中/后取消、双manager及重启；取消返回后不得新建可答pending。内存cancelled标志不替代仓储门禁 |
| 持久终态重开与幂等 | 实际答完问题后，建相同Run新manager同ID同参ask，store.savePending返回旧answered但管理器忽略返回状态，Promise仍pending直到新timer | 明确同参重开返回既有答复或立即稳定终态，不重新等待/续期；取消/过期/不可用旧终态同样处理。权威已有pending的原deadline必须复用。provider重连不能制造另一份未决事实 |
| 输入与单多选约束 | multiSelect:false、options A/B，submitAnswer selected[A,B]返回ok:true。答案null/空/未知结构以及options/detail/header等schema仍缺完整类型/大小验证，签名String/Boolean强转不能称严拒非法类型 | 统一普通问答输入/答案schema：单选数量、选项唯一/类型、自由文本允许条件、空答语义、上限及非法类型。模型/UI传值不经强制字符串化或Boolean化提升为有效值。补真实SDK和manager两层行为断言，不仅规范化函数测试 |

仓储CAS目前仅status=pending：最终写入时还需绑定权威身份/Run取消/绝对期限，不能仅在之前get后检查。补慢仓储中跨deadline、取消和并发答复，CAS必须正确判定终态，失败不得唤醒成功。错误原因细节不应回显原始仓储异常；共享HTTP鉴权接线仍归主程负责。
独立探针使用实际候选模块、显式测试store和合成数据；延迟仓储用于稳定调度竞态，非凭空推测，也未访问公网/PT/用户文件。旧问题关闭和本次拒绝安全认可，但不能称15PASS已覆盖重启/取消完整生命周期。继续在原独立切片分支局部修订，保护主审探针/历史JSON，不扩展Grant/FS/执行实现。需要真实PG/PGlite多实例事务验证，不能只用单进程Map证明耐久Run取消。作者自验新增反例按上述完整分组交一份报告，不再按单个样本字面值修补。
