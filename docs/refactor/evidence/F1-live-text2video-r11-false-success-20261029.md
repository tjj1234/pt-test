# F1 文生视频：远端成功、托管失败与 r11 完成门禁

2026-10-29，真实产品入口对 `dreamina-seedance-2-0-mini-260615` 作一次显式授权文生视频提交，Run `d0b913f6-23da-4f08-80bf-d5fe75f66015`，PT task `task_rG4FqFS5NyefXXurkTdCz8H5Mi0HfM0K`。持久外部操作为 `succeeded`，但 `media_route` 为 `isError:true`，托管媒体0、历史无媒体；r10错误地把Run标为 `completed` 并保存模型“已展示”话术。只读查询原task返回 HTTP200/completed，结果主机为 `pub-425ca9cea13d454a907692a0a9f80079.r2.dev`，当时不在受控资产白名单。查询未重新POST，未将签名结果URL写入证据。原始本地记录：`F1-live-agent-20261029-t2v-r1.json` 和 `F1-live-session-20261029.json`；它们不证明本地视频可播放。

r11新增 `shell/tasks/media-result-acceptance.cjs` 并在 `shell/server.cjs` 接入：显式媒体Run只有唯一成功 `media_route`、媒体类型正确且URL属于同Run的 `/api/run-media/` 托管路径，才允许成功答复与 `completed`；否则保存步骤/用量、写入固定核对提示、Run/SSE返回 `MEDIA_RESULT_NOT_AVAILABLE` 和 `failed`，不回放模型成功话术。受控试验资产主机白名单仅增加上述精确主机。独立结构门禁、同版锁定SDK+HTTP四媒体及失败/重开夹具、活动归档绑定共3/3 PASS；这些是离线回归，尚未做第二次真实文生视频产品验收。

活动归档r11为 `northstar-controlled-trial-20261029-candidate-34-r11-draft.tar.gz`，SHA256 `0c8fd82cfaac5c13c5c20e2e475a9f76cb37a085096f2238c2cc62ba051e75a1`，381成员/180绑定源码；可重复构建、归档审计、`git diff --check`通过。状态 `DRAFT_NOT_FOR_DEPLOYMENT`。确切r11 Linux业务验证、目标机上线/回滚及官方账单证据仍须分别核对。

非沙箱默认全量回归最终217套件211通过/6失败，原始日志 `/private/tmp/northstar-r11-regression-unsandboxed-r2-20261029.log`；六失败为f1-candidate34旧归档、t16 candidate28/30/31/32旧归档、t17旧lockfile来源绑定。首次r11回归209/8暴露两处旧夹具把无托管媒体请求视为成功；按新契约修正后定向2/2及上述全量复验通过。沙箱运行187/30含本机HTTP限制，不作为代码通过率。

r11真实产品复验：单次显式授权文生视频Run `54336668-9c1e-4df5-9e78-90108fc90b02`，PT task `task_4bQ10dopNvaYeOufuhvYGY5be5L4ewNK`，外部操作 `succeeded`，Run `completed`，预算1工具/2模型/0重试，托管MP4为2,030,749字节、SHA256 `c2da40eeaeaf8372233098851bb9c95cc3a1d9b6aad6241ecda848c29b77825f`；登录态GET200且下载hash吻合，匿名401，历史重开引用同一Run本地URL。无传输mock，Key仅通过无回显TTY进入临时进程，临时加密BYOK库已删除，日志泄露检查false；证据 `F1-live-agent-20261029-t2v-r2.json`。媒体文件字节和权限已验，未做画面语义/播放质量人工核验，不证明图生视频、目标机或官方账单。

确切r11归档在隔离Linux/amd64 Node v22.23.4、干净tmpfs执行 `npm ci --ignore-scripts --no-audit --no-fund` 安装621包，生产闭包 `--check` PASS：472包/30,091文件、Arborist8.0.5、lock SHA795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912；原始日志 `r11-linux-node-20261029.log`。未运行归档内业务测试，亦非目标机部署。
