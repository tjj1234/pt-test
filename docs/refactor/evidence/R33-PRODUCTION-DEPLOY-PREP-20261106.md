# R33 正式部署准备：等待 SSH 认证恢复

用户明确确认只有一个正式环境，并授权部署 R33 后通知测试工程师。此前 staging 假设已撤销；本次目标为 https://agent-fat.adorado.top，绝不把 DEPLOYED_FOR_QA 当作环境名称。

精确候选 R33 SHA 3f0cb945646b40580666f8537d578e6f19f9907d2d2c57cbd2aca2b750a5d263、223 源/426 成员，builder --check 和独立 audit 本轮再次通过。270/270 与 Linux 精确归档39/39来自已冻结版本，不重复跑同类测试。主工作树脏工作和作者分支不动。

已准备 scripts/r33-target-validation-20261106.sh 与 R33-DEPLOY-VERIFIED-20261106.sh；bash -n 通过。部署脚本保留全局/旧版部署锁、旧版源码/资源指纹、在途任务阻断、排空后备份、隔离恢复、失败恢复旧 unit/profile 与独立健康核验。新增029迁移只新增两表及索引；先在恢复库用生产 db.migrate 连续运行两次验证幂等，检查 Run 数不变、迁移数+1，再用于 live，随后启动新服务。失败不删除新增表、不自动覆盖 liveDB；旧 R31 可忽略新增表。没有声称实际演练回滚。

当前 SSH ControlMaster 已失效；两次 BatchMode 重连返回 Permission denied (publickey,password)，未获得目标状态，未上传/安装/停机/迁移/切换。不能根据历史 PID 或 R31 记录宣告当前运行事实。用户须先在本机安全终端重建 SSH；不发送密码、不改变 sudoers。通道恢复后先读取实际 unit、目录、权限、健康、备份空间和在途 Run，再上传并执行目标预检；sudo 若仍需交互，则提供已上传且回读 SHA 一致的专用脚本由用户安全执行，随后主程独立复验。
