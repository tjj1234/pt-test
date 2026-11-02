# 北极星受控试运行：analytics 服务首次启动

前提：r2 三组依赖已安装；配置文件格式为 25 行；analytics 使用自己的 PGlite 数据目录 `/var/lib/northstar/analytics`，以 `--no-seed` 启动，避免写演示事件。服务只监听 loopback `127.0.0.1:8095`，此步骤不开放公网端口。

## A. 建好可写目录

在服务器 SSH 终端单独执行第 10 行，等待提示符回来：

```bash
sudo install -d -o northstar -g northstar -m 0750 /var/lib/northstar/analytics /var/lib/northstar/secrets /var/lib/northstar/runtime/logs
```

## B. 创建 systemd unit

执行第 16 行打开 nano：

```bash
sudo nano /etc/systemd/system/northstar-analytics.service
```

将下面**仅 unit 文件内容**完整粘贴到 nano（不要把 fenced code 的标记粘进去），按 `Ctrl+O`、`Enter` 保存，再按 `Ctrl+X` 退出：

```ini
[Unit]
Description=Northstar Analytics (Controlled Trial)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=northstar
Group=northstar
WorkingDirectory=/opt/northstar/releases/controlled-trial-20261021-r2/analytics
EnvironmentFile=/etc/northstar/northstar.env
ExecStart=/usr/local/bin/node /opt/northstar/releases/controlled-trial-20261021-r2/analytics/start.cjs --no-seed
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/northstar/analytics
SyslogIdentifier=northstar-analytics

[Install]
WantedBy=multi-user.target
```

## C. 验证并启动 analytics

每次只执行一行，等 `$` 提示符回来后再执行下一行。先执行第 56 行验证 unit 语法；只有成功无错误后，再执行第 57–61 行：

```bash
sudo systemd-analyze verify /etc/systemd/system/northstar-analytics.service
sudo systemctl daemon-reload
sudo systemctl enable --now northstar-analytics
sudo systemctl status northstar-analytics --no-pager
sudo journalctl -u northstar-analytics -n 100 --no-pager
curl -fsSI http://127.0.0.1:8095/
```

通过条件：unit 为 `active (running)`，日志显示 analytics 服务监听 `127.0.0.1:8095` 且 startup security/database checks 没有拒绝启动，最后一条 HTTP 返回 `200`。`--no-seed` 下针对静态演示 token 的自检警告需单独记录，不要误报成完整 analytics 验收。若 unit 验证或启动失败，停下，只回传失败命令及其前后相关日志；日志中若有敏感值先遮掉。不要继续创建 shell unit，也不要启动旧版。

analytics 通过后，下一阶段才启动 shell（PostgreSQL 上的 Northstar 身份/会话数据库）。HTTPS 反向代理仍未确认和配置；本机服务启动不等于域名已上线。
