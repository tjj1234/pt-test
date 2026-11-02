# F1 持久 DSH 模型身份取证边界（2026-10-25）

**结论：当前锁定 SDK 可保存部分上游报告的模型身份，但不能从请求模型或缺失的 `responseModel` 推断实际模型。** 因此仅靠先前 task frame 的 A→B 两轮成功，不足以签“上游真实切换”。本切片增加逐响应、脱敏身份字段；没有发起 PT 请求，也未宣称 A→B 完整验收。

| 层 | 实际字段 | 可信含义 |
|---|---|---|
| `shell/runtime/dsh-adapter.cjs` task frame | `model: spec.model` | 用户/路由请求配置，非上游回包 |
| 锁定 `@earendil-works/pi-ai/dist/api/openai-completions.js` 输出初始化 | `AssistantMessage.model = model.id` | 仍是本地请求配置 |
| 同 SDK 的流式 chunk 处理 | 仅 `chunk.model` 为非空且异于请求 ID 时设置 `AssistantMessage.responseModel` | 存在时可确认上游回报的不同模型 ID；缺失可能是相同，也可能是上游未填 |
| 锁定 `@deepseek-ai/dsh-llm-pi-ai` 与 agent-loop | `message.source.model`、`message.source.replayState.response.responseModel` | pi-ai 响应经版本2 replay 投影进入 DSH session；顶层 `message.model/responseModel` 不是正确读取路径 |
| DSH session `assistant/message` | `message.source`，事件 `seq` | 可按当前 turn 的 `firstSeq` 提取逐响应身份，无需保存 prompt/正文；中断或无 replayState 时保持未知 |

实现：`collectModelIdentity()`只读当前 turn 的 `assistant/message`，最多32条，只输出响应序号、配置模型ID、上游报告模型ID或null、固定证据类型与覆盖状态；`normalizeModelIdentity()`在 adapter 边界重新构造白名单，遇非法ID/控制字符退回`unavailable`。runner 在成功、取消、超时和异常 done 帧带该字段；适配器将其传到结果。身份函数置于既有 `shell/runtime/usage.cjs`，避免新增 DSH profile 成员及隔离夹具缺依赖。

验证：`node --test tests/regression/f1-model-identity-evidence-test.mjs tests/regression/f1-budget-policy-change-test.mjs` 为 **5/5 PASS**；额外的 adapter 控制错误、runner 并行隔离、预算汇总组合 **4/4 PASS**；新增同会话合成 A→B 纵向夹具 `f1-dsh-model-switch-identity-test.mjs` **1/1 PASS**：真实锁定 runner + DSH session 第一轮请求A/回报另一模型，第二轮请求B/无上游身份，两个 done 经过宿主 dsh-adapter 后分别为`reported`和`unknown`，task frame 只作为请求证据。`node --check shell/persistent-runner.mjs`、`node --check shell/runtime/dsh-adapter.cjs` 与 `git diff --check` 均 PASS。夹具按锁定 DSH replayState 形状证明“只有请求 model、没有 responseModel”保持 `unknown`，存在部分上游报告时为 `partial`，replay中的请求模型与 source 不符亦不采信，私有正文/额外字段不进入结果；预算会话回归证明 runner 依赖闭包未坏。未通过真实 PT DSH A→B 重新运行，未验证目标浏览器/Run持久化。

下一门槛：`modelIdentity` 可按固定字段持久化到当前 Run 的独立事件或详情，不把它改写为目录权限/账单。若要对所有相同 ID 的上游响应也签身份，需在 SDK 适配边界新增“该流确实出现 `chunk.model`”证据位，或受控网关抓取原始回包；当前锁定 SDK 的 `responseModel` 缺失语义不足。真实 A→B 验收应在同一候选、同一会话两轮中按每次上游返回身份核对，并把无法观测的轮次标未知。

只读插桩评估：pi-ai 的 OpenAI completions 路径在 `for await (const chunk of openaiStream)` 直接看到`chunk.model`，但现有条件只在它与请求ID不同才写`output.responseModel`。pi-ai 的公开`onResponse`只接收HTTP状态与响应头，DSH `dsh-llm-pi-ai`的`streamSimple()`输出已经是加工后的done/error事件；runner 的`llm/stream`钩子更下游，因此**本地 runner/adapter 无法在不改依赖或截取原始SSE的情况下恢复相同ID的存在证据**。最窄可发布路径是让上游 pi-ai 的受控版本在该chunk循环把每个非空`chunk.model`记录为独立“上游已报告”字段（或presence位+值），经 dsh-llm-pi-ai 的版本化 replayState 透传，再按既有锁文件/vendor SHA/profile闭包更新和回归。不能仅把现有`output.model`重命名为响应模型，也不应在现行发布包内直接手改vendor。HTTP头推断或通用fetch代理不具备相同语义，不能替代这一证据位。
