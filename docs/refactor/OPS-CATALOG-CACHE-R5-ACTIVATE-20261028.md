# 运维执行单：目录缓存 r5 激活与回滚（2026-10-28）

状态：材料与离线测试已完成，尚未授权激活。只有用户明确批准本次r5切换后，运维才执行本单的stage/activate；无需每步再等用户确认，成功条件满足即可下一步，任何失败立即停止并回传稳定错误码。此修复只处理旧缓存缺ptEndpointTasks导致的TypeError，不是整期F1/F2/F3发布，不授权模型付费调用。

## 已确认基线与范围

运行r2：/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2；服务northstar-shell、正式unit=/etc/systemd/system/northstar-shell.service，unit SHA=eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105。运维2026-10-27 10:07 UTC预检：Node v24.22.0、MainPID123507、ActiveState active、runtime=/var/lib/northstar/runtime可写、node_modules普通目录root:root 755、新目录不存在、空间约31GB可用。以上为运维回传；脚本会再次核对关键基线，而非盲用旧PID。

新候选：/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5；325个USTAR成员，仅shell/models/catalog-cache.cjs变更，目标SHA=9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e。依赖、SQL迁移、DSH及其他业务源码不变。切换有短暂服务重启；保留r2目录、原unit备份及所有原缓存证据。启动仍按原服务逻辑初始化，不增加迁移定义。

## 1. 上传与校验（获批后执行）

原先三个文件已在/tmp并校验通过，不必重新生成：
- northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz
- northstar-shell-catalog-cache-r5.service
- northstar-catalog-cache-r5.sha256

再上传以下三个交付文件至/tmp：
- northstar-catalog-cache-r5-activate.py
- OPS-CATALOG-CACHE-R5-ACTIVATE-20261028.md
- northstar-catalog-cache-r5-activation.sha256

```bash
cd /tmp
sha256sum -c northstar-catalog-cache-r5-activation.sha256
```
成功条件：5个被校验文件均OK（新清单覆盖原3文件+脚本+本操作单；清单不校验自己）。任一不符停止，不编辑校验值或候选源码。

## 2. 暂存新目录，不切服务

```bash
sudo python3 /tmp/northstar-catalog-cache-r5-activate.py stage
```
脚本重新核对原unit/四源码指纹、Node版本、服务工作目录/active状态、无额外systemd drop-in、runtime可写；目标同时拒绝已存在目录与悬空软链。候选上传文件以O_NOFOLLOW单次有界读取并校验固定SHA，解压只消费已校验内存字节，不在检查后重开可替换的上传路径。将原r2的node_modules完整复制（保留内部链接），不运行npm install/ci或更新依赖；比较复制前后依赖树指纹、依赖清单、全部候选文件及Node语法。

成功条件：result=STAGED_NO_SERVICE_CHANGE，成员325。原unit和运行服务均未改变。stage失败会保留新目录作调查，不自动删除、不覆盖重跑；回传错误码后由主Agent确定处理方式。

## 3. 选择空闲窗口

切换前停止人工发起新聊天/生成请求。运维用现有数据库只读方式执行以下聚合，仅回传状态与计数，不提供连接串、用户/任务ID或请求内容：

```sql
SELECT state, count(*) AS count FROM agent_runs
WHERE state IN ('queued','running','waiting_external','cancelling')
GROUP BY state ORDER BY state;
SELECT status, count(*) AS count FROM run_external_operations
WHERE status IN ('submitting','querying')
GROUP BY status ORDER BY status;
```

成功条件：均无记录或计数均0，且可维持窗口内无新请求。若有执行/提交/查询中的任务，先等其自然完成，不为部署取消付费任务；无法确认空闲则暂不执行activate。历史manual_check保留，不以重提方式“清理”。不能使用可执行迁移的应用初始化器代替只读SQL。

## 4. 激活及基础验证

```bash
sudo python3 /tmp/northstar-catalog-cache-r5-activate.py activate
```

脚本再次验证暂存文件与依赖；把原unit独占保存为/var/lib/northstar/rollback/catalog-cache-r5/northstar-shell.service（目录0700、文件0600，校验旧SHA）。新unit从已验证字节写入同一受保护目录，再由systemd-analyze verify检查；不直接安装可在/tmp被替换的路径。随后install unit、daemon-reload、restart。最多30轮检查active、MainPID、进程/proc/PID/cwd及公网healthz的ok/PID与新工作目录一致。重启或健康/PID校验失败，自动恢复备份unit并重启r2。输出AUTOMATIC_ROLLBACK_FAILED_OPERATOR_REQUIRED时立即人工介入，不连续重试。

基础成功输出：health=ok（PID与新路径）以及ACTIVATED_R5_CATALOG_VERIFICATION_PENDING。仅代表服务与源码身份恢复，不代表目录或F1已验收。

## 5. 已登录浏览器目录验收

主Agent接续现有Google登录会话打开模型目录（GET /api/models），不发聊天或图片/视频生成。该读取会按原逻辑拉取目录并重建当前scope缓存，不属于模型付费请求。应核对：
- 不再因已知旧schema触发MODEL_CATALOG_INTERNAL_TYPE_ERROR。
- 上游目录成功时modelIds及事实恢复；若PT网络/权限失败，则保留明确失败/unknown，不补造verified/AUTO，不强制授予全目录权限。
- 触及scope的原缓存精确备份为原文件名.invalid-<原SHA>.bak，文件0600；与已回传六文件SHA核对。未被访问的scope可以仍保留旧缓存，不能要求首次访问就一次性改写全部六文件。
- 主Agent核对当前选模/历史显示；真实新对话与付费生成范围另行确认，不因目录可用而自动开展。

如需重启后读取验证，可在同一空闲窗口再次systemctl restart northstar-shell并重查上述PID/路径/health和目录；不要在仍有执行任务时重启。基础health通过但目录仍异常时，先回传目录诊断/同时间应用日志，不清缓存、不自行给权限或反复restart。

## 6. 显式回滚

自动回滚成功后不要再次activate。若激活基础通过但后续出现需撤销的问题，获本次回滚授权的运维可执行：

```bash
sudo python3 /tmp/northstar-catalog-cache-r5-activate.py rollback
```

脚本验证原unit备份SHA、正式unit当前只能是已知r2/r5之一、原四源码仍匹配，才恢复unit并daemon-reload/restart，核对r2工作目录/PID/public health。不会覆盖运维后来另改的未知unit。输出ROLLED_BACK_TO_R2_CACHE_FILES_PRESERVED为基础回滚完成；r2原有模型目录故障可能重新出现，回滚不承诺修复该旧故障。

不删除r5目录、备份或新旧缓存；不恢复旧缓存覆盖新事实。r5写出的缓存仍采用schemaVersion1、包含旧读取器所需字段。对账任务及业务数据不重提、不删除。

## 回执

```text
五项文件校验：
stage结果及依赖指纹：
空闲状态聚合计数：
activate或自动rollback结果：
新MainPID/WorkingDirectory/health PID：
目录errorCode/availability/modelCount（脱敏摘要）：
当前scope备份是否匹配原SHA、权限0600：
是否执行显式回滚、结果：
```

## 本地证据与限制

激活控制11/11离线测试通过（所有systemd/install/网络命令均替身），含健康失败自动回滚、未知unit拒绝覆盖、目标悬空链/源码与依赖漂移拒绝、上传路径替换不能改变已校验内容。候选backport+归档独立审计5/5通过；builder --check可复现。未在目标机激活，不把离线控制测试称作目标演练。当前开发工作区全量门禁仍有5项旧包/当前源码绑定失败，本候选独立冻结r2修复，不代表整期发布全绿。
