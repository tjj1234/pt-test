# R33正式问答权限核验与R34最小修复计划（2026-11-09）
结论：正式环境已确认问答表权限缺口，已从“仅本地合理假设”提升为“现场ACL事实”。northstar_app对新两表的SELECT/INSERT/UPDATE全为false，而agent_runs/schema_migrations权限正常，029标记已存在。两表均由postgres拥有，运行账号非超级用户，schema USAGE正常，RLS未开启。问答存储正常读写的必要条件未满足；完整原Run的RPC与模型重试因果链仍保留待复测边界。

## 证据与变更边界
[完整脱敏诊断回执](evidence/R33-LIVE-QUESTION-ACL-DIAGNOSTIC-20261109.json)。主程已复用用户恢复的SSH直接只读核对service；脚本上传独立/tmp路径，远端SHA256核验为6f751bc18e7b5a46d29583a39b15c870a4070dc5b27d20d20d221dcaf06ade21。非交互sudo因需要终端认证而停止，随后用户在已连接SSH终端交互执行同脚本并提供JSON回执。
观测时间2026-11-09T08:54:07.205Z，服务active/running、R33目录、PID367662、重启0，四个关键R33源文件匹配。仅四源码核验，不冒称重新完成223源码/全依赖审计。两个失败Run仍failed/revision2；questionCounts=null表示权限不足未查询，不表示表内0记录。
本轮只读，未GRANT、未迁移、未重启/部署、未改变业务记录、未调用真实模型。原“Provider import路径/RPC名称导致”的推测不恢复采用；profile布局与适配名称保持原设计。

## 最小修复方案（准备审阅，未执行）
R34最终发布前在实际运行角色/数据库重新核验、备份数据库及ACL后，按受控迁移与权限步骤补足；当前暂停部署约束仍有效，不单独热改正式库。
```sql
-- 审阅示意；当前没有执行。
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.agent_run_questions, public.agent_question_scopes
  TO northstar_app;
COMMIT;
```
只授予实际服务角色两表所需DML，owner可保持postgres，不授DELETE/ALL/PUBLIC权限，也不让应用改用超级用户。角色名northstar_app来自本次现场，正式执行时仍须从届时服务配置重核。R34还包含030_model_request_attempts，须先迁移存在，再只对该表补SELECT/INSERT，最后以实际运行登录角色执行R34 runtime-db-gate检查三表；不能在当前R33上因为030不存在就误判旧部署损坏。
最终部署脚本必须有迁移管理员→应用运行角色有效权限核验→功能验证这条门禁；管理员恢复/迁移成功与迁移计数不代替应用可用性。旧R33冻结脚本作为历史保留不改；新脚本在整包达标后冻结与SHA绑定。

## 验证与恢复要求
1. 在隔离恢复库按同角色差异复现/补权，问答pending→回答/取消/过期→持久终态、刷新重开、租户隔离和lease/期限矩阵通过；08预留去重/恢复同版回归。
2. 正式操作先记录ACL/owner及配置、核对在途Run和部署锁，授予最小权限后立即用northstar_app实际凭据检查；服务身份/源码漂移则停止。
3. 不靠重新请求模型验证权限，不在未获授权时新增付费调用。正式同版业务QA在最终发布指纹下执行，旧失败Run保留失败，不补写成成功。
4. 失败保留现场与备份，回退应用时不自动删表或撤销必要授权，不丢弃030持久预留；任何撤权先比较当时ACL与本次新增项并核对兼容性，避免撤销他人并发授权。

## 当前结论分层
| 项目 | 状态 |
|---|---|
| 正式服务身份/四源/表权限核验 | READONLY_VERIFIED；ACL_GAP_CONFIRMED |
| 两个原Run完整RPC/模型重试因果复现 | 未完成；原抓包事实继续保留 |
| 权限修复实际执行 | NOT_EXECUTED |
| R34统一包、上线及同版QA | 未完成，范围与暂停部署不变 |


## 受控修复实现与隔离验证（本地完成，正式未执行）
`scripts/northstar-r34-runtime-acl.cjs` 提供显式 `--mode plan|apply --expect-database <db> --runtime-role <role>`，连接使用运维管理员配置。plan只读；apply在同一事务及维护锁下核验数据库、非特权可登录运行角色、schema权限、029/030迁移标记及表/RLS，再只补缺失的八项必要DML。记录原ACL与新增项，无DELETE、PUBLIC、owner变更或撤权；失败整体回滚。执行后仍要求以真实应用登录运行 runtime-db-gate，管理员has_table_privilege不替代此项。
`tests/probes/r34-runtime-acl-repair-pg-20261109.cjs` 在独立本机 PostgreSQL16 容器65014验证五组通过：真实运行账号拥有旧表+管理员迁移新表复现STORE_UNAVAILABLE；只读计划和身份拒绝；末项注入失败导致此前授权真实回滚；精确授权/无DELETE/重复无新增；实际Question Service pending→answer→持久终态且连接重开后保留。容器已停止移除，没有访问正式库或改变R33。
最终发布脚本必须在数据库备份/恢复/迁移验证后调用此模块，并保存回执；当前模块完成不等于最终R34部署脚本或正式权限修复已完成。
