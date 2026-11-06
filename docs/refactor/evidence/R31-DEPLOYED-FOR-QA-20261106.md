# R31已上线，独立后检通过，待同版QA
结论：**DEPLOYED_FOR_QA / INDEPENDENT_TARGET_POSTCHECK_PASS**。2026-11-06用户在安全终端执行SHA绑定脚本后，主程另经SSH和公网独立复验；不是仅根据脚本成功文字推断上线。此报告更新先前INTEGRATED_AND_FROZEN/待目标预检状态，不改历史报告或已冻结归档。

| 项目 | 已验证事实 |
|---|---|
| 入口/服务 | https://agent-fat.adorado.top；northstar-shell active/running，analytics active |
| 新release | /opt/northstar/releases/controlled-trial-20261106-candidate-34-r31-batch5-draft/shell |
| 运行状态 | PID363348，NRestarts0；独立读取本地健康2026-11-06T03:45:46.106Z，uptime109秒；公网健康03:45:50.915Z，uptime113秒、HTTP200、同PID |
| 运行源码 | fd1f11ef120082068a0d0b83819883c35285ee07；归档/验证提交97a3e5a；后续57d3ffb仅目标验证证据和脚本 |
| 确切归档 | northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft.tar.gz；SHA256 6addd5e342b9696f4d37ddc30bc60412b6f8ab5b735161b2e07fe38df4818955 |
| 217源码 | 已部署217文件重新逐项读取SHA全部匹配，独立证据R31-INDEPENDENT-TARGET-POSTCHECK-20261106.txt |
| app.js本地/公网 | SHA518d4b7e121bf2666a44366cba233c584d25b34f47b53e66c6bdf082acac3095，双方与冻结源码相同 |
| CSS本地/公网 | SHA4854a660de0ff59a0fd57b3575b4f5f15998e04744bfd8b9bc26994586323e56，双方与冻结源码相同 |
| server.cjs | SHAc3da979a5ee0bd103ab003d6b336e8870f0fb43a30ba6503573acd34fdc5d094 |
| 公网匿名边界 | /login200，匿名/api/models401 |
| 原release | R30目录仍存在，未覆盖/删除；原R28及其他历史release未触碰 |
| 健康version | 仍1.0.0，不能用其区分R30/R31；身份由目录、PID、217源码、归档及资源SHA组合确认 |

## 切换与恢复点证据
用户提供终端输出明确含`BACKUP_RESTORE_PASS counts=302:29`、`PROFILE_REBUILD_PASS`、`SOURCE_BINDING_PASS ... 217`、`DEPLOYED_FOR_QA`。SHA绑定脚本为029f8c72f1b60b24149f8c622b3857fb78caa016a663118b5536ab37da5d197d，已在服务器回读确认与审查版本一致；该脚本在无在途Run且Shell排空后才备份，并在通过实际隔离恢复后切换。备份路径 **/var/backups/northstar/r31-20261106T034343Z**；验证库 **northstar_r31_verify_20261106034343**；302Run/29迁移恢复计数一致。数据库连接限制0、PUBLIC撤CONNECT按脚本设置；原始dump、env/runtime/secrets/unit/profile与私有恢复日志保留在服务器root私有备份目录，没有下载或上传用户内容。
这些备份/恢复计数来自本次用户执行的已绑定脚本输出；主程没有另取sudo读取私有备份内容，不将其称作另一次独立恢复。脚本成功和独立后检证明本次R31切换完成，回滚路径保留但本次未故障切回R30，不能称回滚已演练。
用户看到的Perl locale fallback警告没有阻断本次脚本；后续备份恢复/切换与独立健康源绑定均通过，没有为消除警告擅改系统locale。`Shared connection ... closed`是本次交互SSH命令结束，不是服务退出；主程后续SSH已成功读回正在运行的R31。

## 验收范围与后续
本包仅修2.4失效Skill用户手动处理且按明确错误码判断、2.6 Usage所选范围高亮、2.8无会话记忆范围守卫。Bug-12继续DEGRADED_PREVIEW；第二批其余问题及Gemini八包未因此完成。部署前本地/确切Linux与目标Node24验证见R31-BATCH5-INTEGRATED-AND-FROZEN-20261106.md及R31-TARGET-PREFLIGHT-20261106.md；后检没有新增PT/付费调用。
测试工程师现在使用 **docs/refactor/R31-BATCH5-QA-REQUEST-20261106.md**，逐项记录PASS/FAIL/BLOCKED/DEGRADED与版本证据；原R30结果不得直接迁移为R31通过。本次上线健康、匿名边界、资源指纹通过，不替代登录态交互、真实供应商和独立同版QA。主程未代发外部消息。
部署脚本不需再次运行；保留用户SSH master，不主动关闭。主工作区及作者/Gemini工作树未切换或改写。
