# T06 · 模型能力规范化与快照生命周期

状态：**纯函数模块与本地测试完成；未接入现 model-catalog、未同步真实 PT、未完成 T06 全包。** 本子任务只新增 `shell/models/capabilities.cjs`、`tests/regression/model-capabilities-test.mjs` 和本证据文件，无持久缓存、调度、网络或模型调用。

## 接口与判定

`normalizePtRecord(raw, options)` 输出模型任务能力、输入／输出模态、endpoint、protocol、streaming／structuredOutput／toolCalling、上下文／文件／时长限制以及来源。事实均为 `{value,source}`：未知value=null，不默认true；缺字段不按名称、owner或协议族猜能力。仅识别模块明确列出的结构化字段，未识别PT字段须核实后扩充映射。`owned_by`仅模型owner，不当作执行provider。ID使用id/model，不拿展示name冒充ID。

options必须给非秘密的`scopeId`与`observedAt`；可给`sourceVersion`、`override`、`permission`、`localPolicy`、`adaptations`、`verifications`。人工override必须有source/version，允许覆盖tasks/inputModalities/outputModalities，模型ID须对应；新快照保留它，不被上游记录覆盖。启用策略localPolicy必须有boolean enabled及source/version。

任务状态独立：

| 状态 | 含义 |
|---|---|
| discovered | 目录发现该模型，不代表支持所有任务 |
| adapted | 该任务有明确adapterId/version/endpoint/source登记 |
| verified | 当前modelId/task/permission scope/capabilityRevision/adapterId/version/endpoint一致的passed证据 |
| autoEligible | present＋明确permission允许＋版本化启用策略true＋明确任务支持＋相容endpoint＋明确所需输入输出模态＋adapted＋verified |

verification要求source与有效verifiedAt；能力revision包含模型ID、provider、protocol、特性、任务、模态、endpoint、限制与人工覆盖来源版本，防止把别的模型／任务／适配器的验证移植过来。被下架后旧验证失效，恢复目录记录仍需至少下架时点之后的新验证才能回到AUTO。inputTokens/价格等计量不在该模块推断。

示例：

```js
const model = normalizePtRecord(raw, {
  scopeId: '非秘密的principal和权限版本指纹',
  observedAt: '2026-10-16T01:00:00Z', sourceVersion: 'snapshot-1',
  permission: true,
  localPolicy: { enabled: true, source: 'platform-policy', version: '1' },
  adaptations: { textChat: { adapterId:'dsh-text', version:'1', endpoint:'openai-chat', source:'registry' } },
  verifications: { textChat: {
    status:'passed', modelId:raw.id, task:'textChat', scopeId:'同上',
    capabilityRevision:'当前规范化模型revision', adapterId:'dsh-text',
    adapterVersion:'1', endpoint:'openai-chat', source:'验收记录', verifiedAt:'有效时间'
  } }
});
```

没有足够PT结构化元数据的模型仍展示discovered/unknown/未验证，不能因为目录存在或endpoint类似openai就直接选进AUTO。embedding/rerank可记录显式任务事实，但当前已识别模态与TASK_IO仅覆盖文本／图片／音频／视频，不宣称向量和评分任务已具备AUTO路由。

## 快照合并

`mergeSnapshot(previous, snapshot, options)`：previous为 `{scopeId,models,lastSuccessfulAt,...}`；snapshot必须含scopeId、success、complete、observedAt、records，可带sourceVersion。返回新对象，不修改输入。可通过options.overrides/policies/adaptations/verifications按model ID传受控更新。

只有**成功＋完整＋全部记录有效且无重复ID＋同权限scope**快照可标记消失；记录保留tombstone、firstSeenAt/lastSeenAt/removedAt及本地来源。失败/异常body不变更目录；部分成功可添加或更新已观察模型，但不下架未返回模型。跨scope完全忽略，避免把低权限Key可见范围覆盖平台目录；过时快照忽略。恢复条目保留人工override、策略和历史路由记录，旧verification不能直接复活AUTO。未变化的能力事实来源保持原记录，只推进lastSeenAt；显式政策或验收证据仍可更新。

调用者负责证明分页完整与权限scope稳定，scopeId必须在主体或权限版本变化时更换，不能填Key或把所有用户写成同一个scope。需要新scope时单独调用mergeSnapshot(null,新快照)，不得合并进旧scope。平台目录与各用户可见目录由现model-catalog持久层分开管理。

## 测试与边界

命令：`node --test tests/regression/model-capabilities-test.mjs`。当前 **16 tests、16 pass、0 fail**。覆盖既有仓库PT fixture形状、端点不推断模态、unknown与false、显式任务及限制来源、适配／验证／AUTO四态、证据错scope/错model/错task/错adapter/revision、人工覆盖保留、完整新增变更消失恢复、失败／部分／权限变化不下架、无效和重复记录不授权删除、过时快照、不可变输入及策略／历史版本保留，以及显式unknown/拒绝权限撤销AUTO（含部分快照保留项）。

测试中的deepseek/seedream/wan记录来自现仓库已有PT字段形状，不是本轮从权威端点获取的新鲜全量响应；带tasks/modalities/limits的记录为契约合成样本，不能宣称PT现网一定提供这些字段。

后续主Agent必须接入**现有**model-catalog同步／缓存／API和runtime模型配置：每日唯一调度、管理员刷新、超时、分页完整性、失败退避、去重锁、真实Key权限scope、路由版本持久化和真实PT核对均未在此纯函数中实现。运行时能力必须由可信注册与验证证据输入；模型或员工不能直接提供adaptations/verifications/localPolicy获得权限。未接线前旧目录的名称推断逻辑仍然存在，不声称已经修复生产AUTO。


## 独立审查返工

独立方指出三条真实缺陷：失败快照早退保留已撤销permission；部分快照未返回模型的禁用策略不重算；未返回模型的adapter撤销不重算。已将可信本地权限／策略／adapter／verification更新与上游同步成败分离，所有同scope旧模型先用统一eligibility谓词重算，再决定是否接收快照；上游失败仍保留目录事实，但不保留已撤销的路由资格。显式null adapter撤销也清空，不回落旧值。

新增自测覆盖失败／部分两个分支上的permission、policy、adapter、verification撤销以及输入不变。`node --test tests/regression/model-capabilities-test.mjs tests/regression/model-capabilities-review-test.mjs` 实跑 **21/21 PASS**（自身16＋独立文件5），未修改独立review文件。此为返工后执行证据，最终独立复验结论由审查方给出。
