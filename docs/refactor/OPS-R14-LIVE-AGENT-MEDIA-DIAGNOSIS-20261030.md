# r14 当前线上 Agent／媒体故障：运维只读诊断与验收

## 补充：DSH 仍只返回 reason=error 时

把工作区 `scripts/northstar-dsh-safe-errors.cjs` 传至目标机 `/tmp/northstar-dsh-safe-errors.cjs`。脚本只读扫描 runtime 中最近至多100个小于8MiB的明文JSONL，限制遍历项和深度，跳过软链接；只输出固定白名单错误码/HTTP状态，不输出提示词、消息、文件路径或Key。不重启、不发模型请求。语法与敏感标记不外泄夹具检查通过；目标真实事件字段可能不完整，UNCLASSIFIED或空结果仍不能定根因，输出也不绑定特定Run。

```bash
set -euo pipefail
test "$(sha256sum /tmp/northstar-dsh-safe-errors.cjs | cut -d ' ' -f1)" = 78e713f2d73015d77dbbf629dc9df2105eb9c97be46580e3114cb4976e980801
sudo -u northstar /usr/local/bin/node /tmp/northstar-dsh-safe-errors.cjs /var/lib/northstar/runtime
```

回传JSON即可。若 `compressedNotRead>0`，说明存在压缩日志未检查，不能把空errors当作没有错误；不要求运维解压或分享原始私有日志。

后续配置回执已确认：`reviewConfigured=false`、`reviewStatus=not_configured`、`controlledAuthorization=false`、`assetHostsConfigured=false`。三个受控媒体入口配置均缺失，当前 r14 的媒体功能未完成目标机配置交付；这是主 Agent 交接缺口，不能归为用户 Key 权限问题。以下补充采集仅用于形成精确审核文件，不调用付费模型，也不改变策略。

在发生故障的同一账号浏览器 Console 执行，回传 JSON。只取两个已通过本地真实产品链的代表媒体模型及一个文本编排模型；scopeId 是服务生成的凭据作用域摘要，不是 Key。若对应字段缺失，按原结果回传，不手工填造。Run 404 请同时确认“查看本次运行”所在网页与 Console 使用同一域名、同一登录账号；先不以另一账号查询替代。

```js
await (async()=>{
 const response=await fetch('/api/models',{credentials:'same-origin'});
 const data=await response.json();
 const ids=['seedream-5-0-260128','dreamina-seedance-2-0-mini-260615','seed-2-0-lite-260228'];
 console.log(JSON.stringify({http:response.status,ok:data.ok,state:data.catalogDiagnostics?.state,models:ids.map(id=>{const m=data.models?.find(x=>x.id===id);return m?{id:m.id,scopeId:m.scopeId,capabilityRevision:m.capabilityRevision,availability:m.availability,permission:m.permission,runtimeStatus:m.runtimeStatus}: {id,missing:true};})}));
})();
```

2026-10-30 实际回执：服务 active/running、PID223277，ExecStart/WorkingDirectory 均为 r14；本机与公网 health 均 ok。目录 HTTP200、fresh/available、83项；deepseek-flash 和 deepseek-v4-1-flash-260910 均 present、adapted_unverified、manual eligibility ok。四媒体任务全部83项 LOCAL_POLICY_UNKNOWN_OR_DENIED。指定 Run 的详情和事件均404，journal 无关联记录。结论：当前媒体被本地策略明确阻断；目录同步正常。AUTO 缺少成功运行资格与此兼容，但仍须同一账号实际成功 Run 验证。404 不能证明记录被删除，也不能排除账号/租户不一致；不能据此推断上游失败根因。

## 回执后的追加只读检查

媒体接线依赖 `PT_MEDIA_REVIEW_FILE`、`PT_CONTROLLED_MEDIA_AUTHORIZATION` 和受控资产主机列表。此前交接未把目标机媒体策略安装与验收完整落地，当前版本不能按“已可生成”验收。先执行下列命令，只输出配置存在性和包内审核文件的合法性，不输出 Key 或审核内容；不要自行创建全模型放行策略。审核记录绑定当前 Key scope、模型 capabilityRevision，且最长有效24小时，不能复制本地临时试验的审核文件。

```bash
set -euo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'const fs=require("node:fs");const p=process.env.PT_MEDIA_REVIEW_FILE;let review="not_configured",count=null;if(p){try{const r=require("./models/reviewed-media-catalog-view.cjs").readHostMediaReviews(p);review="valid";count=r.length;}catch(e){review=e.code||"invalid";}}console.log(JSON.stringify({reviewConfigured:!!p,reviewStatus:review,reviewCount:count,controlledAuthorization:process.env.PT_CONTROLLED_MEDIA_AUTHORIZATION==="1",assetHostsConfigured:!!process.env.PT_MEDIA_ASSET_HOSTS}));'
```

此命令读取 env-file，不证明正在运行的进程已加载同样值；须与实际 unit 的 EnvironmentFile 路径核对。回传上述 JSON 后，由主 Agent 准备绑定当前用户目录的审核与受控配置，单独给出可回滚激活步骤；不通过改数据库状态或伪造 runtime_verified 放行。

目标：本次 r14 交付必须能正常 Agent 对话和受控多媒体生成。当前用户报告新对话模型同步阻塞、AUTO 无候选、手动模型 Run `5bf5c789-ffbd-4419-af3c-63a0a78e8c63` 返回 `AGENT_TURN_INCOMPLETE`、媒体菜单写“未实测”。这些是未验收证据；不要重复付费提交来试错。本清单只读，不重建 profile、不迁移 DB、不重启服务、不操作 Key。

## 1. 版本、服务与 profile 修复结果

在目标机执行；回传完整输出，环境文件仅做存在性检查，不打印内容。

```bash
set -euo pipefail
systemctl show northstar-shell -p ActiveState -p SubState -p WorkingDirectory -p ExecStart -p MainPID --no-pager
test "$(systemctl show northstar-shell -p WorkingDirectory --value)" = /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar test -r /etc/northstar/northstar.env
curl -fsS --max-time 15 http://127.0.0.1:8098/healthz
curl -fsS --max-time 15 https://agent-fat.adorado.top/healthz
```

若仍有 `Profile requires explicit rebuild`，停止产品试验，先按 [r14 profile 修复清单](OPS-R14-PROFILE-REBUILD-20261030.md)完成升级并回传结果；不得通过降低资格门禁绕过。若 working directory 不是 r14，先报告实际路径，勿在未知版本上执行后续验收。

ActiveState=active
SubState=running
MainPID=223277
ExecStart={ path=/usr/local/bin/node ; argv[]=/usr/local/bin/node /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell/server.cjs ; ignore_errors=no ; start_time=[Fri 2026-10-30 15:02:59 CST] ; stop_time=[n/a] ; pid=223277 ; code=(null) ; status=0/0 }
WorkingDirectory=/opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
{"ok":true,"status":"ok","version":"1.0.0","pid":223277,"uptimeSec":2532,"ts":"2026-10-30T07:45:12.309Z"}{"ok":true,"status":"ok","version":"1.0.0","pid":223277,"uptimeSec":2532,"ts":"2026-10-30T07:45:12.481Z"}

## 2. 只读日志窗口

请运维在目标机**本地**查看 Run 时间前后 10 分钟的服务日志；只回传与 Run ID 关联的时间、固定事件名、错误码、上游 HTTP 状态与重试/调用次数。不要回传原始日志全文、提示词、响应正文、请求头、Cookie、Key 或连接串。

```bash
sudo journalctl -u northstar-shell --since '2026-10-30 00:00:00' --until '2026-10-31 00:00:00' --no-pager -o short-iso --grep '5bf5c789-ffbd-4419-af3c-63a0a78e8c63'
```

该命令可能显示敏感上下文，**仅在目标机本地阅读，不直接复制输出**；按上述字段人工脱敏回传。若服务日志无 Run ID，记录“无关联日志”，不要推断上游成功。

-- No entries --

## 3. 用户登录态只读 API（由运维在测试账号浏览器 DevTools Console 执行）

以下请求沿用当前登录态，控制台只输出固定白名单字段。把结果和 HTTP 状态发回；不要复制 Network 原始响应。必须使用发生故障的同一账号/Key，不能以另一账号的目录资格代替。

```js
const r = await fetch('/api/models', { credentials: 'same-origin' });
const j = await r.json();
console.log(JSON.stringify({http:r.status,ok:j.ok,current:j.current,availability:j.availability?.status,syncedAt:j.syncedAt,diagnostics:j.catalogDiagnostics && {state:j.catalogDiagnostics.state,errorCode:j.catalogDiagnostics.errorCode,failureStage:j.catalogDiagnostics.failureStage,upstreamStatus:j.catalogDiagnostics.upstreamStatus,lastSuccessfulAt:j.catalogDiagnostics.lastSuccessfulAt},models:j.models?.length,deepseek:(j.models||[]).filter(m=>['deepseek-flash','deepseek-v4-1-flash-260910'].includes(m.id)).map(m=>({id:m.id,availability:m.availability,chat:m.chat,runtimeStatus:m.runtimeStatus,eligibility:j.eligibility?.[m.id]&&{ok:j.eligibility[m.id].ok,code:j.eligibility[m.id].code,reasons:j.eligibility[m.id].detail?.reasons?.map(x=>x.code)}})),media:j.mediaQualification&&{ok:j.mediaQualification.ok,rows:j.mediaQualification.rows?.length,taskCodes:Object.fromEntries(['text2image','image2image','text2video','image2video'].map(t=>[t,(j.mediaQualification.rows||[]).map(x=>x.tasks?.[t]).filter(Boolean).reduce((a,c)=>(a[c]=(a[c]||0)+1,a),{})]))}}));
```
{"http":200,"ok":true,"current":"AUTO","availability":"available","syncedAt":1793346590574,"diagnostics":{"state":"fresh","errorCode":null,"failureStage":null,"upstreamStatus":null,"lastSuccessfulAt":"2026-10-30T07:49:50.574Z"},"models":83,"deepseek":[{"id":"deepseek-flash","availability":"present","chat":true,"runtimeStatus":"adapted_unverified","eligibility":{"ok":true}},{"id":"deepseek-v4-1-flash-260910","availability":"present","chat":true,"runtimeStatus":"adapted_unverified","eligibility":{"ok":true}}],"media":{"ok":true,"rows":83,"taskCodes":{"text2image":{"LOCAL_POLICY_UNKNOWN_OR_DENIED":83},"image2image":{"LOCAL_POLICY_UNKNOWN_OR_DENIED":83},"text2video":{"LOCAL_POLICY_UNKNOWN_OR_DENIED":83},"image2video":{"LOCAL_POLICY_UNKNOWN_OR_DENIED":83}}}}

```js
const id='5bf5c789-ffbd-4419-af3c-63a0a78e8c63';
const rr=await fetch('/api/runs/'+id,{credentials:'same-origin'});
const run=await rr.json();
console.log(JSON.stringify({http:rr.status,ok:run.ok,id:run.run?.runId,state:run.run?.state,code:run.run?.errorCode,operations:run.externalOperations?.operations?.length,media:run.managedMedia?.media?.map(x=>({type:x.type,size:x.size}))}));
const er=await fetch('/api/runs/'+id+'/events?after=0&limit=500',{credentials:'same-origin'});
const ev=await er.json();
console.log(JSON.stringify({eventsHttp:er.status,ok:ev.ok,events:(ev.events||[]).map(x=>({seq:x.seq,type:x.type,action:x.payload?.action,code:x.payload?.code,reasonCodes:x.payload?.reasonCodes,model:x.payload?.modelId||x.payload?.model,upstreamStatus:x.payload?.upstreamStatus})).filter(x=>x.code||x.action||x.model||x.upstreamStatus).slice(-50)}));
```
{"http":404,"ok":false}
{"eventsHttp":404,"ok":false,"events":[]}

若 `events` 分页已满500，继续以最后 `seq` 作 `after`，只读下一页；保留同一字段白名单。`/api/models` 若 HTTP 非200或 `ok=false`，回传固定诊断即可，不发送聊天请求。若新对话一直显示“正在同步”，记录新建对话后的 `/api/models?conversationId=<该对话ID>` HTTP 状态与耗时；不复制完整响应。




## 4. 判定与当前版本验收

先确认 r14/profile/目录；再按同一测试账号做**一次**手动文本短问答，必须 `completed`、有回复和实际模型事件。随后同一账号 AUTO 短问答必须 `completed`，否则回传 `reasonCodes` 与目录资格，停止重复尝试。`deepseek-flash` 和 `deepseek-v4-1-flash-260910` 在历史 PT 目录中是两个不同 ID；详情页 URL 不足以替代当前用户目录与上游身份。手动失败时先定位该 Run 的安全错误码，不能把 `AGENT_TURN_INCOMPLETE` 当成根因。

媒体四类各需明确验收状态：文生图、图生图、文生视频、图生视频。已有本地真实 Run 证据不能代替**本次 r14 目标机**回执；每类至少记录同版 Run ID、模型、外部任务终态、托管产物 URL 的授权 GET、历史重开与失败/未知账单状态。只有在模型目录及安全门禁正常后，由运维按既定单次授权流程执行；未知外部提交不得重发。菜单“本地候选（未实测）”当前只反映静态资格矩阵，未读取实际成功 Run，故不能用菜单文字判定真实运行资格或完成度；该产品文案需在后续修正。
