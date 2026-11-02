# 运维下一步：只读统计缓存字段形态

目的：区分线上r2是否命中已离线复现的旧rich schema缺字段TypeError。不是新版部署申请，不重启/不清缓存/不修改Key/不调用PT。

先把 `scripts/northstar-catalog-cache-shape.cjs` 单文件传到目标 `/tmp/northstar-catalog-cache-shape.cjs`。脚本SHA256：`d32772b6f281fe5d3a7db02b25a76f0c0b55140afec39904b4607e3cbd0ce52a`；仅Node内置，无安装依赖。核对：
```bash
sha256sum /tmp/northstar-catalog-cache-shape.cjs
```

确认当前运行runtime路径。仅读取PT_RUNTIME_DIR，严禁回传/proc环境全文；若MainPID已变化先用systemctl show northstar-shell --property=MainPID取得实际PID并替换：
```bash
sudo python3 - <<'PYOPS'
from pathlib import Path
entries = Path('/proc/123507/environ').read_bytes().split(b'\0')
env = dict(item.split(b'=', 1) for item in entries if b'=' in item)
print(env.get(b'PT_RUNTIME_DIR', b'/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2/runtime').decode())
PYOPS
```

用打印出的绝对目录替换下面占位路径，再运行。若值为相对路径，按实际服务WorkingDirectory解析后传绝对路径：
```bash
sudo /usr/local/bin/node /tmp/northstar-catalog-cache-shape.cjs --cache-dir /实际/runtime/目录
```

仅回传该命令的JSON输出。无需缓存正文、文件名中的scope、模型/用户ID、Key、Cookie、数据库或环境全文；脚本不会输出这些值。若输出PROBE_FAILED，先核对目录是否实际存在及当前读取权限，不修改文件权限来绕过。若oversized或limitReached不为零，报告计数，不扩大上限或删文件。探针不自动检查子目录，所以必须使用应用实际runtime根目录（即model-catalog-*.json所在目录）。

重点看每文件 `records` 与 `fields.ptEndpointTasks.missing/null/invalidWrapper/valueMissing/valueWrongType`，同时检查endpoints、inputModalities、outputModalities和tasks。原6文件/480 richRecords仅说明大体记录形状，不排除这些嵌套字段缺失。
