# 当前只需做两件事：配置基线与媒体目录回执
结论：运维先运行本包只读预检并回传；不要停服务、修改settings、重建profile或部署r16草案。本包不含应用归档或部署命令，只补齐升级决策缺失的证据。此前24模型/四ID存在性结果无需重复单独采集。

## 1. 运维：只读配置基线
把本ZIP内容解压到`/tmp/northstar-r16-preflight-20261030/`；先在该目录执行`sha256sum -c checksums.sha256`，必须全部OK。然后完整执行下列块并回传输出和退出码。不得打印环境文件或settings正文。
```bash
set -euo pipefail
systemctl show northstar-shell -p ActiveState -p SubState -p WorkingDirectory -p ExecStart -p MainPID --no-pager
test "$(systemctl show northstar-shell -p WorkingDirectory --value)" = /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env /tmp/northstar-r16-preflight-20261030/northstar-active-config-inspect.cjs
```
`settingsStatus`、三个SHA和baseline匹配字段区分无基线/原样旧模板/运维改动；此脚本不建立或覆盖基线。返回ACTIVE_CONFIG_INSPECTION_FAILED时只回传该错误，不尝试删除锁、manifest或重建home。
接着执行媒体配置结构预检（独立块，不与上一块串成失败后继续修改的脚本）：
```bash
set -uo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env /tmp/northstar-r16-preflight-20261030/northstar-media-config-preflight.cjs
media_preflight_exit=$?
printf 'media_preflight_exit=%s\n' "$media_preflight_exit"
exit "$media_preflight_exit"
```
媒体预检exit2表示配置缺失/无效，是正常诊断结果，不是要求立即开启。此前三项均缺失；若配置没有改动，可直接注明“媒体配置未变”，无需再跑第二块。exit0仅表示结构及时间通过，不代表同Key资格或真实媒体运行验收。

## 2. 故障同账号浏览器：只读媒体scope/revision
在发生故障的同域名、同登录账号浏览器DevTools Console执行一次，回传最后JSON。无需提供Key，不发送聊天或生成请求。
```js
(async()=>{
 const response=await fetch('/api/models',{credentials:'same-origin'});
 const data=await response.json();
 const ids=['seedream-5-0-260128','dreamina-seedance-2-0-mini-260615','seed-2-0-lite-260228'];
 console.log(JSON.stringify({http:response.status,ok:data.ok,state:data.catalogDiagnostics?.state,models:ids.map(id=>{const m=data.models?.find(x=>x.id===id);return m?{id:m.id,scopeId:m.scopeId,capabilityRevision:m.capabilityRevision,availability:m.availability,permission:m.permission,runtimeStatus:m.runtimeStatus}:{id,missing:true};})}));
})();
```
字段缺失按原样回传，不能手工补造；不能使用另一账号的scope代替。两项回执可以分别发回，不必等齐。

## 主Agent后续交付
收到配置基线后锁定升级路径：旧模板原样保留则复用现有settings升级器；运维编辑则先准备精确合并差异，保留自定义配置。随后交付绑定校验和的修复发布包、目标安装/备份、settings升级、profile重建、启动/回滚和普通对话验收命令。媒体精确审核配置另需上述同Key目录回执与实际CDN依据，不因修复文本而全模型放行。
r16应用草案已冻结并通过Linux和聚焦验证；默认232套件首轮214通过/18失败，随后12项修复复跑通过，余6历史绑定未报全绿。待目标验收项继续保留。此预检包不是部署批准，当前不切服务。
