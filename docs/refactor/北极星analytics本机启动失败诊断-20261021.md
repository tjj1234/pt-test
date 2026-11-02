# 北极星 analytics 本机启动失败诊断

`curl http://127.0.0.1:8095/` 返回 connection refused，表示服务器本机当前没有进程监听 analytics 端口。先查 systemd 状态与日志；这不是域名检查，也不要为此开放 8095 公网端口。

在服务器 SSH 终端逐条执行第 8–11 行，每条等提示符回来后再继续：

```bash
sudo systemctl is-enabled northstar-analytics
sudo systemctl is-active northstar-analytics
sudo systemctl status northstar-analytics --no-pager
sudo journalctl -u northstar-analytics -n 100 --no-pager
```

把四条命令的完整输出贴回来。日志里若出现密钥、密码或完整 DSN，先遮住对应值再发送。暂时不要重启服务、修改 unit、重装依赖或测试公网域名；先根据实际错误定位。
