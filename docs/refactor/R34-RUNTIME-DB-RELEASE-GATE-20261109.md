# R34运行账号数据库发布门禁（2026-11-09）
结论：已新增只读检查工具与真实 PostgreSQL 16 隔离测试。它补齐“管理员迁移成功不代表应用可用”的检查缺口，但尚未接入新的正式部署脚本、尚未核验生产根因，也不代表R34已可发布。既有“暂不上线”指令继续有效。

## 实现与边界
工具 `scripts/northstar-runtime-db-gate.cjs` 复用现有 db-pg 连接层，只接受显式 PostgreSQL 配置及预期角色、数据库。它在只读事务内验证 current_user/session_user/数据库一致、拒绝超级用户，核对 public schema USAGE、三张新表类型与实际有效权限，再用 SELECT LIMIT 0 验证可读。statement_timeout=5s、lock_timeout=2s。缺表、缺权、错误身份、未验证RLS策略均阻断；不迁移、不授权、不创建业务行，不输出DSN、密码或原始驱动错误。退出0只证明本节ACL门禁通过，不证明业务、租户隔离、费用或整个数据库健康。

| 表 | 必须有效的权限 | 生产调用依据 |
|---|---|---|
| public.agent_question_scopes | SELECT、INSERT、UPDATE | questions/store.cjs 的scope查询与取消upsert |
| public.agent_run_questions | SELECT、INSERT、UPDATE | 问题插入、锁定读取、回答/过期/取消更新 |
| public.model_request_attempts | SELECT、INSERT | tasks/store.cjs 的去重、计数与持久预留 |

上述表不需要序列或DELETE授权；不授予PUBLIC全权限、不把运行账号改为postgres。ACL由角色继承或PUBLIC间接获得时同样计入有效权限，不能只看单个直接GRANT。当前工具只覆盖R34新增三表，其它旧业务表/序列仍由既有运行验证负责。RLS若未来启用，须补真实策略验证后调整契约，不能只靠表ACL放行。

## 后续正式发布顺序（本轮未执行）
1. 整体范围通过后，核对实时版本/并发工作、冻结唯一最终归档及指纹。旧AUTO M1部署脚本不复用执行；本工具也不偷偷插入已冻结R33脚本。
2. 通过既有私密运行配置确定真实DB身份，记录预期角色与数据库；不要在终端或报告打印environment/DSN。先备份数据库、ACL/owner与配置，再隔离恢复。
3. 在恢复库由审核确定的迁移角色执行迁移，核对owner、迁移文件与实际有效权限。若缺权，人工审定最小表级授权；仅给runtime schema USAGE及上表必要权限，不自动批量授权。
4. 用实际运行登录角色在隔离库运行门禁，再完成真实question service等待/回答/取消/重开，以及AUTO预留去重/重开/lease边界功能验证。仅用管理员SET ROLE或迁移数量不能代替运行凭据验证。恢复库若CONNECTION LIMIT 0阻止运行账号连接，应在隔离验证方案中明确处理，不误把连接失败当权限已验。
5. 只有正式部署重新获准且整包门禁满足后，才对正式库迁移/审核授权并运行相同门禁；受控切换、健康/来源绑定后进入同版本QA。门禁是时点证据，切换前仍须核对并发ACL变化。
6. 失败保留备份及诊断，不自动删表、降级迁移、撤回已写审计记录。回退应用时保留新增表与持久预留，避免绕过去重；兼容性与恢复方案在最终脚本中单独验收。

调用模板（仅在已安全加载目标运行配置、确认目标后）：
```sh
node scripts/northstar-runtime-db-gate.cjs --expect-role '<实际运行角色>' --expect-database '<目标数据库>'
```
不包含任何连接凭据；部署工具必须检查退出码。不能以本次本地PASS替代正式执行记录。

## 验证
`tests/probes/r34-runtime-db-gate-pg-20261109.cjs` 使用真实029/030迁移，在专用localhost库创建管理员拥有的新表，使用独立运行账号连接。最终8组检查通过，CLI退出0；缺权、只授权问答两表、超级用户、错误账号/数据库、撤销UPDATE、RLS、schema不可用及缺表均未放行，业务表零写入。见[evidence](evidence/R34-RUNTIME-DB-GATE-PG-20261109.txt)。测试早期的PUBLIC继承夹具错误及schema拒绝处理迭代也保留说明，不抹去失败历史；容器已清理。

## 价格导入仍需审核的具体信息
B3-07继续阻断。现有 `northstar-price-catalog.cjs` 只支持离线PGlite维护，显式拒绝PG；不能拿原命令直接导入正式库。现有价格选择器要求四个明确费率与固定来源URL，不能为适配它把未知cache creation写成0。
2026-11-09已归档的公开观察只是OBSERVED_NOT_APPROVED_FOR_IMPORT，未重新查询、不得作为当前价格保证。待审核内容包括：准确模型ID、正式来源/页面指纹、采集时间与明确生效区间、USD/每百万tokens单位、缓存读写语义、时段加价及其缓存适用规则。来源模型页与固定pricing URL契约不一致、缺缓存创建价、时段规则不明确时应保持unknown；不得回填历史有效时间。后续最小契约扩展及PG受控导入必须先冻结审核，保留实际账单与估算的区分，不使用常量快照充数。
