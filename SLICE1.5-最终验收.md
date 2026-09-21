# Slice 1.5 最终验收：锁基线 + 真实 DB smoke

> 两阶段均完成，按约定暂停，未进入 Slice 2（DSH Adapter/Workspace/Tool Registry）。

---

## 一、提交（本地，未推送）

| commit | 说明 |
|---|---|
| `3b7587a` | test: add real-DB transaction/idempotency/reuse smoke + Slice 1.5 acceptance（**HEAD**） |
| `cd83ba0` | fix: close Slice 1.5 tracked source and migration baseline（锁基线） |
| `f4a5206` | chore: reconcile conversation and migration storage seams（Slice 1.5 A–D） |
| `d8c5ece` | refactor: add storage contract thin shim without SQL changes（Slice 1） |
| `4589d61` | test: add Slice 0 regression baseline and mock DSH fixture（Slice 0） |
| `e0ebe47` | security(P1+P2+NEW-1): CSRF/上传隔离/XSS+CSR/DSH取消协议/异常脱敏/粘贴图片/CI/X Ads补全 |
| `31a5c58` | security(P0): 默认密码随机化/secret环境变量化/URL去token/Cookie Secure/端口一致性 |

**基线（唯一答案）**：
- `origin/main` = `83756af`
- `local HEAD` = `3b7587a`
- HEAD 祖先链（origin/main 之上 7 笔未推送）：`31a5c58` → `e0ebe47` → `4589d61` → `d8c5ece` → `f4a5206` → `cd83ba0` → `3b7587a`；`31a5c58`/`e0ebe47` 两笔安全修复**均在**当前祖先链内。
- working tree：clean（仅 3 个未跟踪报告/文档：`SLICE0-报告.md`、`SLICE1.5-报告.md`、`conv/落地说明.md`）。

## 二、Phase 1 · 锁基线 ✅

1. **conv/ 权威源码纳入 Git**：20 个权威文件（server-v5/tenant-v7/conversations-v2/memory/persistent-runner/panel-share/db-pg/dsh-settings/app-v7/index-v4/key-drawer-v3/register-v3/login-v2/styles-v4 + 004-006 迁移 + run-local-v12.cjs + PG切换说明.md）。
2. **conversations 唯一权威关系确认**：`conv/conversations-v2.cjs` 是唯一实现；`shell/conversations.cjs` 与 `conv/conversations.cjs` 转发指向它（seam-test 断言二者 `require` 回来同一函数）。
3. **shell/ 与权威实现对齐**：发现 tracked `shell/server.cjs` 等在 e0ebe47 已通过手动 object-store 提交成 v5 权威版，工作树此前是陈旧的；本次同步让工作树与 HEAD 一致，`git status` 只剩 3 个报告/文档类未跟踪文件。
4. **.gitignore 修复**：应用 `/db/` 锚定（不误伤 analytics/backend/db 迁移），排除 runtime 目录 + conv 旧版本/测试脚本（含 3 个硬编码 PT key 的 `_test-*.cjs`）。
5. **不依赖未跟踪文件/构建产物**：conv/ 与 shell/ 均入库；`shell/db.cjs → ../conv/db-pg.cjs`、`shell/conversations.cjs → ../conv/conversations-v2.cjs` 等交叉引用在仓库结构内可解析。

## 三、Phase 2 · 真实 DB smoke ✅

- 停掉 shell + analytics 释放 PGlite/WASM 内存后，`seam-smoke.mjs` 从「Array buffer allocation failed」变为 **14/14 通过**——确认此前失败确系并发 PGlite 实例挤爆沙箱内存，非代码问题。
- 覆盖：adapter 三方法 / 注册 / 登录 / 对话 create·get·list / 跨用户隔离 / 记忆 / **migrate 幂等重跑** / **事务 commit（数据可见）** / **事务 rollback（数据不可见）** / **rollback 后连接复用** / key 加密（只存末4位）/ key 解密。
- 修一个测试自身的 bug：register 密码需 ≥8 位（auth.cjs:100），原用 `"p1"` 导致 VALIDATION 失败，改用 `"password1"`。

## 四、测试全绿

| 套件 | 结果 |
|---|---|
| `tests/regression/regression-test.mjs` | 20/20 |
| `tests/regression/seam-test.mjs` | 19/19 |
| `tests/regression/seam-smoke.mjs` | 14/14（真实 PGlite DB） |

## 五、服务已重启并验证

- shell 8099：healthz **200**，登录 admin/TestPass123 **200**（返回 token）。
- analytics 8095：进程运行中（start.cjs PID 17784）。
- 重启过程中清理了 job_kill 未杀干净的孤儿进程（server.cjs + run-local-v12.cjs + DSH bin.js 各 1 个，Windows 杀父不杀孙的典型问题）。

## 六、硬编码凭证清理（验收收口动作 ①）✅

- 两把泄露的 PowerTokens 测试 key 已从磁盘全部移除：
  - `pCA8XHHT…IQi2`：5 个文件（`conv/_test-model-stop.cjs`、`conv/_test-recovery.cjs`、`conv/_test-real-context.cjs`、`_pg-test/test-branch.cjs`、`_pg-test/test-56911.cjs`）。
  - `LjgLG4hfxje…Z1IV`：10 个文件（`conv/_test-stream/steps/real2/persistent/panel-share/migration/memory-real.cjs`、`conv/_debug-branch.cjs`、`conv/_test-real.cjs`、`conv/test-v11.cjs`，后 2 个是 `process.env.PT_TEST_KEY || "硬编码"` 的 fallback 写法）。
- 统一改为从环境变量 `PT_TEST_API_KEY` 读取；未设置时明确报错并 `process.exit(2)`（不再静默降级到硬编码值）。
- `git grep` 验证：tracked 树无 `pCA8XHHT`、无 `LjgLG4hfxje`、无长 PT token 形态；磁盘全量 grep 亦 0 残留。
- ⚠️ **仍建议轮换/撤销这两个 key**：它们已在本会话多次出现，且是真实测试用 key（`IQi2` 曾被验证可用）。轮换在 PowerTokens 侧执行，不在本仓库能力范围内。

## 七、剩余风险 / 技术债（诚实标注）

1. **`conv/` 旧版本 + 测试脚本未入库**（已 gitignore，key 已从磁盘移除）：`server-v2~v4`、`tenant-v2~v6`、`app-v2~v6`、`_test-*`、`_transform-*`、`run-local-v2~v11` 等非权威文件仍在磁盘但未入库、不影响运行。
2. **DSH_JS 是外部依赖**：`run-local-v12.cjs` 需要 `DSH_JS` 指向 DSH CLI 的 `bin.js`（不在本仓库），干净 clone 需另行准备 DSH 运行环境。
3. **auth.cjs 仍自持连接**（ownsDb=false 已文档化）+ **仓储未事务化**（repoUsesTx 是声明，方法内部仍用外部 db.query）——属后续切片技术债。
4. **未做真正的 `git clone` 全流程验证**（需网络 npm install）：本阶段验证的是「同步后的源码树直跑 + storage 层真实 DB 冒烟」，等价于 clone 后除 npm install 外的完整路径。

## 八、完成条件对照

- [x] conversations 唯一权威（v2）
- [x] 旧 shell/conversations.cjs 不再分叉
- [x] 004–006 唯一迁移入口
- [x] 全新库迁移成功（seam-smoke 14/14）
- [x] migrate 幂等重跑无报错
- [x] auth.db 连接所有权文档 + ownsDb:false
- [x] transaction commit/rollback 有真实 DB 测试
- [x] seam-smoke.mjs 在释放内存后跑通
- [x] PGlite 内存问题确认是环境限制（并发实例），非代码问题
- [x] 回归 20/20 + seam 19/19 + smoke 14/14
- [x] 启动/healthz/登录无回归
