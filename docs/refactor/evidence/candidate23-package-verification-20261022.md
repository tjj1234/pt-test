# candidate-23 包验证（2026-10-22）

candidate-23 由经过核验的 candidate-22 归档增量生成，并将用户指定的聊天限流/并发放宽与 T10 历史产物恢复一并纳入同一候选。

| 产物 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-23.tar.gz` | `30568c8ea3f1c02369342b4338c9f484e64f61441a82491f0b5050c2afa2d4e2` |
| `release-artifacts/northstar-shell-candidate-23.service` | `12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072` |

归档为323个USTAR成员、20个SQL migration；candidate regression 逐头核验USTAR checksum与类型、成员唯一性、安全路径、无AppleDouble/禁入路径，并确认 server、scheduler、UI、task-router 与工作区字节一致。task-router 对缺失的 endpoint 兼容证据 fail closed。限额文件 `shell/northstar-limits.conf` 固定 `PT_RATE_CHAT_PER_MIN=35`、`PT_RUNS_PER_USER=4`、`PT_RUNS_GLOBAL=16`；systemd unit 在共享 `/etc/northstar/northstar.env` 后加载它，使候选值覆盖旧环境配置。回滚旧 unit 会停止读取候选文件。

行为回归：`chat-rate-limit-by-account-test.mjs` 与 `session-scheduler-test.mjs` **15/15 PASS**；HTTP/PGlite artifact history persistence **1/1 PASS**，UI artifact history restoration **62/62 PASS**；task-router budget/compatibility **8/8 PASS**。本次聚焦运行合计 **31/31 TAP PASS**。`t16-candidate19-ustar-release-test.mjs` 对 candidate-19 至 candidate-23 历史与当前候选的 checksum/内容断言 **6/6 PASS**。这些是本地证据，不证明目标 Linux/systemd 已运行。

T10 本地修复将成功 Run 经规范化的 artifact 列表持久到 assistant 历史；重开会话时 UI 根据安全相对路径和支持扩展名重新生成同源预览 URL，并清除上一个会话的 artifact 状态。失败/停止 Run 的 artifact 历史持久化、目标主机实际产物文件/下载、浏览器端真实文件预览仍未覆盖，故 T10/AC11–12 不标整包完成。

按用户指定的限流是每个已认证账号每分钟35次，Run并发为每账号4、每 shell 服务进程16。当前调度器配额是进程内的；它不构成多服务实例间共享的数据库全局上限。模型额度仍由每个 Run 原有预算规则限制。维护者清单为 `docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-23.md`；candidate-23 尚未部署，线上限流值、线上模型资格和一次真实模型回复均未观测。
