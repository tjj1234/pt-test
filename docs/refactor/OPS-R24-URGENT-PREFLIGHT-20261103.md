# r24：13:00 交付前运维协作（只读）
状态：待目标与媒体配置回执；此文不是切换或部署命令。r24 确切归档 SHA256 `1aa947848010156e183cea351febf5f6b0c4ea7ceede0ed17c2830448eb08153`；Linux 联合 15/15＋记忆1/1、隔离 PostgreSQL 4/4 和 023→028 升级/旧版仓储读取已通过。真实生产功能、目标版本及回滚演练仍待验证。禁止提供 Key、Cookie、签名完整 URL、环境文件或数据库内容。

## 运维：当前基线与备份
回传以下脱敏信息及采集时间：`northstar-shell` 的 ActiveState、MainPID、WorkingDirectory，Node/Python 版本；PostgreSQL 一致性备份的时间、备份是否可读取和恢复点标识；旧 release、旧 unit、DSH home/settings/profile 各自可回滚备份是否存在。上述 10 月 30 日回执表明 settings 与 r14 模板完全相同但尚无版本基线；三个模型未配置，正式更改前必须重新核对哈希，先备份并按受信升级器 adopt → upgrade → profile rebuild，不覆盖运维更改。回滚需一起恢复 unit、release、settings 和 profile；数据库迁移不会随 unit 回滚自动撤销。

```bash
systemctl show northstar-shell -p ActiveState -p SubState -p MainPID -p WorkingDirectory --no-pager
/usr/local/bin/node --version
python3 --version
```

媒体预检先前为 reviewConfigured=false、controlledAuthorization=false、assetHostsStatus=not_configured。请确认当前是否仍相同，提供 PT 官方确认的结果素材 **CDN 主机名和来源**、各模型/任务的官方能力依据。不要用完整签名链接或临时生成样本替代受审核域名；不要创建全模型放行文件。

## 两位用户：各自在原登录账号只读获取矩阵
在同站点登录后执行以下一次；只执行 GET，零生成和零付费。分别回传 JSON，不输出 Key 或页面其他信息。模型列表可由业务方替换为实际要使用的明确 ID，不要从名称推断支持任务。

```js
(async () => {
  const r = await fetch('/api/models', { credentials: 'same-origin' });
  const j = await r.json();
  const ids = ['seedream-5-0-260128', 'dreamina-seedance-2-0-mini-260615', 'seed-2-0-lite-260228'];
  const rows = j.mediaQualification?.rows || [];
  console.log(JSON.stringify({http:r.status, ok:j.ok, catalog:j.catalogDiagnostics?.state,
    models:ids.map(id => {
      const m = j.models?.find(x => x.id === id), row = rows.find(x => x.modelId === id);
      return m ? {id, scopeId:m.scopeId, capabilityRevision:m.capabilityRevision,
        availability:m.availability, permission:m.permission, runtimeStatus:m.runtimeStatus,
        tasks:row?.tasks || null} : {id, missing:true};
    })}));
})();
```

这些矩阵的 `LOCAL_POLICY_UNKNOWN_OR_DENIED` 只能说明本地策略阻断，不能证明模型不支持该任务。`permission:true` 不能替代模型任务声明、适配器资格、受信审核、单次 Run 授权或实际执行。两用户 scope 各自独立；review 有效期最长24小时，必须以最新 scope/revision 和真实来源生成，不能伪造 runtime verification。A.04 状态码生产上线时间与 A.11 `/v1/videos` 的 `seconds` 与 PT 所说 `duration` 字段关系仍待 PT 确认。
