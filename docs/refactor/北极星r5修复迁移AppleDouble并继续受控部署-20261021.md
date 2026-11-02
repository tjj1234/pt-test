# 北极星 r5：修复迁移器误读 macOS AppleDouble 元数据

状态：r5 的 19 条 SQL migration 已应用，`northstar-shell.service` 当前 `active (running)`，本机 `http://127.0.0.1:8098/healthz` 返回 `{"ok":true}`。Google 身份/会话库初始化和 chat 1 次/分限流均见启动日志。公网 HTTPS 入口、浏览器 Google OAuth 与一次 T03 调用尚未验收。r4 失败根因为迁移目录含 `._*.sql` AppleDouble 文件，而旧迁移器仅按 `.sql` 后缀筛选；r5 迁移器已排除 `._` 文件，归档也排除 AppleDouble 元数据。

产物：[`northstar-controlled-trial-20261021-r5.tar.gz`](../../release-artifacts/northstar-controlled-trial-20261021-r5.tar.gz)，SHA-256 `751c5ca23c9de2f5b7ba6b554431b17665a693ce36eb39ecb11d9fceb7f98f78`；[`northstar-shell-r5.service`](../../release-artifacts/northstar-shell-r5.service)，SHA-256 `11db2dd8203779e263c323db43de29b17895f0c93a64fef98673698a6f0d4631`。归档清单确认含 19 个正式 SQL migration，未含 `._*` 或 `__MACOSX` 项。

## A. Mac 本机上传

在 Mac 本机终端（不是 SSH）逐条执行第 12–13 行：

```bash
scp -P 22 /Users/mmdn/Downloads/pt项目/release-artifacts/northstar-controlled-trial-20261021-r5.tar.gz tongjiawan@47.237.22.191:/tmp/northstar-release-r5.tar.gz
scp -P 22 /Users/mmdn/Downloads/pt项目/release-artifacts/northstar-shell-r5.service tongjiawan@47.237.22.191:/tmp/northstar-shell-r5.service
```

## B. SSH 服务器安装 r5 文件

上传完成后，在服务器 SSH 终端逐条执行第 21–31 行。校验值必须与上文一致；归档元数据检查应只输出 `ARCHIVE_METADATA_CLEAN`；解压后 `._` 文件检查应无输出；否则停止并回传，不继续安装依赖或启动服务。

```bash
sudo systemctl stop northstar-shell
sudo systemctl is-active northstar-shell
sha256sum /tmp/northstar-release-r5.tar.gz /tmp/northstar-shell-r5.service
sudo tar -tzf /tmp/northstar-release-r5.tar.gz | grep -E '(^|/)\._|(^|/)__MACOSX/' || echo ARCHIVE_METADATA_CLEAN
sudo install -d -o root -g root -m 0755 /opt/northstar/releases/controlled-trial-20261021-r5
sudo tar -xzf /tmp/northstar-release-r5.tar.gz -C /opt/northstar/releases/controlled-trial-20261021-r5
sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261021-r5
sudo stat -c '%U:%G %a %n' /opt/northstar/releases/controlled-trial-20261021-r5
sudo find /opt/northstar/releases/controlled-trial-20261021-r5 -maxdepth 4 -type f -name package-lock.json -print
sudo find /opt/northstar/releases/controlled-trial-20261021-r5/shell/db-migrations -maxdepth 1 -type f -name '._*' -print
sudo find /opt/northstar/releases/controlled-trial-20261021-r5/shell/db-migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort
```

Expected: service stop may produce no text; `is-active` says `inactive`; hashes are the two values above; release directory is `root:root 755`; three `package-lock.json` files are listed; `._*` check prints nothing; SQL listing has 19 normal migration filenames and none beginning `._`.

## C. 安装 r5 依赖

只有 B 部分结果符合预期后，逐条执行第 41–43 行；每条等命令结束并返回 `$` 提示符：

```bash
cd /opt/northstar/releases/controlled-trial-20261021-r5/shell && sudo npm ci --ignore-scripts --no-audit --no-fund
cd /opt/northstar/releases/controlled-trial-20261021-r5/analytics && sudo npm ci --ignore-scripts --no-audit --no-fund
cd /opt/northstar/releases/controlled-trial-20261021-r5/business/attribution && sudo npm ci --ignore-scripts --no-audit --no-fund
```

## D. 安装 r5 unit，先单独执行迁移

依赖安装完成后，在 SSH 终端执行第 51–54 行安装 unit 并检查；unit SHA-256 必须为 `11db2dd8203779e263c323db43de29b17895f0c93a64fef98673698a6f0d4631`，`systemd-analyze verify` 不得报 `northstar-shell.service` 错误：

```bash
sudo cp -a /etc/systemd/system/northstar-shell.service /etc/systemd/system/northstar-shell.service.r4-20261021
sudo install -o root -g root -m 0644 /tmp/northstar-shell-r5.service /etc/systemd/system/northstar-shell.service
sha256sum /tmp/northstar-shell-r5.service
sudo systemd-analyze verify /etc/systemd/system/northstar-shell.service
```

确认 unit 校验通过后，先运行第 60 行迁移器，再运行第 61 行数据库计数。预期应输出 `MIGRATOR_TOTAL=19`、`MIGRATIONS_APPLIED=19` 和 19 个迁移名，数据库计数为 19；失败、数量不同或出现非 SQL 文件名时停止，不启动 shell。2026-10-21 首次执行已应用全部 19 条迁移；systemd-run 返回失败状态只是旧校验条件误设为 18，勿重复运行迁移器：

```bash
sudo systemd-run --wait --pipe --collect --unit=northstar-pg-migrate-r5-20261021 -p User=northstar -p Group=northstar -p WorkingDirectory=/opt/northstar/releases/controlled-trial-20261021-r5/shell -p EnvironmentFile=/etc/northstar/northstar.env -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes /usr/local/bin/node -e 'const dbm=require("./db.cjs");(async()=>{let x;try{x=await dbm.open({dataDir:"/var/lib/northstar/db"});const total=await dbm.migrate(x.db,"./db-migrations");const rows=await x.db.query("SELECT name FROM schema_migrations ORDER BY name");console.log("MIGRATOR_TOTAL="+total);console.log("MIGRATIONS_APPLIED="+rows.rows.length);console.log(rows.rows.map(r=>r.name).join("\n"));if(total!==19||rows.rows.length!==19)process.exitCode=1;}catch(e){console.error("MIGRATOR_FAILED code="+(e.code||"none")+" message="+(e.message||""));process.exitCode=1;}finally{if(x)await x.close();}})();'
sudo -u postgres psql -d northstar -c 'SELECT count(*) AS applied_migrations FROM schema_migrations;'
```

Only after exactly 19 migrations are recorded, execute the following in order; health must return JSON containing `"ok":true` and `northstar-shell` must be `active (running)`:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now northstar-shell
sudo systemctl status northstar-shell --no-pager -l
curl -fsS http://127.0.0.1:8098/healthz
```

This establishes only local controlled-trial startup and database migration. It does not establish HTTPS proxy, Google OAuth, browser login, live provider behavior, T03 acceptance, or Phase 1 completion. Do not submit a model generation request until shell health and the external route are separately confirmed; keep the configured call limits in place.

## E. 只读检查公网 HTTPS 转发

本机服务已通过：2026-10-21 `northstar-shell` 显示 `active (running)`，本机 `/healthz` 返回 `{"ok":true}`。下一步在 SSH 服务器逐条运行第 80–81 行，只查 DNS 解析及 HTTPS health 响应，不触发登录或生成请求：

```bash
getent ahosts agent-fat.adorado.top
curl -sS -D - https://agent-fat.adorado.top/healthz -o /dev/null
```

服务器回传结果：DNS 解析到 `47.237.22.191`；访问 `https://agent-fat.adorado.top/healthz` 在 218ms 后报 `curl: (7) Failed to connect ... port 443`。这是 TCP 连接拒绝，当前公网请求尚未到 HTTPS 或 Northstar 路由层。先确认本机是否存在 80/443 监听、Nginx/Caddy 服务和 UFW 规则，再决定云侧检查；不要发起模型生成。

## F. 只读检查服务器 HTTPS 入口现状

在 SSH 终端逐条执行第 91–93 行，把完整输出贴回。此步骤只读取监听、服务和防火墙状态，不会安装或改动配置：

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
systemctl is-active nginx caddy 2>/dev/null || true
sudo ufw status verbose
```

若无 80/443 监听且 Nginx/Caddy 均非 `active`，则需要核对云厂商安全组/负载均衡的 443 规则及证书部署位置；仅改 DNS 无法建立 TLS。若发现本机代理或 UFW 拒绝，再根据真实状态拟定最小修改步骤。在明确入口和证书所在位置前，不安装或配置新代理。

服务器回传：80/443 没有监听；Nginx、Caddy 均 `inactive`；UFW `inactive`。这排除了当前主机上的代理监听和 UFW 拒绝。DNS A 记录直接指向 `47.237.22.191`，因此需确认 ECS 安全组和证书实际绑定位置。上传到云证书管理产品本身不会在 ECS 上创建 HTTPS listener。

## G. 云控制台只读核对项

先在阿里云控制台检查并回传以下信息，不要先修改规则：① `47.237.22.191` 所属 ECS 安全组是否有 TCP 443 入方向规则、来源范围是什么；② 是否有绑定该公网 IP/域名的 ALB/CLB、云 WAF 或 CDN HTTPS 入口；③ 证书目前只是上传在证书管理里，还是已绑定到实际的 HTTPS listener；④ DNS 记录是否直接解析到 ECS 公网 IP，还是预期应指向负载均衡/CDN。当前观测到 DNS 直接解析为 ECS IP，而 ECS 没有 443 listener；若证书仅在证书管理中，需先确定 TLS 由 ECS Nginx 终止还是由云负载均衡终止，再形成具体部署步骤。

## H. 可直接转发给公司运维的协作文本

**主题：请协助打通 Northstar 受控试运行 HTTPS 入口**

Northstar 已在测试服务器 `47.237.22.191` 部署。`northstar-shell` 当前为 `active (running)`，本机 `http://127.0.0.1:8098/healthz` 返回 `{"ok":true}`。域名 `agent-fat.adorado.top` 已解析到该 IP，但访问 `https://agent-fat.adorado.top/healthz` 时，TCP 443 连接被拒绝。

服务器当前没有 80/443 监听；Nginx、Caddy 均未运行，UFW 为 inactive。应用只监听本机 `127.0.0.1:8098`，请勿将 8098 或看板后端 8095 直接暴露到公网。

请协助确认并配置适合该测试环境的 HTTPS 入口：

- 检查云安全组/云防火墙是否允许测试所需来源访问 TCP 443，并确认域名实际应指向 ECS，还是负载均衡、WAF 等云入口。
- 确认 HTTPS 证书已绑定到 `agent-fat.adorado.top` 对应的实际 listener；仅上传到证书管理平台还不会自动创建入口。
- 将 HTTPS 请求转发到服务器本机 `http://127.0.0.1:8098`，保留正确的 `Host`、`X-Forwarded-Proto` 和客户端地址转发头。
- 为后续受控 T03 验证确认代理支持 SSE 长连接和流式响应。
- 配置完成后请告知入口类型、证书绑定位置及变更结果；我们会验证 `https://agent-fat.adorado.top/healthz` 返回 HTTP 200 和 `{"ok":true}`。

Google OAuth 回调 URI 已配置为 `https://agent-fat.adorado.top/api/auth/google/callback`。本次目标是受控试运行，不代表一期验收完成或正式放量；入口验证前不会发起生成调用。

## I. 在 ECS 安装 Nginx 并配置 HTTPS 反向代理

本地已核验证书：SAN 覆盖 `agent-fat.adorado.top`，有效期截至 2027-02-03，PEM 含 4 张证书，证书与私钥公钥匹配；私钥本地权限已改为 `600`，证书文件已加入 `.gitignore`。Nginx 配置文件为[`northstar-agent-fat.nginx.conf`](../../release-artifacts/northstar-agent-fat.nginx.conf)，SHA-256 `21663e359cdb356e7ffb2ef99e841db74a5781500cb1f7009698e99a99198e65`。配置将 HTTP 80 重定向到 HTTPS 443，Nginx 反代至 `127.0.0.1:8098`，保留 SSE 流式响应；不公开 8098/8095。

在 Mac 本机终端逐条执行第 129–131 行，将两个证书文件和 Nginx 配置上传到服务器；私钥只通过 SCP 传输，不打开、打印或粘贴其内容：

```bash
scp -P 22 /Users/mmdn/Downloads/pt项目/adorado.top.key tongjiawan@47.237.22.191:/home/tongjiawan/adorado.top.key
scp -P 22 /Users/mmdn/Downloads/pt项目/adorado.top.pem tongjiawan@47.237.22.191:/home/tongjiawan/adorado.top.pem
scp -P 22 /Users/mmdn/Downloads/pt项目/release-artifacts/northstar-agent-fat.nginx.conf tongjiawan@47.237.22.191:/tmp/northstar-agent-fat.nginx.conf
```

上传后先在 SSH 终端逐条执行第 137–141 行。公钥摘要两行都必须是 `74bc10a45ae884b06670fc1a74ef536a076747fd690c6e36a5d1d564bbb9f485`，域名校验须显示匹配；配置文件摘要必须匹配上文。任一不符即停止，不安装 Nginx：

```bash
sudo openssl x509 -in /home/tongjiawan/adorado.top.pem -noout -checkhost agent-fat.adorado.top
sudo openssl x509 -in /home/tongjiawan/adorado.top.pem -noout -dates -ext subjectAltName
sudo openssl x509 -in /home/tongjiawan/adorado.top.pem -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum
sudo openssl pkey -in /home/tongjiawan/adorado.top.key -pubout -outform DER 2>/dev/null | sha256sum
sha256sum /tmp/northstar-agent-fat.nginx.conf
```

证书核对通过后，在 SSH 终端逐条执行第 147–156 行。先完成 Nginx 配置与本机验证；之后再让运维开放云侧 TCP 80/443 做公网验证，并保持 8098/8095 不对公网开放：

```bash
sudo apt update
sudo apt install -y nginx
sudo install -d -o root -g root -m 0700 /etc/nginx/ssl
sudo install -o root -g root -m 0644 /home/tongjiawan/adorado.top.pem /etc/nginx/ssl/adorado.top.pem
sudo install -o root -g root -m 0600 /home/tongjiawan/adorado.top.key /etc/nginx/ssl/adorado.top.key
sudo install -o root -g root -m 0644 /tmp/northstar-agent-fat.nginx.conf /etc/nginx/sites-available/agent-fat.adorado.top
sudo ln -sfn /etc/nginx/sites-available/agent-fat.adorado.top /etc/nginx/sites-enabled/agent-fat.adorado.top
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

服务器回传：`nginx -t` 成功，`systemctl enable --now nginx` 与 reload 均已执行。本机 TLS/SNI health 返回 `ok:true`；HTTP 80 返回 301 并跳转至 `https://agent-fat.adorado.top/healthz`；域名 HTTPS health 返回 `ok:true`。监听结果显示 Nginx 在 `0.0.0.0:80/443`，Northstar 和 analytics 仍分别只在 `127.0.0.1:8098/8095` 监听。公网 HTTPS 路由核验通过。

```bash
curl -fsS --resolve agent-fat.adorado.top:443:127.0.0.1 https://agent-fat.adorado.top/healthz
curl -sSI --resolve agent-fat.adorado.top:80:127.0.0.1 http://agent-fat.adorado.top/healthz
curl -fsS https://agent-fat.adorado.top/healthz
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :8098 or sport = :8095 )'
```

验证通过后再执行第 171 行清除服务器用户目录中的临时私钥/证书副本与临时配置（已安装的 root-owned 证书和 Nginx 配置不会删除）：

```bash
sudo rm -f /home/tongjiawan/adorado.top.key /home/tongjiawan/adorado.top.pem /tmp/northstar-agent-fat.nginx.conf
```

## J. Google 登录与 PostgreSQL 会话持久化

先按第 171 行删除服务器家目录中的临时私钥/证书副本与配置；正式文件仍保留在 `/etc/nginx/ssl/` 和 `/etc/nginx/sites-available/`。然后在你自己的浏览器打开 `https://agent-fat.adorado.top/`，使用 Google 登录并完成授权。成功条件：浏览器返回该 HTTPS 域名下的 Northstar 应用并显示已登录。此阶段只验证登录，不提交生成请求。若失败，只回传错误页面文字和时间；不要复制包含 `code`、`state`、cookie 或 token 的地址/内容。

登录成功后，在 SSH 终端执行第 181 行查看只含计数的数据库结果；预期 `users` 与 `google_identities` 至少为 1，`active_sessions` 至少为 1，不会输出邮箱或会话 token：

```bash
sudo -u postgres psql -d northstar -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM google_identities) AS google_identities, (SELECT count(*) FROM sessions WHERE expires_at > now()) AS active_sessions;"
```

服务器回传计数：`users=2`、`google_identities=2`、`active_sessions=2`，均满足至少 1 条的预期。`google_identities` 以 Google issuer/subject 为唯一键，计数 2 表示库里有两个不同 Google 身份；若本次只预期一个试运行账号，先确认第二个身份是否为预期测试账户。随后已执行第 187–189 行：shell 重启后 `active`，HTTPS health 返回 `ok:true`。最后还需在刚才登录的浏览器刷新页面，确认仍保持登录；服务健康不等同于浏览器会话恢复。

浏览器刷新确认后，数据库会话跨应用重启验证可记为通过；该证据仅覆盖本机 PostgreSQL 会话持久化，不代表跨主机/故障恢复验收：

```bash
sudo systemctl restart northstar-shell
sudo systemctl is-active northstar-shell
curl -fsS https://agent-fat.adorado.top/healthz
```

Google 登录和会话持久化通过后，才进行一次受控 T03 调用。保持当前每用户/全局并发与速率限制；只提交一次，不自动重试。若请求超时或结果状态不明确，先查运行记录并核对余额，不要重复发起。该单次体验不代表 T03 完整验收或一期正式放量。
