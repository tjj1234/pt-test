# 北极星 analytics unit 切换到 r3 并启动

r3 三组依赖已安装。现有 analytics unit 仍指向 r2；本步骤上传本机已核对的完整 unit 文件，备份旧 unit 后原子替换，再检查语法和启动。本文件绑定 r3、使用 `--no-seed`、只读写 `/var/lib/northstar/analytics`，没有密钥内容。

## 1. 从 Mac 上传 unit 文件

在 Mac 本机终端（不是 SSH 会话）执行第 9 行：

```bash
scp -P 22 /Users/mmdn/Downloads/pt项目/release-artifacts/northstar-analytics-r3.service tongjiawan@47.237.22.191:/tmp/northstar-analytics-r3.service
```

## 2. 在服务器备份并安装 unit

在服务器 SSH 终端逐条执行第 18–23 行。第 19 行应输出 `inactive`；若仍为 `active`，停下并回传状态。第 20 行保存现有 unit 备份。只有第 21 行摘要匹配预期后，才执行第 22 行。

```bash
sudo systemctl stop northstar-analytics
sudo systemctl is-active northstar-analytics
sudo cp -a /etc/systemd/system/northstar-analytics.service /etc/systemd/system/northstar-analytics.service.r2-20261021
sha256sum /tmp/northstar-analytics-r3.service
sudo install -o root -g root -m 0644 /tmp/northstar-analytics-r3.service /etc/systemd/system/northstar-analytics.service
```

第 21 行 SHA-256 预期：`4d6bb0c985d8d40dd412f4854c487d5f8ed13efe0364b4af070495afa4c4a0bf`。摘要不匹配就停止，不执行第 22 行及后续检查/启动。

## 3. 校验并启动

逐条执行第 32–37 行。第 32 行若输出 `northstar-analytics.service` 错误，停下，不执行第 33–37 行；系统自带 `xfs_scrub_all` / `cloudmonitor` 警告不是本 unit 的错误，不要修改其配置。

```bash
sudo systemd-analyze verify /etc/systemd/system/northstar-analytics.service
sudo systemctl daemon-reload
sudo systemctl enable --now northstar-analytics
sudo systemctl status northstar-analytics --no-pager
sudo journalctl -u northstar-analytics -n 100 --no-pager
curl -fsSI http://127.0.0.1:8095/
```

通过条件：unit 为 `active (running)`，日志确认监听 `127.0.0.1:8095`，本机 HTTP 返回 `200`。`--no-seed` 可能令静态演示 token 的个别自检告警；按日志如实记录。若启动仍失败，只回传该 unit 的验证、状态和相关日志；遮住密码、密钥及 DSN。不要启动 shell 或配置公网代理，直到 analytics 本机检查通过。
