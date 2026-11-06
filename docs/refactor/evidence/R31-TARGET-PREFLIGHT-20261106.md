# R31目标预检：通过，待用户安全sudo切换
2026-11-06。目标47.237.22.191 / agent-fat，SSH master已由用户恢复。预检读取时northstar-shell为active/running、PID339125、NRestarts0，WorkingDirectory仍/opt/northstar/releases/controlled-trial-20261105-candidate-34-r30-bugfix-draft/shell；analytics active。未在预检中停止服务或执行模型。
R30公网/assets/app.js SHAe9f1c17f5053cbf584376e5790e564b5de9cb53ba010a8975624981438a7c5c8与旧release相同。unit User/Group=northstar，EnvironmentFiles为/etc/northstar/northstar.env及旧release/shell/northstar-limits.conf；未读取或输出环境值。普通用户无权stat私有env文件，此项没有冒称已检查其权限，root脚本后续按实际路径加载。新R31 release在预检时不存在。

专属暂存/tmp/pt-r31-validation-20261106-97a3e5a，目录0700。上传确切R31归档、R31/R30源清单和脚本；archive SHA6addd5e342b9696f4d37ddc30bc60412b6f8ab5b735161b2e07fe38df4818955，R31 plan SHA7a82352da1eafda5455ae7baf61695632e49e197cacfb17f054eade7d30a560d，R30 plan SHA3af4318fc935f72fd336103ae9c3b3619bdcb6f6b08778e45e2b6e2a32603684。
目标脚本r31-target-validation-20261106.sh实际执行成功：R31与R30各217源码逐项匹配，迁移与DSH settings字节相同，Python3.14.4 AST检查通过；在暂存解包目录按锁npm ci后，Node24.22.0严格生产闭包495包/31,007文件通过，app/server整文件语法通过。完整日志R31-TARGET-VALIDATION-20261106.txt。安装脚本许可警告未导致闭包漂移，没有修改allowScripts或放宽校验；未将Node22本地验证替代目标Node24验证。

## 最终受控切换
脚本docs/refactor/evidence/R31-DEPLOY-VERIFIED-20261106.sh已上传同暂存目录，服务器回读SHA与本地一致：**029f8c72f1b60b24149f8c622b3857fb78caa016a663118b5536ab37da5d197d**。bash -n通过；脚本是新R31专用，不是盲跑旧R30脚本。已请求用户从本机SSH交互终端先校验该SHA再sudo执行，密码不经过工具或聊天。
脚本先加部署锁、校验旧release全217源码及三份输入SHA；先在旧服务验证本地和公网资源检查路径；新release独立安装并再次验证源码/闭包/迁移/配置。**在途Run计数尚待root脚本实际查询**，非终态不为0就阻断，不强停真实用户Run。只有停Shell后再确认已排空，才备份PG/runtime/secrets/env/unit/profile；dump在新建、PUBLIC撤权、CONNECTION LIMIT0的隔离库实际恢复并核对Run/迁移计数，内容仅留服务器root私有目录。随后原生重建runner profile并切换unit路径，检查PID/目录/源码/本地与公网app/CSS，才输出DEPLOYED_FOR_QA。
失败自动恢复旧unit/profile，并独立核对R30健康PID、WorkingDirectory和app指纹；准备了恢复逻辑不等于已演练回滚。本报告阶段未声称备份/隔离恢复/切换已发生，最终状态必须待用户执行后由主程独立回读。

发布范围仍是三处batch5修复，Bug-12降级、Gemini与其余第二批问题未混入。当前等待仅为SSH master不能共享的sudo交互，不要求用户重跑测试或工程师返工。用户执行后主程继续独立公网与源绑定核验，再更新同版QA入口。
