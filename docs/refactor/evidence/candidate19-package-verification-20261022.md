# candidate-19 包验证（2026-10-22）

candidate-19 从已核验 candidate-18 固定归档 `eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37` 生成，保留其 T06 endpoint 任务映射、runner 预算计数修复和 T10 修复，并覆盖当前工作区内 7 个发生变化的归档文件、加入 4 个新增 shell 文件。新包含当前 T12 记忆变更取消活动 Run 的路径、storage/auth/CSV/预算事件变更及 migration 019；迁移数从 19 增至 20。输入是未提交工作区，因此此包只绑定当前快照，不能称为 clean commit release。

| 产物 | SHA-256 | 检查结果 |
|---|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-19.tar.gz` | `b433ec44795c455bcf40a83f8d5ecefd9181d25e0f40fc1e1688d4d65fd0eb1c` | 322 members / 272 files，USTAR header checksums valid，只有普通文件/目录类型 |
| `release-artifacts/northstar-shell-candidate-19.service` | `b9743df3134e20c6154b63ba924f9d9eba982e03e4d85c3e8c85a54a01a7a071` | unit 指向 candidate-19 发布目录 |

`tests/regression/t16-candidate19-ustar-release-test.mjs` 核验 checksum、USTAR 格式、唯一路径、20 个 SQL migration、无 AppleDouble/PAX/GNU、无 `.env`/secrets/node_modules/Git 元数据，并对 server、storage、T12 helper 与预算修复做内容核对；2/2 PASS。T12 取消测试与通用执行取消测试合并为 2/2 PASS；`node --check shell/server.cjs` 与 `git diff --check` PASS。既有记忆 HTTP 刷新测试授权后 1/1 PASS。

部署和模型验证尚未发生。维护者需按新清单核对目标库已应用 migration 000–019 与候选一致；migration 019 是新增项，不符合即停止部署。运行中远端 Run 取消若仅到 `cancelling`，接口会返回 503，直到能确认持久化 `cancelled`；目标多实例环境尚未实测。候选资格链路的目标机放行、一次真实 1/0/0/180 验证、回复与调用计数仍待执行。
