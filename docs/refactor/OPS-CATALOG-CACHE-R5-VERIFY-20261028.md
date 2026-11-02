# r5目录修复：激活后最后两项运维证据

已回传：5项文件校验OK，stage325成员/依赖指纹38fe63889d5af937250239657a0ddedcd8786fc5345437b817a01f7f0a7db15f，Run与提交/查询活动均0，激活PID191830/newWorkingDirectory，health通过。主Agent浏览器已见GET /api/models state=fresh/errorCode=null/availability=available/modelCount82；公网health PID也为191830。以下不扩大授权、不触发模型付费请求。

## 1. 只读核对备份

```bash
sudo python3 - <<'PYOPS'
from pathlib import Path
import hashlib,stat,json,re
root=Path('/var/lib/northstar/runtime')
expected={'46c6e452d8fd7be69d4405bd7b1a6e0f76f45cbe00a6f8320250c631e761e250','a3aef4cb1e8eb8408ee2108eb3a236035643b3337442b223e4aab0c56c6ee300','a5e3a9d03d7281be0e2fc976c6e08211ea11ebe1fd9abee8e8e2b27740cb4f6a','4ff1061bd93f1ff52b6af4a16369cfc35f7751b4aeec5e02f073e7643255b0f9','e89ada9f0bd4ca6e57ce693dd52597d92e723d2da37bbc44f6b68323b8142898','d934ef137772cb35aa4657f496047944970fb06206a3c1ff7e4948e33e442f55'}
rows=[]
files=list(root.glob('model-catalog-*.json.invalid-*.bak'))
if len(files)>64: raise SystemExit('BACKUP_SCAN_LIMIT_STOP')
for file in sorted(files):
    match=re.fullmatch(r'model-catalog-[a-f0-9]{64}\.json\.invalid-([a-f0-9]{64})\.bak',file.name)
    if not match: continue
    meta=file.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_size>4*1024*1024: raise SystemExit('BACKUP_TYPE_OR_SIZE_STOP')
    data=file.read_bytes()
    sha=hashlib.sha256(data).hexdigest()
    rows.append({'sha256':sha,'bytes':len(data),'mode':oct(stat.S_IMODE(meta.st_mode)),'matchesName':sha==match.group(1),'matchesOriginalSix':sha in expected})
print(json.dumps({'backups':rows,'count':len(rows)}))
PYOPS
```

成功条件：当前已触及scope至少有1个备份，matchesName=true、matchesOriginalSix=true、mode=0o600。未访问的另外5个scope可以尚未改写，不要求一次产生6份备份；不回传原缓存正文或用户scope。不符则回传摘要，不删改缓存。

## 2. 空闲窗口重启后复验

仅在原操作单的两项活动计数仍为空、暂停人工新请求的窗口内，执行已获批操作单第5步的重启后复验：

```bash
sudo systemctl restart northstar-shell
sudo systemctl show northstar-shell --property=ActiveState --property=MainPID --property=WorkingDirectory
curl --fail --silent --show-error --max-time 10 https://agent-fat.adorado.top/healthz
```

成功条件：active、新PID为正、WorkingDirectory仍r5、public health ok=true且PID匹配。将回执发主Agent，随后主Agent在已有登录浏览器再读/api/models，核对fresh/cached成功而无原TypeError。若活动计数不为空，不重启，不取消任务。重启失败按已批准操作单回滚，不反复试验；目录恢复不等于全部82模型均能聊天/AUTO，也不替代F1媒体验收。
