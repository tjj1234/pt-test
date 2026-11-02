# 北极星 r3：analytics 运行文件改写到数据目录

r2 analytics 失败原因已定位：`start.cjs` 将实例锁写到只读发布目录 `/opt/northstar/.../analytics`。现已把实例锁清理/创建和启动 URL 文件改到 `PT_DASH_DATA_DIR`（服务器上的 `/var/lib/northstar/analytics`），并完成语法核对、r3 包内源文件匹配与敏感/依赖目录排除检查。r2 不要再启动；r3 使用独立目录，当前 analytics unit 仍指向 r2，等 r3 安装核对通过后再单独更新 unit。

## 1. 停止失败的 r2 服务

在服务器 SSH 终端逐条执行第 10–11 行，等待每条提示符回来：

```bash
sudo systemctl stop northstar-analytics
sudo systemctl is-active northstar-analytics
```

第二条应输出 `inactive`；若仍是 `active`，停下并回传状态，不执行后续步骤。

## 2. 从 Mac 上传 r3

在 Mac 本机终端（不是 SSH 会话）执行第 21 行：

```bash
scp -P 22 /Users/mmdn/Downloads/pt项目/release-artifacts/northstar-controlled-trial-20261021-r3.tar.gz tongjiawan@47.237.22.191:/tmp/northstar-release-r3.tar.gz
```

## 3. 在服务器校验、解压并安装

SHA-256 已回传并匹配预期值。先在 SSH 会话逐条执行第 30–34 行解压和核对；若目录权限或 lockfile 不符合预期，就停下。

```bash
sha256sum /tmp/northstar-release-r3.tar.gz
sudo install -d -o root -g root -m 0755 /opt/northstar/releases/controlled-trial-20261021-r3
sudo tar -xzf /tmp/northstar-release-r3.tar.gz -C /opt/northstar/releases/controlled-trial-20261021-r3
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261021-r3
sudo stat -c '%U:%G %a %n' /opt/northstar/releases/controlled-trial-20261021-r3
sudo find /opt/northstar/releases/controlled-trial-20261021-r3 -maxdepth 4 -type f -name package-lock.json -print
```

预期 SHA-256：`03f287520c99d43bd3d2be0e5243d7f457fbdda35dc83edf686c7f21af1ce6f1`。发布目录应为 `root:root 755`，应找到 shell、analytics、business/attribution 三个 lockfile。

确认解压及权限无误后，逐条执行第 42–44 行安装依赖，每条等提示符回来后再继续：

```bash
cd /opt/northstar/releases/controlled-trial-20261021-r3/shell && sudo npm ci --ignore-scripts --no-audit --no-fund
cd /opt/northstar/releases/controlled-trial-20261021-r3/analytics && sudo npm ci --ignore-scripts --no-audit --no-fund
cd /opt/northstar/releases/controlled-trial-20261021-r3/business/attribution && sudo npm ci --ignore-scripts --no-audit --no-fund
```

先回传停止命令、摘要、目录核对和三组依赖结果。不要重启 analytics；下一步会把 unit 的工作目录和入口从 r2 指向 r3，完成语法检查后再启动。此修正仍只验证本机服务，HTTPS 公网入口另行配置。
