# F1 模型媒体审阅映射器（2026-10-25）

**结论：新增纯映射器，但未接入用户入口，也未授予任何真实 AUTO 媒体模型。** `shell/models/reviewed-media-qualification.cjs` 接收同 Key 新鲜目录及逐模型人工审阅记录，仅为审阅过的任务输出 `overrides/policies/adaptations`；首次应用只清除这些媒体任务的旧验证，保留独立聊天验证。文生图与图生图需要分别列出任务，适配器 ID、版本和端点来自本地固定 wire adapter 注册表；目录中的泛化端点或模型名不能生成任务审阅。

审阅记录必须声明目录 `scopeId`、该模型当前 `capabilityRevision`、来源、版本、审阅时间及每项任务的独立来源。映射器在目录非 fresh、同步错误、模型未出现在当前 Key 可用列表、permission 不为 true、scope/revision 不一致、任务重复或适配器与任务不匹配时拒绝。它不会生成运行验证，`routeMediaTask(mode=auto)` 对映射后的模型仍拒绝；手动资格运行仍需主机侧硬预算、提交意图、单次 POST 与持久结果处理。

当前实现是**两阶段管理员审阅契约**：审阅记录先绑定应用前的 `capabilityRevision`；写入人工 override 后，管理员检查新模型并把新哈希作为 `appliedCapabilityRevision` 加入同一版本记录。后续只有当前哈希恰好等于该新哈希、审阅来源/版本及任务策略/适配器仍逐项一致时才幂等重放，并保留后来真实运行得到的验证；任何第三种哈希或配置漂移都拒绝并要求重审。此处只实现纯构造与校验，尚无管理员应用/审阅持久入口，不能把本模块的存在算成策略已上生产，也不能把 10/24 直接 API 图片成功转成 AUTO verification。当前没有真实模型审阅清单、Key 账单或视频成功事实；旧 T2V 未知提交不重投。

聚焦 `node --test tests/regression/f1-reviewed-media-qualification-test.mjs` **6/6 PASS**，覆盖单任务审阅保留既有显式聊天策略、I2I 独立审阅、两阶段精确重放及旧验证清除、新验证保留、目录 merge 路径不凭配置制造 AUTO 证据、scope/revision/adapter 拒绝、目录和权限拒绝；`node --check`、`git diff --check` PASS。全部为本地假记录，无付费请求、真实 Run、浏览器或发布证据。

## 受控应用器

新增 `shell/models/reviewed-media-apply.cjs`：接受上述新鲜 scoped catalog、显式审阅记录及主机注入的 `applyUpdates`。回调契约是以 scope 和每个被审阅模型的**应用前** capabilityRevision 原子 compare-and-set，并返回应用前版本回执及应用后目录；冲突或回执不匹配均固定码拒绝。应用器复查应用后 scope、fresh 状态、模型权限、review 来源/版本、任务事实、策略、端点、适配器及验证：首次应用不得凭配置得到媒体 `verified/autoEligible`；精确 pinned 重放不得改变已取得的运行验证或已确认的新哈希。返回值只有 modelId、scopeId、旧/新 capabilityRevision、审阅版本和 `pending_admin_confirmation`，无 Key、任务 prompt 或资产 URL。

此模块**没有实现存储事务**：只有可信的主机回调能保证 compare-and-set 与写入原子性，并应在事务内完成应用后校验；单靠应用器的返回回验不能回滚已提交的不合格写入。当前没有这样的生产回调、管理员确认入口或真实 review，因此它仍是可集成的纯服务契约，不是功能开通。`f1-reviewed-media-apply-test.mjs` 本地 `mergeSnapshot` 模拟、并发冲突与伪造验证/哈希拒绝 **4/4 PASS**；与 builder 合计 **10/10 PASS**，不代表目标数据库并发或真实 PT 验收。
