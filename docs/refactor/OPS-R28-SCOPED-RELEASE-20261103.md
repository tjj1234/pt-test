# 2026-11-03 r28 有界版本：运维交付与切换
此包替代 r24 review ZIP；不是全量重构完成声明。交付归档 SHA256：`e4aa5e2042b831267acc6ce7ad620b6d8ba36d8e4d5163542ba6260c78e0d501`。归档名称保留 draft 用于历史追溯；发布决定以本文件和随包 RELEASE-STATUS.json 为准。目标机尚未部署验收，不把本地替身称为 PT 真实生成。

| 本期范围 | 行为及边界 |
|---|---|
| 对话、模型切换、推理强度 | 持久 Run、原生 SDK、历史恢复；仅 DSH 已配置模型可用于对话 |
| CSV→Excel | 上传、分析、文件导出与历史访问 |
| 图片理解 | 当前上传校验、租户隔离、损坏拒绝、重启不重复注入 |
| Context | R4 独立反例与 HTTP/SDK、重启链本地验收；不承诺真实 PT 摘要质量或成本 |
| 长期记忆、资料检索引用、Skill 发布 | 本地 HTTP、存储、原生 SDK 与浏览器链验证；生产权限仍由实际账号决定 |
| 文生图、图生图 | Seedream 5.0，标准 `/v1/images/generations`，每次提交需用户确认 |
| 文生视频 | Wan 2.7 T2V，标准 `/v1/videos`，每次提交需用户确认 |
| 明确排除 | 所有 Seedance、图生视频、音视频理解、PDF/OCR、联网审批、真实账单、新 OAuth 文档 |

标准接口结果 URL 按 PT 声明假设永久有效，未做长期有效性验证，不作为本期上线阻断。默认无需自建 CDN 或预配置 CDN 域名；仅处理服务端 PT 执行器返回的 HTTPS 地址，公网 IPv4 DNS 固定、拒绝私网/跳转、流式限额、文件类型校验，本地保存后使用受账号权限保护的历史地址。若 PT 资源仅支持 IPv6、下载失败或结果未知，保留远端状态，禁止自动重投。一次确认最多一笔外部提交、零自动重试；无金额硬上限，费用按 PT 实际计费。停止/超时不代表上游停止或停止计费。

默认发布策略仅审定上述两款标准模型的声明和适配；必须每次用实际账号 Key 强制刷新目录并确认权限。没有伪造 runtime verification；未验证组合不进入媒体 AUTO。用户在媒体确认面板手动选择对应模型。若账号无 Wan 权限，视频不能视作可用，须由 PT 开通或另行审定替代模型。不能用 Seedance 替代。

## 切换前检查与备份
已知线上仍是 `/opt/northstar/releases/controlled-trial-20261030-candidate-34-r14`，服务 `northstar-shell`；Node24.22.0 / Python3.14.4 为运维回执。本地 Linux 验证使用 Node22/Python3.11，不宣称完全相同环境。先核对当前路径和版本，不覆盖旧目录。
1. 解开交付 ZIP，在该目录运行 `sha256sum -c handoff-checksums.sha256`，再运行归档原生 `.sha256` 清单；全部必须 OK。
2. 保留旧 unit、旧 release、运行时文件及 secrets。确认无在途任务后停服务；对实际 PostgreSQL 做原生一致性备份并验证可读取/隔离恢复。另备份 DSH home（含 settings/profile）、runtime、db、master key，备份仅存受控目录，禁止上传或回传内容。当前未收到可恢复备份证据，不能跳过这一步。
3. 新建独立目录解包，低权限安装锁定依赖，校验闭包。不要复制开发机 node_modules，不要运行 npm install，不覆盖 lockfile。

```bash
set -euo pipefail
PT_R28=/opt/northstar/releases/controlled-trial-20261103-candidate-34-r28-draft
sudo test ! -e "$PT_R28"
sudo mkdir -m 0755 "$PT_R28"
sudo tar -xzf northstar-controlled-trial-20261103-candidate-34-r28-draft.tar.gz -C "$PT_R28"
sudo chown -R root:root "$PT_R28"
sudo chown northstar:northstar "$PT_R28/shell"
cd "$PT_R28/shell"
sudo -u northstar -H npm ci --no-audit --no-fund
sudo -u northstar /usr/local/bin/node northstar-dependency-closure.cjs --check dependency-closure-manifest.json
sudo -u northstar /usr/local/bin/node -e 'const p=require("node-pty");let ok=false;const x=p.spawn("/bin/sh",["-c","printf PTY_OK"],{cols:80,rows:24});x.onData(d=>{if(d.includes("PTY_OK"))ok=true});x.onExit(e=>{if(e.exitCode===0&&ok)console.log("PTY_RUNTIME_PASS");else process.exitCode=1});setTimeout(()=>{if(!ok)process.exit(1)},5000).unref()'
sudo chown -R root:root "$PT_R28/shell"
```

4. 受信 settings 升级器只支持已回传的 r14 精确基线，先 inspect；服务停止且完整备份验证后才 apply。它不停止服务、不备份数据库、不修改 unit。任何漂移应停止升级，不覆盖运维配置。将随包 helper 放到运维受控可读路径，以下以 `/tmp/northstar-r26-settings-transition.cjs` 为例：

```bash
PT_R14=/opt/northstar/releases/controlled-trial-20261030-candidate-34-r14
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env /tmp/northstar-r26-settings-transition.cjs inspect "$PT_R28" "$PT_R14"
# 以下仅在已停服务且 PG/DSH/runtime/secrets 备份验证后执行。
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env /tmp/northstar-r26-settings-transition.cjs apply "$PT_R28" "$PT_R14" --offline-and-backup-confirmed
```

要求 `TRANSITION_COMPLETE`。新模板哈希 `5df264dce03602cc49b201f19e80ccf6b72e8d6d67ea29740240a79bd46fdce9`。helper 通过 manifest 及 settings 哈希拒绝错误基线；失败记录阶段与事务标识，不反复盲重启。新版本启动会自动按顺序应用缺失 SQL 迁移；不得手工改 schema_migrations，预期共29个迁移文件，实际以确切归档清单为准。

5. 备份现用 unit 后，安装随包 `northstar-shell-r28-scoped.service` 为 `/etc/systemd/system/northstar-shell.service`，执行 `systemd-analyze verify`、`systemctl daemon-reload`、`systemctl start northstar-shell`。只切换 shell，不更改 analytics 服务。limits 文件在主 env 后加载，默认 `PT_MEDIA_GENERATION=standard3` 与单次媒体确认开启。若旧环境遗留 `PT_MEDIA_REVIEW_FILE`，先核查其有效性；无自定义审定需求时从运维环境中移除该旧项，使用本期模型事实策略。不要把服务环境文件内容发出来。
6. 必须核对 MainPID、WorkingDirectory、实际 ExecStart、服务日志、Shell `/healthz` 与现有 analytics 健康端点、真实登录后的核心链；验证模型目录中没有 Seedance。两用户分别验证对话切换推理强度、图片理解、CSV 导出下载与刷新重开。媒体选择对应模型，确认一次，检查结果、历史和无重复提交。真实生成须由获授权账号操作，记录模型、Run、状态和错误码，不记录 Key、Cookie 或签名 URL。401=Key失效，402=余额不足，403=模型下架/无权限。

## 回滚
任一启动/健康/核心链失败，先停止新服务，保留日志、Run 与未知远端操作。恢复已备份的旧 unit、DSH settings 和整个 profile，以及旧 release 路径；daemon-reload 后启动旧服务并核对两个健康端点和登录对话。数据库迁移不会随 unit 自动撤销；本地已验证旧仓储可读取升级 schema，但这不是全业务回滚保证。需数据库回退时由 DBA 按已验证恢复点操作，禁止自动 DROP 新表或覆盖仍在使用的数据库。禁止对未知媒体任务自动重投。

交付后运维仅回传：校验结果、依赖/PTY退出码、备份可恢复结论、升级结果、迁移 expected/applied/missing/extra、MainPID/WorkingDirectory、健康检查与各验收项结果。不要回传凭据或用户数据。
