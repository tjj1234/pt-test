# 北极星 analytics unit 补全 section 并启动

已定位根因：现有 unit 文件漏掉 `[Unit]`、`[Service]`、`[Install]` 三个 section 标题，systemd 因此忽略 `ExecStart` 并拒绝启动。先备份错误文件，再重写完整 unit；只在验证通过后启动。以下 unit 内容不含秘密值。

## 1. 备份错误文件并清空待重写文件

在服务器 SSH 终端一次执行一行，等提示符回来后再执行下一行：

```bash
sudo cp -a /etc/systemd/system/northstar-analytics.service /etc/systemd/system/northstar-analytics.service.broken-20261021
sudo install -o root -g root -m 0644 /dev/null /etc/systemd/system/northstar-analytics.service
```

## 2. 重写完整 unit

打开空文件：

```bash
sudo nano /etc/systemd/system/northstar-analytics.service
```

将以下**第 25–49 行完整粘贴为文件内容**，方括号 section 标题也必须粘贴。按 `Ctrl+O`、`Enter` 保存，再 `Ctrl+X` 退出：

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

## 3. 检查 section，再启动

先执行第 57 行核对实际文件：开头应是 `[Unit]`，`Type=simple` 前应有 `[Service]`，`WantedBy=multi-user.target` 前应有 `[Install]`。再执行第 58 行验证；若出现任何 `northstar-analytics.service` 错误就停下，不执行第 59–63 行。

```bash
sudo nl -ba /etc/systemd/system/northstar-analytics.service
sudo systemd-analyze verify /etc/systemd/system/northstar-analytics.service
sudo systemctl daemon-reload
sudo systemctl enable --now northstar-analytics
sudo systemctl status northstar-analytics --no-pager
sudo journalctl -u northstar-analytics -n 100 --no-pager
curl -fsSI http://127.0.0.1:8095/
```

systemd 可能仍显示 Ubuntu 自带 `xfs_scrub_all` 或 `cloudmonitor` 的既有警告；本步骤只针对 `northstar-analytics.service`，不要修改这些系统 unit。若启动后仍失败，贴出北极星 unit 的核对、验证、状态与日志输出；先遮住任何密码、密钥或 DSN。
