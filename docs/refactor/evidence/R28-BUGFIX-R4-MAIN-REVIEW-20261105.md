# r28 R4主审：两项原回归通过
结论R4_FOCUSED_REVIEW_PASS / REFREEZE_AND_QA_PENDING。实际tip 388712c47db4090dd189a3659e24aacd51c7c72e，base db94e425d3746db8c7ab138b462049f5f8a7c5f2；报告所写388712cd5fa7dc1104e76a6be3369a19c5c29ea7不是真实完整提交，short正确，主程以实际Git指纹绑定，不要求为元数据笔误重做代码。
实际Git增量仅persistent-runner/app/作者专属探针，worktree其他交付报告未跟踪，不由主程清理。移除原先无条件删Map，持有原生handle；模型禁用文案复用kind和blockedReason。HTML安全关闭保留，Bug-12仍DEGRADED_PREVIEW。

## 本轮执行
原reasoning-native-runner、ui-model-switch、作者新探针、ui-media-authorization联合执行8/8通过，其中UI脚本内部57/57。两份改动源码node --check通过。作者SDK失败恢复探针只直接调用SDK，不经过产品persistent-runner；主程因此以原实际Runner测试为基础另加失败流/合法followup序列，结果1/1通过。实际sequence：合法high→其他模型→非法档位拒绝→合法low成功→合成stream失败→同会话合法low成功→metadata取消。没有删除原断言或用模拟Runner替代SDK。临时诊断副本仅在独立工作树新增，带child清理，未纳入作者提交或覆盖原测试。固定源码测试无PT/公网/真实用户数据。
主程执行日志本机/private/tmp/r28-r4-review.txt、r4-lead-actual-runner.txt。局部通过不代表全量回归、Linux新归档或同版QA已通过。旧r29准备包5128ab83…绑定db94e42，不能拿来发布本次R4代码。

## 报告范围与下一步
第二批8项及fix/bug-batch5-followup不在本次三文件提交内，本次不验收/不混入，也不承认其“QA误提/下一期”定性。Run成功与远端费用、AUTO回显、技能恢复/记忆、用量归属须主程对照原需求与实际证据分诊；产品用PG/PGlite，不接受报告未经验证的SQLite描述。历史费用解释不证明实扣或零费。
主程下一步将R4接入独立候选、按新源码重冻归档、受影响回归与Linux安装，然后按已授权agent-fat专属租户进行同版本验收。切换前仍需当时无在途、备份恢复与回滚门禁，先前只读预检不替代。当前线上仍原r28，未切换、未付费。Bug作者R4已达到本轮局部要求，可冻结待命，无需继续为这两项返工。
