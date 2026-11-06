# R33 正式目标预检通过：待交互 sudo 切换

目标 agent-fat.adorado.top / 47.237.22.191；本轮经已恢复 SSH 实读 R31 active，PID363348，NRestarts0；analytics active，R33 目录不存在。R31 unit 为 root:0644，服务用户 northstar，环境文件路径仍指向私有配置与 R31 limits；未输出配置值。预检前后服务目录及 PID 均不变。

目标暂存 /tmp/pt-r33-validation-20261106-cf780db，独立新建且0700。确切归档、R33/R31源清单 SHA 全通过，223 新源码和217基线源码逐文件绑定通过。迁移只新增029_user_questions.sql，其余字节不变；DSH settings不变；目标 Python3.14.4语法通过。目标 npm ci 锁定安装、Node24.22.0生产依赖闭包及server/app语法通过，完整日志 R33-TARGET-PREFLIGHT-20261106.txt。

服务器回读部署脚本 SHA256：5b6cd4a93fd60597a76b0f54cee2ae04a3e60f58c901cf060e6bbbd19187e49a；目标预检脚本 SHA a8201e1184a3cde9e3a31b054d6b05faac357bd97862b3c00f9c12b86b34b32d；与本地审查版本完全一致。

当前阻点仅为服务器 sudo 返回 interactive authentication is required。用户应在已登录服务器终端验证上述部署脚本 SHA 后以 sudo bash 执行；不发送口令，不修改 sudoers。脚本执行后主程必须另行读取正式目录、PID、健康、223源码及公网app/CSS指纹，才可宣布 DEPLOYED_FOR_QA。此阶段尚未执行停服/备份恢复/迁移/切换；在途Run计数也仍待root脚本核对，不能称已排空。
