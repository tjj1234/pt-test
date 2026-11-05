# 05/06 M1主审：关闭执行认可，普通问答尚未通过
固定tip ac244c17c01804937de4fafc7af24a202bde77e1，基线fb250a9；Git提交仅两候选index.cjs。作者15/15本轮复跑通过，不能代表下面原冻结边界通过。状态M1_NEEDS_REVISION / INTEGRATION_BLOCKED，不集成、不部署；Bug修复线独立等待R4。

| 原契约问题 | 本轮证据 | 本切片修订要求 |
|---|---|---|
| M1禁止可消费Grant / F06、15、16 | createQuestionManager的approval YES仍saveGrant(status issued)，verifyApprovalToken返回ok:true。主程实际合成请求复现。虽然06不执行，但05单独输出了授权成功，违背明确停止点 | M1批准请求直接APPROVAL_SEAM_PENDING_SPEC，不写issued Grant、不返回approved或verify ok。作者T04–06依靠实际发Grant再测撤销/突变，属于越过本轮范围；改为闭门断言，保留后续审批测试未完成，不称该生命周期已闭合 |
| 可信身份 / F10 | submitAnswer无respondent身份也成功；传错user对clarification也不拒绝。代码仅在参数存在时比对且对clarification放宽。主程无身份答复实际ok:true | 必须注入已鉴权可信context，缺失拒绝；普通问答也绑定有权用户/tenant/Run，客户端自报不构成可信认证。禁止默认把stored.userId当实际答复者 |
| 完整幂等摘要 / F07、18 | computeCanonicalSignature只覆盖部分字段，不含user/call/operation/期限/multiSelect/detail等冻结字段。相同输入仅变timeoutMs摘要相同，实际askQuestion签名也未传timeout。规范化对undefined/function不严格拒绝 | 普通问答先完整实现适用字段、上限和拒绝非法值，共用版本preimage；同ID异期限/多选语义/身份/内容必须冲突；不需要为了本切片开放审批 |
| 持久权威/并发 / F17、19、20 | 不传store时自动回退Map；savePending异步尚未完成可submitAnswer从activePending.meta回退并提交。get→save、get→update非条件事务；saveGrant与状态写分离。自测PGlite适配器在探针内，非候选默认持久实现 | 生产缺store必须fail-closed；内存store仅显式测试选项。先持久成功再发布问题，答复不以临时meta冒充仓储；明确仓储create-if-absent/终态CAS/取消原子协议并真实隔离PG/PGlite自验，双worker不同答复只能一次胜出。重启不复活Promise不等于不重写旧deadline/终态 |

认可06脚本/读取入口无fs或spawn，假布尔不能开放；但它会先调用任意approvalVerifier再到关闭分支，关闭切片应尽早返回门禁错误，避免无意义副作用/挂起及原始err.message回传。不声称OS隔离实现或读取通过。
只修上述已冻结M1条目，不扩展到完整执行器/多平台沙箱或新产品。作者交一份精确补丁和矩阵，原15项中与闭门冲突的用例明确迁移为后续未实现。真实SDK服务registerProvider/ask路径也须实际加载验证，而非只直接调用nativeProvider.ask后称SDK通过。最终前端/SSE共享接线仍归主程；当前候选不合并。
主程实证为合成manager调用：missingIdentityAccepted=true、grantIssuedWhileSeamClosed=true、verifierAllows=true、digestOmitsDeadline=true；不涉及PT/公网/真实文件或付费。原作者15项通过保留，不改探针断言掩盖问题。不能将全部13历史反例概括“修复”：关闭入口是拒绝安全，授权/存储生命周期仍待验。
