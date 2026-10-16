# T02 · 可信身份绑定撤销旧 Session 独立审查

日期：2026-10-16。审查者：架构子 Agent，未参与本次 `bindIdentity` 修改。结论：**限定事务语义 PASS**：绑定与按 user_id 撤销现存 Session 同事务，失败回滚，不误删其他用户会话。未修改实现或实现方测试，未提交。

只读核查 `shell/auth-google.cjs:84` 起的可信绑定实现，顺序为校验可信批准参数→事务内确认用户存在→插入 Google identity→参数化 `DELETE FROM sessions WHERE user_id=$1`→返回绑定成功。删除不是在事务外执行；即使 Session 撤销失败，也不会留下已绑定但旧 Cookie 仍有效的部分成功。

新增独立检查件：`tests/regression/google-binding-review-test.mjs`，使用真实隔离 PGlite 与既有 auth.getSession，全部数据为合成账号。

| 独立反例 | 实际结果 |
|---|---|
| 同一旧用户持有两个有效密码 Session，可信绑定后继续用两枚旧 token | 两枚 getSession 均返回 null，sessions 中目标 user_id 为 0 |
| 用户 B 同时持有有效 Session | A 绑定不影响 B，B 原 token 仍返回正确身份 |
| 绑定 A 时已有对话和租户资产 | 对话正文和原 tenant_id 保留；不新建替代身份 |
| 相同 Google subject 再试绑定 B，触发唯一冲突 | 事务失败，B 原 Session 不被误撤销 |
| 在真实事务中对 DELETE 注入明确失败，INSERT 已先执行 | 整体拒绝；Google identity INSERT 回滚，旧 Session 仍有效，没有半绑定状态 |

命令：`node --test tests/regression/google-binding-review-test.mjs tests/regression/google-auth-test.mjs`。结果 **18 tests／18 pass／0 fail／0 skip**；其中新增独立 2 项通过、原实现 16 项通过。未使用真实 Google 或 PT；原实现测试的 JWT／JWKS 为受控签名样本，不是线上 Google 验收。

边界：本方法只提供给可信迁移调用者，不应暴露为接收客户端 userId 的接口；批准主体真实性由服务层保障。撤销目标是绑定事务时已存在的全部 Session，未证明滚动发布中旧版密码登录进程不再签发新的 token；部署前须保证旧密码入口／旧进程已停止接收登录，不能把 DELETE 当作全系统不可再签发密码 Session 的永久约束。真实 PG、多实例并发、迁移审批界面和真实 Google 后续登录仍未验证。

本结论补充并收紧 `T02-integration-review.md` 的维护提示：使用本次受控 bindIdentity 绑定时，旧 Session 已原子撤销，无须依赖操作者另行手动删除；直接改表或历史脚本绕过该方法不在保证范围内。
