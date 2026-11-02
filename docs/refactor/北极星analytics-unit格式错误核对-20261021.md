# 北极星 analytics unit section 格式错误核对

日志提示 unit 第 20、22 行有配置落在 section 之外。systemd 因此忽略了这些配置；先检查 unit 文件实际内容，尚不要重启服务或改 HTTPS。此文件只有服务配置，不含应用密钥。

在服务器 SSH 终端逐条执行第 8–9 行：

```bash
sudo nl -ba /etc/systemd/system/northstar-analytics.service
sudo systemd-analyze verify /etc/systemd/system/northstar-analytics.service
```

把两条命令完整输出贴回。不要手动猜测要插入哪一行；确认 section 标题及行号后，再按实际内容给出修正步骤。
