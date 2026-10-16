# T01 · Google-only 授权策略调整后的独立复核

日期：2026-10-16。**本组 PASS；原T01“旧密码session保留”结论作废，用户／资产保留、事务和错误边界结论仍有效且已重跑。** 本次审查未修改产品实现、实施者测试或T01实施证据。新增独立测试 `tests/regression/storage-google-policy-review-test.mjs`；审查者未参与Storage、迁移原子性与PG错误边界实现。审查者曾参与Google身份模块，本次不把底层OIDC自身称为再次独立验收，验证的是存储升级与Google签发链路的真实组合。

## 策略与测试口径

最新T01升级测试用底层auth.register/login重建旧库夹具合理：测试必须能产生旧密码用户及session。产品退役密码登录约束位于HTTP／UI入口，不要求删除内部仓储方法，不能因为测试仍调用它就判定产品仍开放密码登录。

原先测试在插入受控Google身份后继续调用`repositories.auth.login(username,password)`，可证明**底层session存储格式、读取和重启持久性**，不能单凭它声称新session是Google OIDC callback签发。已向主Agent反馈，主Agent负责修正实施方断言／证据口径。本独立测试不修改该测试，而是补真正的受控OIDC链路。

迁移012实际按“user是否已有google_identities映射”撤销session：未绑定的旧session删除，已有绑定的session保留；它没有逐session provider来源列，不能描述成能区分并删除每一条历史密码来源session。Google-only产品入口关闭、旧用户绑定审批和本地会话生命周期属于T02集成策略，不能以Storage内部API调用代替HTTP验收。

## 新增独立真实磁盘路径

1. 使用旧`storage/migrations`在随机临时目录建真实磁盘PGlite，通过旧密码仓储API仅构造升级前用户与session；创建归档对话、普通记忆及合成AES-GCM加密Key，保存users/conversations/user_memory/api_keys全行快照。
2. 关闭数据库，以完整默认迁移源重开：旧token的auth.getSession返回null，sessions=0，旧资产逐行不变。
3. 可信测试迁移绑定已存在的旧userId；调用**实际Google模块begin与callback**，以jose真实RS256签名／验签、受控JWKS／token端点响应完成code/state/nonce/PKCE链路。升级后不再调用底层password login。
4. 新token可由现auth.getSession解析，仍是原userId／tenantId；旧token不会因为随后绑定而复活。数据库只存新token哈希。
5. 再次真正close／重开磁盘库：Google callback签发的新session及identity仍在，旧token仍无效；用户、归档消息、记忆、加密Key全行保持，原Key可解密；schema_migrations名称与applied_at保持，不重复执行升级删除新session。

无真实Google/PT请求、无HTTP listener／浏览器、不读.env，JWT/Key/数据均为合成夹具。PGlite使用真实声明依赖，无mock数据库。检测到显式PT_PG环境直接失败，避免误触外部库。临时目录与master key结束清理；raw-0600警告仅旧密钥模块在测试环境的说明，不升级为生产密钥托管验收。B14未配置仅表示未验analytics签发。

## 本轮命令与结果

```bash
node --test tests/regression/storage-google-policy-review-test.mjs tests/regression/storage-upgrade-test.mjs tests/regression/storage-review-test.mjs tests/regression/db-failclosed-test.mjs
```

**10 tests／10 PASS／0 FAIL，exit 0。** 新增磁盘Google组合1项、旧Storage升级2项、独立Storage错误边界4项、既有fail-closed3项。未修改独立错误边界测试。

| 原T01结论 | 本次状态 |
|---|---|
| 旧密码session升级后仍原样有效 | **作废**，已按T02授权策略改为未绑定旧session撤销；本轮实证旧token不能续用 |
| users／对话／归档／记忆／加密Key保留 | **仍有效，已独立重跑**；新增磁盘夹具也逐行核对 |
| 绑定后底层session可跨重启 | **仍有效但限存储格式证据**，不能把auth.login称Google签发 |
| 真正Google callback签发session跨重启 | **本轮新增受控集成证据通过**，未代表真实Google授权或HTTP cookie通过 |
| 唯一默认迁移源、幂等、close去重 | **本轮既有测试重跑通过**；当前完整迁移文件数量按实际目录动态核对，不沿用旧11文件数字 |
| SQL与marker原子回滚、显式PG无fallback、SR01/SR02脱敏修复 | **本轮重跑仍通过**；PG部分仍只是fake driver错误边界 |

真实PostgreSQL、迁移并发锁与备份恢复、真实Google、生产HTTPS Cookie、Web旧密码路由退出、完整账号禁用／撤销、BYOK与workspace初始化不由本组放行。T02整体状态必须继续引用对应HTTP/UI与真实外部验收证据，不能因本次Storage PASS自动标完成。
