# candidate-34 完整源草案（不是上线包）
当前主线完整源已冻结为 `release-artifacts/northstar-controlled-trial-20261028-candidate-34-draft.tar.gz`，SHA256 `27dc651494661f7bf657404a0fe091be9a3319be10f79506b826dedf18dbb14c`。366成员、310普通文件；165当前源码有逐文件SHA绑定。另附sources.json、service及sha256。此为新草案身份，未覆盖r5或旧候选，未部署，不授权付费。

复用r4冻结成员骨架与原portable Linux npm闭包：当前shell及media生产源显式更新，新增F2/F3/Python/SQL资源逐项列入allowlist；排除pycache/凭据/运行状态，未将未接线Word/PDF模块自动纳入。analytics/其他业务快照保留，不作为本次部署对象。预算仍保留已审默认与CSV profile；没有为赶日期放开媒体额度。缺少真实model×task资格的Python adapter不能自动接管旧JS路由。

本轮验证：
- builder --write与--check相同SHA；独立audit通过：唯一安全USTAR成员、外部校验、当前源码绑定、Python引擎/许可证SHA、npm package/lock/npmrc闭包绑定、上线shell/media静态相对导入完整性。
- runner部署时的三个profile相对引用按已有makeProfile映射检查；静态检查不替代动态profile/干净安装。
- 新归档回归2/2；结果门禁52/52；真实worker/宿主15/15；提交/恢复4/4。DSH清单20文件0.1.1-rc.2通过。
- 沙箱外完整回归在当时191套件中186通过5失败，失败为旧candidate28/30/31/32源码绑定及旧candidate17 lock来源绑定。未改旧断言或历史包假绿。此后新加draft归档套件另跑2/2，未声称完整默认门禁全绿。

仍缺：干净Linux/npm闭包实际check、Python目标解释器和worker冒烟、PG独立回归、媒体预算/价格与资格、同版真实聊天/A→B/四媒体/CSV下载/台账/历史重开、目标空闲迁移/部署/回滚。只能标DRAFT_NOT_FOR_DEPLOYMENT；周五包需关闭这些门禁或据实报告延期，不把草案当可上线包。

## 后续独立环境证据（本轮追加）
- 实际candidate34 tar解包，Linux/amd64 Node22.23.4、全新tmpfs node_modules、`npm ci --ignore-scripts --no-audit --no-fund`完成；原portable closure `--check` PASS，472包/30091文件。没有改package/lock或依赖版本；不声称执行过安装脚本。
- 同tar实际解包文件在Linux/amd64 Python3.12、network=none容器：worker4/4、主审引擎15/15通过。镜像为官方python:3.12-slim，拉取digest sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f。未证明现网/usr/bin/python3版本，仍需目标只读核对。
- PG独立临时容器门禁4/4通过。首轮3/4源于旧测试fixture仍等待operation-row锁；修正为当前Run-row SKIP LOCKED行为，立即收集预期LEASE_LOST、首轮跳过、释放后恢复一次和重复为空，生产store未改。容器northstar-candidate34-pg-20261028已stop且--rm，内存DB释放，不连接线上。
- source-generated profile快照因应用变化更新，旧版本保存在/private/tmp/northstar-profile-snapshot-before-20261028-main；当前14文件check PASS，manifest SHA790a456bcfc669a1bd7654fe5473919a31c0a3d4b976e7942e8e7a6c0e87549a。不是现网profile验证。
- 上述补充关闭Linux/npm、隔离Python、PG本地门禁，未关闭真实业务、现网Python、媒体预算资格、目标新包部署/回滚。草案仍不可部署。

## 目标机只读 Python 回执
运维返回：/usr/bin/python3，Python3.14.4，minimumVersionOk=true、stdlibOk=true，northstar用户可执行；r5仍active/PID192553/原目录。目标解释器路径/基础标准库门禁通过。隔离Python3.12证据不能直接外推3.14.4，主Agent正在补相同版本包内兼容性验证；本段不将基础import检查记为真实媒体调用通过。

目标同版本兼容性补验完成：官方Linux/amd64 python:3.14.4-slim（digest sha256:2ca02f32b4d9d893863367ce07ec1972819f476dd38d8612f2a9cb6a41cbb727），从candidate34实际tar解包，在network=none条件下worker4/4与引擎主审15/15通过。与运维的/usr/bin/python3 3.14.4版本一致；这是隔离包内验证，不是现网付费调用。
Gemini归档预检原35项通过但主审反例阻断，修后41项与Node包装器2项通过；对本草案只读扫描366成员/310文件/56目录，约10.7MB普通文件，成功。实际归档SHA及来源绑定未变化。
