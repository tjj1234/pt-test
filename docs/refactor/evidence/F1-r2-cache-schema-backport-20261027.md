# F1 r2 cache schema backport candidate — 2026-10-27

结论：现场根因已命中。运维确认探针 SHA 正确，运行目录 `/var/lib/northstar/runtime` 的 6 个文件均 envelopeValid，各 80 条、共 480 条 rich records 全部缺 `ptEndpointTasks`，其他已查字段错型为 0。冻结 r2 cache reader 仅校验 envelope；capabilities 在旧 record 进入 `mergeSnapshot → applyLocalUpdates → eligibility` 后直接读取 `model.ptEndpointTasks.value`（`shell/models/capabilities.cjs:82`），产生 TypeError，server 将其降级为静态 24 项目录。新鲜缓存也会局部资格重算；过期缓存即使成功拉取新目录，仍先处理旧 records，因此不能自行恢复。本候选是离线验证通过的单文件 backport，尚未构建或部署。

| 冻结输入/输出 | SHA-256 |
|---|---|
| candidate-33 draft r2 archive | `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77` |
| r2 `shell/models/catalog-cache.cjs` 原字节 | `05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a` |
| backport 后 `shell/models/catalog-cache.cjs` | `9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e` |
| `candidate33-r5-cache-schema.patch` | `1464d66102f66bb8f66598142a7180d4e7d87c3fc1e20b17f3693ded7d8cbdb4` |

归档 overlay 仅允许 `shell/models/catalog-cache.cjs`。补丁复用当前该完整模块的严格 capability schema 校验、派生 eligibility 重算、无跟随普通文件读取、inode/size/mtime/ctime race 检查、独占临时文件、原始无效字节 SHA 命名备份、备份校验与失败拒绝覆盖；读到缺字段的旧 rich cache 直接视作不可用，不用猜测补字段或继承旧权限。成功 fetch 用新目录事实恢复记录，runtime verification 仍未知；fetch 失败则 availability unknown，fallback 仅展示，不授予 permission/AUTO。原无效文件在首次替换前精确备份为 `.invalid-<sha256>.bak`，0600；既有备份不匹配或无法保存时拒绝覆盖。旧归档、checksum、产品当前源码和 Gemini 文件均未修改；依赖、DB schema/migrations、DSH profile/runner、provider transport、付费生成调用均不变。

专项验证：`node --test tests/regression/f1-r2-cache-schema-backport-test.mjs`，3/3 PASS。测试先校验冻结 archive 和原模块 SHA，从归档隔离取精确 model-catalog/capabilities/cache 三文件；原版 fresh/stale 80 条缺字段均复现 TypeError；补丁 `--fuzz=0` 应用后校验目标 SHA，并确认 catalog/capabilities 字节不变。六组 fresh/stale 成功/失败 fixture 共 480 条验证精确原字节备份及 0600、失败未知不授权、成功仅恢复新目录事实且 verified/AUTO 仍 false；另验备份冲突拒绝覆盖、正常 r2 cache 无 fetch 且能力 revision 不退化、symlink 拒绝且目标字节不变。使用显式本地 fetch fixture，并阻断全局 fetch；无 Key、真实网络、PT 或数据库调用。

剩余真实验证：由主 Agent 冻结并审计新候选、校验唯一 overlay 与安装基线、独立回归和回滚材料后，按用户授权执行目标机部署。目标机还须核对六个原缓存 SHA 对应备份和权限、确认旧缓存停止触发 TypeError、新目录实际 fetch/availability/permission、账户 scope 隔离与未验证模型 fail-closed，以及服务健康和重启后读取。离线成功不代表目标部署已完成，也不证明 Agent 实际调用/完整 F1 媒体链路验收。
