# 媒体预留核对纯函数主审修正
结论：本轮已修复审阅确认的候选缺陷，53项本地专项通过；函数仍未连接数据库释放事务，不授权自动释放、重新签发grant或重新提交付费任务。Gemini原报告及任务包保持不变。独占修改仅候选函数、专项测试及本报告。

|修正|证据/行为|
|---|---|
|真实taskType兼容|使用022迁移/media-grant-store的text2image、image2image、text2video、image2video；四类最小持久记录投影均通过，未启动数据库|
|严格时间|接受UTC秒及1–3位小数，规范化到毫秒并ISO往返比较；拒绝2月30日、24点顺延、夹杂文字和超毫秒精度。宿主Date.toISOString/PG decode均为毫秒格式。保持updatedAt/observedAt相对reservedAt约束，不读取当前时间|
|取消证据一致性|not_submitted必须host、无taskId、queried=false、providerStatus=null；与远端成功/取消、查询或来源冲突均拒绝。可信host明确远端cancelled/canceled可在queried=false时释放，兼容recordSubmissionResult|
|未知与本地失败|manual_check/unknown_submission仍占位；显式unknown_submission/local_timeout/client_timeout/user_aborted/local_cancelled/local_canceled reason即使带终态样式providerStatus也保留占位，不从这些本地事实推断远端完成|
|不可变白名单|内部Set不再暴露；导出仅深冻结字符串数组及冻结module.exports。调用者无法add/push新终态改变释放判断|
|纯JSON/Proxy|先isProxy再Array.isArray/反射；root/nested/revoked Proxy均固定错误且trap零调用。显式undefined、访问器、Symbol、共享/循环等拒绝；错误统一固定说明和code|
|资源先限额|固定schema先判字段数/已知键，再逐属性描述符读取；不复制全量描述符map、不JSON.stringify输入。逐字符串有界计UTF8和JSON转义字节，累计16KiB；百万字符未知键及多字节超限在序列化前拒绝|
|不可变输出|输入不变，输出为仅标量的Object.freeze对象；grantRemainsConsumed=true、mayResubmit=false保持|

JavaScript必须通过Reflect.ownKeys取得自有键以拒绝非枚举/Symbol；这个原生调用仍会为调用方已创建的键集合生成引用数组，不能声称完全零额外分配。后续不再复制描述符map或巨大键字符串，字段数立刻拒绝。函数的已知嵌套schema比深度6上限更窄，数组及其他对象结构均拒绝。

终态白名单继续来自既有provider-adapters：成功completed/succeeded/success/successful/finished/done/ready/ok；失败failed/error/expired/rejected/timeout；取消cancelled/canceled。远端timeout与本地超时分开：明确可信providerStatus=timeout且无本地/未知冲突可作远端失败；本地timeout reason本身不能放行。同步图片允许taskId=null。succeeded/failed无providerStatus但queried=true沿契约保留查询终态路径；无查询且无远端终态仍占位。

测试：保留原43项（修正错误taskType夹具），新增10项，最终53/53 PASS。新增覆盖真实四类store投影、非法日历/ISO、矛盾取消、host远端取消、白名单修改、revoked Proxy、undefined、超大未知键/UTF8与零JSON序列化、全部Proxy trap零调用、终态与未知/本地证据冲突。运行命令：
```sh
node --test tests/regression/media-reservation-reconciliation-candidate-test.mjs
node --check shell/tasks/media-reservation-reconciliation-candidate.cjs
node --check tests/regression/media-reservation-reconciliation-candidate-test.mjs
git diff --check -- shell/tasks/media-reservation-reconciliation-candidate.cjs tests/regression/media-reservation-reconciliation-candidate-test.mjs
```
原始本地输出：`/private/tmp/media-reconciliation-main-review-test.log`。未联网、使用凭据、写DB、调用provider、自动释放或改SQL/profile/package。未来宿主必须在独立事务重新加载同属user/tenant的reservation/grant/operation、重新核验身份/provider/状态/修订后释放slot；本函数不验证数据库来源，也不保证费用为零。
