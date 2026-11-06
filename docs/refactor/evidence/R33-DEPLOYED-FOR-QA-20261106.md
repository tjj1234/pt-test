# R33 已正式部署，待同版独立 QA

结论：DEPLOYED_FOR_QA / INDEPENDENT_TARGET_POSTCHECK_PASS。目标为唯一正式环境 https://agent-fat.adorado.top，不存在另外的 staging；部署成功不代表独立 QA 或真实供应商验收完成。

| 项目 | 已核实事实 |
|---|---|
| 正式 release | /opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell |
| 服务 | active/running，PID367662，NRestarts0；analytics active |
| 时间 | 本地健康2026-11-06T08:02:47.372Z，公网健康08:03:49.833Z，同PID；公网uptime124秒 |
| 产物 | SHA256 3f0cb945646b40580666f8537d578e6f19f9907d2d2c57cbd2aca2b750a5d263；223源码/426成员 |
| 部署脚本 | SHA256 5b6cd4a93fd60597a76b0f54cee2ae04a3e60f58c901cf060e6bbbd19187e49a；用户终端交互sudo执行 |
| 源码 | 主程另经SSH逐项核对223文件，全部匹配冻结源清单 |
| app.js | 公网文件与冻结文件cmp一致，SHA0885b75481fa69e78d5d96faf3070d4d0815fbf2fca41f298d432961ff7771fc |
| CSS | 公网文件与冻结文件cmp一致，SHA4854a660de0ff59a0fd57b3575b4f5f15998e04744bfd8b9bc26994586323e56 |
| 匿名边界 | /login200，/api/models401 |
| 旧版 | R31 release目录仍保留，未覆盖、删除 |

用户给出的已绑定脚本输出记录：备份 /var/backups/northstar/r33-20261106T080128Z；验证库 northstar_r33_verify_20261106080128；BACKUP_RESTORE_PASS counts=318:29、ISOLATED_MIGRATION_PASS counts=318:30、LIVE_ADDITIVE_MIGRATION_PASS counts=318:30，依赖闭包495包/31007文件通过，profile重建及223源绑定通过。备份恢复与迁移计数来自本次用户执行的已审查脚本输出，主程未再次以sudo读取私有备份，不冒称第二次独立恢复。未故障切回R31，回退路径准备不等于回滚演练。

本次普通澄清 M1 为显式勾选启用；审批/文件系统/脚本继续关闭。Gemini八包整体及05/06整体未因此完成；Bug-12保持DEGRADED_PREVIEW。270/270本地回归、Linux精确归档39/39及本地Chrome是上线前证据；上线后仅核对运行、源绑定、资源和匿名边界，没有发起付费模型/媒体调用，也没有代替独立QA。

测试工程师现在按 docs/refactor/R33-QUESTIONS-M1-QA-REQUEST-20261106.md 验收正式环境R33。旧R31报告不直接迁移为R33通过。独立目标/公网后检日志分别为 R33-INDEPENDENT-TARGET-POSTCHECK-20261106.txt、R33-INDEPENDENT-PUBLIC-POSTCHECK-20261106.txt。不要重复执行部署脚本；用户SSH master保留，主程未主动关闭。
