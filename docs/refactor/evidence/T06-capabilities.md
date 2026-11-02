# T06 · 模型能力规范化与快照生命周期

状态：**规范化模块已接入现有 model-catalog，PT endpoint 语义映射与本地定向回归完成；未同步目标用户真实 PT 目录、未完成 T06 全包。**

## 接口与判定

`normalizePtRecord(raw, options)` 输出模型任务能力、输入／输出模态、endpoint、protocol、streaming／structuredOutput／toolCalling、上下文／文件／时长限制以及来源。事实均为`{value,source}`：未知value=null，不默认true；不从模型名、owner或协议族猜能力。用户已确认 `supported_endpoint_types` 的可信语义：`anthropic`、`openai`、`openai-response`映射聊天，`image-generation`映射文生图，`openai-video`映射文生视频；只对这五个精确值推导对应task和最小I/O模态，并把source指向该字段。`supported_endpoints`是兼容投影字段，不作为此可信映射来源。显式task=false保留；明确I/O冲突会关闭资格。`owned_by`仅模型owner，不当作执行provider。ID使用id/model，不拿展示name冒充ID。

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

没有任务元数据且不含以上可信 `supported_endpoint_types` 值的模型仍展示unknown/未验证，不能因为目录存在或名称相似就进AUTO。已确认的聊天endpoint任务映射与本地OpenAI-compatible Chat Completions adapter endpoint分层；这允许手动首调资格检查，不替代运行时验证。embedding/rerank可记录显式任务事实，但当前TASK_IO不宣称这些任务已具备AUTO路由。

## 快照合并

`mergeSnapshot(previous, snapshot, options)`：previous为 `{scopeId,models,lastSuccessfulAt,...}`；snapshot必须含scopeId、success、complete、observedAt、records，可带sourceVersion。返回新对象，不修改输入。可通过options.overrides/policies/adaptations/verifications按model ID传受控更新。

只有**成功＋完整＋全部记录有效且无重复ID＋同权限scope**快照可标记消失；记录保留tombstone、firstSeenAt/lastSeenAt/removedAt及本地来源。失败/异常body不变更目录；部分成功可添加或更新已观察模型，但不下架未返回模型。跨scope完全忽略，避免把低权限Key可见范围覆盖平台目录；过时快照忽略。恢复条目保留人工override、策略和历史路由记录，旧verification不能直接复活AUTO。未变化的能力事实来源保持原记录，只推进lastSeenAt；显式政策或验收证据仍可更新。

调用者负责证明分页完整与权限scope稳定，scopeId必须在主体或权限版本变化时更换，不能填Key或把所有用户写成同一个scope。需要新scope时单独调用mergeSnapshot(null,新快照)，不得合并进旧scope。平台目录与各用户可见目录由现model-catalog持久层分开管理。

## 测试与边界

命令：`node --test tests/regression/model-capabilities-test.mjs`。最近定向联合回归为 **36/36 PASS**（能力模块、catalog、router、conversation preference）。覆盖五个精确endpoint映射、来源追踪、别名字段不授权兼容性、显式false/模态冲突、适配／验证／AUTO四态、证据绑定及快照撤销恢复。

测试中的deepseek/seedream/wan记录来自现仓库已有PT字段形状，不是本轮从权威端点获取的新鲜全量响应；带tasks/modalities/limits的记录为契约合成样本，不能宣称PT现网一定提供这些字段。

历史待办（截至早期纯函数交付）：接入 model-catalog/cache/API/runtime 已完成；仍待目标环境验证的包括每日调度、管理员刷新、分页完整性和失败退避、真实目标Key目录与 adapter/runtime revision、线上路由回滚。模型/员工提交值不能直接获得权限或自授verifications。


## 独立审查返工

独立方指出三条真实缺陷：失败快照早退保留已撤销permission；部分快照未返回模型的禁用策略不重算；未返回模型的adapter撤销不重算。已将可信本地权限／策略／adapter／verification更新与上游同步成败分离，所有同scope旧模型先用统一eligibility谓词重算，再决定是否接收快照；上游失败仍保留目录事实，但不保留已撤销的路由资格。显式null adapter撤销也清空，不回落旧值。

新增自测覆盖失败／部分两个分支上的permission、policy、adapter、verification撤销以及输入不变。`node --test tests/regression/model-capabilities-test.mjs tests/regression/model-capabilities-review-test.mjs` 实跑 **21/21 PASS**（自身16＋独立文件5），未修改独立review文件。此为返工后执行证据，最终独立复验结论由审查方给出。

## 2026-10-21 · 线上阻塞复核补记

复核当前工作区源码后，修正本文件早期“未接入现有 model-catalog”的概括：`shell/model-catalog.cjs` 已导入本模块，目录同步会调用 `normalizePtRecord`／`mergeSnapshot`；`shell/server.cjs` 已通过 `routeTextTask` 对目录结果 fail-closed。缺口是接线不完整，并非规范化模块完全游离：服务端全局目录仅从 `PT_MODELS_API_KEY`／`POWERTOKENS_API_KEY` 取凭证，没有按当前用户已保存的 BYOK key 建立目录权限 scope；server 调用 catalog 未传入可信的 `permission`、`policies`、`adaptations`、`verifications`；当前规范化层也不把未经核实的通用 `modalities` 或 endpoint 名称推断成 `textChat` 和 text I/O。结果是 catalog 可展示模型，但无证据使其通过 router，线上所有模型均不可执行。

这条补记是静态源码审计，不证明目标服务器环境文件的实际 key 状态、PT 对该测试 key 的实时模型响应或任何模型已通过运行验证。后续补齐仍属于任务包原范围：T06 的按权限 scope 同步、元数据来源和可信 capability/runtime 状态接线；T07 的真实候选路由与 UI 状态一致；T03 仅承接已授权的一次真实 Run 及其限额、无重试、结果/用量记录。不得以静态 allowlist、目录可见或模型名称代替运行验证。

## 2026-10-21 · 用户目录 scope 接线进度与权限证据边界

当前本地源码已把模型目录查询改为按登录用户解密 BYOK，并将 user ID、key hash 与 base URL 纳入既有 cache scope；线上 r5 尚未包含此改动。独立审查确认：`/v1/models` 返回的模型 ID 只能记录为该响应 scope 下的目录可见项，不能据此设置调用 permission=true；权限继续 unknown，直到官方字段语义或可信授权来源证明可调用。服务端尚未传入可信 `permission`、策略、adapter 或 runtime verification，因此所有模型仍应被 router 拒绝。此状态记录不改变 T06/T07/T03 整包验收结论。

## 2026-10-22 · 官方模型页能力信息复核

PowerTokens 官方模型目录将 GLM-5.3 标为 Chat，模型页列出 OpenAI-compatible chat completions 与 `POST /v1/chat/completions`；官方 CLI 页面也说明可按 chat/image/video/audio 列出 key 可用模型。该资料可作为该模型“有文本聊天产品路径”的外部能力来源候选，但页面没有定义 `/v1/models` 的完整响应契约，也没有证明北极星当前用户保存的 key 对该模型的调用权限、目标 DSH adapter 版本或运行验证。因此不据此生成 `permission=true`、adapter verification 或 AUTO 资格。见 [官方 GLM-5.3 模型页](https://powertokens.ai/models/glm-5.3)、[官方 CLI 文档](https://powertokens.ai/powertokens-cli)。本轮通过官网公开页面静态核对；未访问用户账户、未调用模型，也未从该页面推断价格或额度。

## 2026-10-22 · 用户确认的权限语义与动态 qualification 接线（早期映射）

用户明确授权：当前 key 的 `/v1/models` 返回模型 ID 即为该 key 有调用权限；textChat localPolicy 启用；目标 adapter 为 OpenAI-compatible `POST /v1/chat/completions`。该产品方授权覆盖此前“列表可见不等于权限”的旧假设，故以上10/21段落中 permission unknown 的结论已过期。`shell/model-catalog.cjs` 的成功当前凭据快照只给本次返回 ID 设置 `permission=true`，未返回缓存 ID 撤销为 null；启用 textChat policy 对返回模型动态生效。动态模型的能力/adapter 映射仍须有明确 textChat 与文本输入输出事实；范围修正和回归见下节。目录/能力/router 聚焦回归 **34/34 PASS**，登录集成与 UI 首调 **2/2 PASS**。证据来自 fixture 与本地 server/UI 测试：未查询目标机当前 key 的 live model IDs，未部署或调用模型；因此不得提前报具体线上模型已放行，也不得把手动首调资格等同 runtime verification/AUTO。

### Qualification scope correction before candidate release（历史范围，后由PT endpoint确认扩展）

The first `qualificationDefaults` draft applied task and modality overrides to every returned model ID. That exceeded the user's permission decision: directory presence authorizes invocation, but does not establish textChat capability. Before release, this was narrowed: `permission=true` and the enabled local textChat policy still apply to every ID returned by the current credential; adapter mapping for dynamic IDs requires PT to explicitly state `textChat=true` and both input/output text modalities. Existing static YAML entries retain their explicit reviewed textChat mapping. Regression now covers both cases: a compatible dynamic text model routes manually with `verificationRequired=true`, while an untyped listed model keeps permission and policy but remains unroutable. The latter proves permission and capability remain separate. The candidate-06 draft with broad overrides was invalidated; corrected behavior is in candidate-07. The focused group remains **34/34 PASS**. No current online model IDs or real invocation have been observed.

## 2026-10-22 · PT `supported_endpoint_types` 任务映射的最新确认

PT技术团队确认可信字段的精确语义：`anthropic`、`openai`、`openai-response`为聊天，`image-generation`为图片生成，`openai-video`为视频生成。该字段现可直接生成对应任务和最小I/O事实并记录字段来源，不必逐模型人工核实；不推导其他能力。兼容字段 `supported_endpoints` 不享有同一信任级别，仅 `supported_endpoint_types` 供任务映射和endpoint兼容使用。显式task=false和冲突模态仍阻断对应资格。动态聊天模型绑定本地OpenAI-compatible Chat Completions adapter；手动路由与AUTO共用endpoint compatibility门禁，前者不要求既有运行验证、但遇到端点不匹配会明确拒绝并返回 `ADAPTER_ENDPOINT_MISMATCH`；AUTO另要求匹配当前能力revision的运行时验证。实现位于 `shell/models/capabilities.cjs`、`shell/model-catalog.cjs`、`shell/models/task-router.cjs`、`shell/server.cjs`。定向回归37/37 PASS，目录旧回归66/66 PASS。candidate-02至candidate-15均作废；candidate-16归档/服务SHA分别为`c4d5133b057fc65a1298a0977ba5b28a10672486ba065319eaecc8aba47b1431`与`468190ada69a15777c0d623ff901408722f6029ac3673c51a70e0d56f4a0c3e8`，独立只读复核通过，含T10 FIFO防阻塞修复，等待维护者手动部署。本地回归和打包不证明目标Key实际返回了哪个ID或线上Run成功。
