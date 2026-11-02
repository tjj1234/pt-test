# 运维：目录缓存 r5 修复候选，只读部署前核对

结论：这是针对当前r2缓存schema TypeError的最小修复候选，不是整期新版或F1完成包。基于已精确匹配线上四源码SHA的冻结r2归档，仅更换shell/models/catalog-cache.cjs；另外324成员逐字节与元数据保持。依赖、锁文件、DB迁移、DSH/预算均不变，不包含当前工作区F2/F3或Gemini媒体引擎。旧r2归档、unit和现场缓存未改动。此清单不授权切换服务；先返回预检结果，再生成最终激活/回滚步骤并由用户批准。

## 本地候选材料

| 文件 | SHA256 |
|---|---|
| northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz | da4933064a310694c2ab12bfba49dd71b5d5be7fec993dbbe85fd3104a2af92b |
| northstar-shell-catalog-cache-r5.service | 69960cd10ccad134babef955480b88602118f57019a54972a883b6426613a83a |
| northstar-catalog-cache-r5.sha256 | aad91ea92f5c140fa073b9a23b5e4cbae7bf7a3c507fef9b654e1a5454854706 |

新目录拟为/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5；回滚基线保留/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2。当前正式unit文件需在激活前另行备份并核对，不能仅凭模板假定完全相同。

## 当前请执行的只读命令

```bash
date -u
/usr/local/bin/node --version
sudo systemctl show northstar-shell --property=MainPID --property=WorkingDirectory --property=FragmentPath --property=ActiveState
sudo sha256sum /etc/systemd/system/northstar-shell.service
sudo stat -c '%F %U %G %a' /opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/shell/node_modules
sudo stat -c '%F %U %G %a' /var/lib/northstar/runtime
sudo -u northstar test -w /var/lib/northstar/runtime && echo RUNTIME_WRITABLE
if test -e /opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5 || test -L /opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5; then
  echo DESTINATION_EXISTS_STOP
else
  echo DESTINATION_ABSENT
fi
df -Pk /opt/northstar/releases /var/lib/northstar/runtime
```

回传上述输出即可，不要提供整个unit、ExecStart参数、进程环境全文、Key或数据库连接串。test失败需回传失败与退出码，不能继续改权限或删除目标目录。若目录出现、PID/WorkingDirectory变化、runtime不可写或Node不符合既有r2运行条件，先停止激活准备并说明差异。

可先把三个候选文件上传到普通交付暂存目录并执行sha256sum -c northstar-catalog-cache-r5.sha256；不要解压覆盖现有release，不安装unit，不restart/daemon-reload。未上传也可先完成上述运行环境核对。后续依赖沿用/安装策略需以node_modules实际类型与旧候选依赖闭包为依据，不直接重跑npm更新。

## 修复行为与验收要求

旧rich缓存缺ptEndpointTasks等必要事实时，不猜测补值或沿用其授权；新目录返回前保持权限未知。首次替换旧无效缓存前，把完整原字节备份为原文件名.invalid-<sha256>.bak并校验，权限0600；备份失败/已有备份内容冲突则拒绝覆盖。新目录成功只建立新返回事实，runtime验证/AUTO证据不会被凭空授予。若上游拉取失败仍可能显示目录未知，但不应再因该旧schema路径抛内部TypeError。

激活后的真实验收必须包括：精确源码新cache SHA=9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e、其他源码不变；health；已登录用户GET /api/models；触及scope的旧缓存原SHA对应备份0600；可用事实与未知/失败状态区别；重启后读取稳定；回滚unit映射。不要为了立即消除未知而给全部模型补permission/verified。浏览器现存登录态不等于新OAuth流程，真实对话/付费调用另需限定范围。

## 本地验证

package-northstar-catalog-cache-r5.py --check可复现；325 USTAR成员、唯一内容overlay、无PAX/GNU/链接/Apple元数据，原依赖/SQL/runner字节不变。f1-catalog-cache-r5-artifact-test.mjs与f1-r2-cache-schema-backport-test.mjs合计5/5通过。此前全仓默认回归179/184，5项旧候选与当前开发源码绑定失败仍保留，不能据本最小repair候选宣布整期发布全绿。
