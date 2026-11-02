# 2026-10-30 candidate34-r13 发布门禁

**结论：本地完整 Agent 图生视频真实链通过，r13 确切归档可复现并通过 Linux/amd64 闭包；尚未完成目标机基线、可执行 unit 与部署回滚，状态仍为 `DRAFT_NOT_FOR_DEPLOYMENT`，不得称为线上新包。** 工作树有大量其他未提交变动，只允许使用下面绑定的不可变归档，不从脏目录直接部署。

| 环节 | 本次证据与边界 |
|---|---|
| 首次真实图生视频 | [i2v-r1](F1-live-agent-20261029-i2v-r1.json)：上传任务已提交并取得 task ID，但本地 Run 因上传查询失败、工具预算耗尽而失败；没有视频生成 operation。随后以相同 task ID 做匿名 GET，只读确认资产已成功，未重传。 |
| 修复 | `shell/tasks/media-input-asset.cjs` 对已知 task ID 做限次 GET-only 恢复，持久化资产成功后才允许视频提交；未知提交保持人工核对，不自动重发 POST。 |
| 第二次真实图生视频 | [i2v-r2](F1-live-agent-20261029-i2v-r2.json)：Run `ec5acbc4-d9f4-433c-90a4-42625048e63f` 成功；资产和视频 external operation 均 succeeded；119,992 字节输入 SHA `3730be1b01a4450f902ee6ccbbd33006f3dcb5235189c349bb4e0a5d79daa550`；托管 MP4 2,403,785 字节 SHA `35373ee13f2b7eefd949cb763a1ae07e47c82a3016e69ef007ad0ae6feb6f6f7` 与下载一致；历史重开有托管 URL，匿名读取 401。无传输 mock；临时加密 BYOK 库已移除；服务日志凭据泄漏检查为 false。实际美元消耗未知，不能从 Run 预算推出金额。 |
| 冻结来源 | `scripts/package-northstar-candidate34-r13-draft.py --check`、独立 audit、活动草案绑定测试均 PASS；归档 `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r13-draft.tar.gz` SHA-256 `f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993`，385 成员、184 源码绑定；sources JSON SHA `81b400c1b58f1a24d9feec6cf1365a0fc33aa34280bf6bc471005bdc0d7a1420`。 |
| 本地与确切归档测试 | Node 关键回归 22/22、Python 21/21；归档在隔离 Linux/amd64 Node v22.23.4 完整 `npm ci --ignore-scripts` 后 portable closure PASS：472 生产包、30,091 文件、Arborist 8.0.5。确切归档内图生视频上传顺序 4/4 PASS；Linux Python 3.12 编译和 patched engine 导入 PASS。此项不代表目标机启动或真实目标环境。 |
| 完整默认回归 | 220 套件、214 通过、6 失败；失败为 `f1-candidate34-draft-artifact`、`t16-candidate28/30/31/32`、`t17-candidate-lockfile-provenance` 的历史候选/旧来源绑定（其中 candidate31 超时）。当前活动 r13 绑定测试单独 PASS。保留失败，不记作全绿。 |
| 线上旧版 | 2026-10-30 10:51 JST 公网 `/healthz` 返回 `ok:true`、版本 `1.0.0`；只证实旧服务健康。已有 SSH 账号的 BatchMode 只读查询被 `Permission denied (publickey,password)` 拒绝，因此未取得 systemd 入口、当前 release 路径、备份和回滚证据。 |

**发布所需外部回传：**运维在目标机只读执行 `systemctl is-active northstar-shell`、`systemctl cat northstar-shell`、`systemctl show northstar-shell -p FragmentPath -p ExecStart -p WorkingDirectory -p EnvironmentFiles --no-pager`、`readlink -f /opt/northstar/current`（若存在）、`node --version`、`python3 --version`、`uname -m`、`curl -fsS http://127.0.0.1:8098/healthz`，并提供当前可回滚 release 路径、unit 原件及哈希。脱敏环境变量值、Key、cookie 和数据库内容不要回传。收到基线后生成匹配目标路径的最终 unit/执行清单、校验安装和回滚，再受控切换并验证线上同版 Agent 入口、普通聊天/模型切换、媒体执行、托管结果与历史。

**已知文案缺陷：**r13 草案 unit 的 Description 继承旧 `Candidate 34 r4` 字样，且明确标记 `DRAFT ONLY - NOT FOR DEPLOYMENT`；不能直接安装。下一发布修订需纠正并重新冻结，不可原地覆盖 r13 文件。
