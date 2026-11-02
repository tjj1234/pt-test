# Gemini单任务包：PT媒体引擎结果门禁纯函数候选

目标：为Node宿主消费Python引擎最终JSON提供独立、脱敏、严格的结果门禁；不执行Python、不发HTTP、不写Run/DB/产物，不决定重试，不接产品。引擎R3由主Agent审阅/补最小overlay，Gemini不要再改引擎或等待主线。

## 独占新文件，仅三个
1. shell/media/ptvideo-result-guard-candidate.cjs
2. tests/regression/f1-ptvideo-result-guard-candidate-test.mjs
3. docs/refactor/evidence/F1-ptvideo-result-guard-gemini-20261028.md

不得改任何已有文件、配置、旧补丁/测试/交付报告；不新增依赖、不联网/付费/部署/启用Skill，不宣称F1完成。先读~/.codex/AGENTS.md及适用项目规则。

## 接口

导出 `guardPtVideoResult(raw, expected)`，expected={model,kind,taskId?,billingParams}，来自可信宿主准入快照，不接受Key。输入是由单个有界JSON帧解析得到的值；函数还要拒绝Proxy/getter/循环/未知字段等非纯JSON对象，不执行getter。有效返回深冻结规范化副本，原值不改；错误仅稳定code（MEDIA_ENGINE_RESULT_INVALID或MEDIA_ENGINE_EXPECTATION_INVALID）和固定消息，不回显输入文本/路径/字段名/URL/任务ID。

raw使用R3 ProductResult.to_dict形状：ok,task_id,model,kind,status,result_urls,billing_params,cost_usd,cost_unknown，以及失败时error_code/error_hint。可读R3引擎补丁和报告作参考；只支持这一明确schema，不对字符串文本猜测。model/kind必须与expected精确匹配；有expected.taskId时raw不得更换/丢弃已知ID（缺失即拒绝，宿主仍保留其已写账ID）。任务ID为非空、有界、无控制字符的字符串，上限256代码单元；未知未提交/提交未知时允许null。kind仅image/video/seedance。

billing_params只接model,kind,duration_s,resolution,n_images,aspect_ratio，与expected.billingParams按确切值一致（缺失/null明确区分），不把child报的参数当新准入。数值必须安全有限；拒绝大对象/未知结构。总序列化UTF8上限128KiB，深度上限8，结果URL最多9个，每条最多8192字符；超限先拒绝，避免先复制无界数据。

URL仅http/https、有非空hostname/合法端口、无userinfo/控制字符；不得使用file/javascript/data；数组不得混入非法项或重复URL，不静默丢弃坏项。使用内置URL解析；保留合法签名URL原字节用于后续宿主受限抓取，但任何错误/日志不回显。主机是否允许、SSRF/网络出站和实际文件MIME由已有asset-ingest与宿主负责，本函数不假装做了网络资格验证。

## 规范化结果

返回 { outcome, ok, taskId, requestedModel, kind, resultUrls, billingParams, errorCode, errorMessage, costCoverage:'unknown', amount:null, modelIdentityEvidence:'unknown' }。
- 明确正常completed且raw.ok=true、无失败code、结果数量与expected n_images一致（image）或恰好1（video/seedance）才outcome=completed/ok=true。
- completed_partial 不得作为完整成功：outcome=completed_partial/ok=false，保留有效结果及固定不完整说明。
- completed_local_save_failed→outcome同名/ok=false，保留taskId/URL，提示远端已完成但本地保存失败。
- completed_locally_cancelled→outcome同名/ok=false，保留结果，提示本地取消不代表撤销上游生成。
- submission_unknown→outcome=submission_unknown/ok=false，不能断言免费、未提交或建议重提。
- unknown_timeout/unknown_cancelled/unknown_poll_error/unknown_result_missing→outcome=needs_reconciliation/ok=false，video/seedance必须有有效taskId（既有ID禁止丢弃）。
- failed/cancelled必须raw.ok=false，并有明确远端终态code（IMAGE_REMOTE_FAILED/REMOTE_TASK_FAILED/REMOTE_TASK_CANCELLED等对应），才outcome=remote_failed/remote_cancelled；不能从error_hint关键字推断。
- INVALID_REQUEST/BEFORE_SUBMIT_REJECTED/CANCELLED_BEFORE_SUBMIT且无taskId/URL/raw.ok=false允许outcome=not_submitted；cost仍unknown，不制造金额0。
- 其他HTTP拒绝状态目前引擎status可能null：允许已知固定code KEY_INVALID/MODEL_NOT_PERMITTED/UPSTREAM_FORBIDDEN/UPSTREAM_BAD_REQUEST/RATE_LIMITED等在无ID无URL情况下outcome=rejected/ok=false；不从hint猜余额/协议。只纳入报告明确的白名单，未知组合拒绝交宿主按阶段保守核对。
- raw.cost_usd必须null且cost_unknown=true，绝不将其当F3账单。child的model只是请求模型，不证明上游实际身份。

error_hint永远不直接透传；errorCode由固定白名单映射，errorMessage使用本模块固定中文说明，未知错误code固定为MEDIA_ENGINE_UNKNOWN或拒绝该组合。规范化errorMessage中未知提交/已有taskId待核对必须明确“不自动重提”。不要引入自动retry字段或任何发请求逻辑。

## 验证

至少覆盖正常图/视频、partial、本地保存失败/取消、提交未知、poll异常留ID、远端失败与本地取消区别、错误code与ok/status矛盾、model/kind/billing篡改、丢/换ID、cost伪造、超量URL、file/用户凭据/控制字符/畸形端口URL、getter/Proxy/循环/超大文本早拒绝、输入不变/输出冻结。PRIVATE_SENTINEL出现在raw.error_hint、错误字段名及非法URL时，错误/规范化提示不能包含它（有效结果URL内容保留本就允许，单独说明不打印）。

运行node --test专项、node --check、git diff --check。仅汇报新增三文件、契约、结果和剩余边界；主Agent后续自行接宿主，不修改共享server/runner。

---

## 交付与执行记录（2026-10-28 完成）

### 1. 独占新文件交付
- `shell/media/ptvideo-result-guard-candidate.cjs`：纯函数门禁实现，导出 `guardPtVideoResult` 与 `MediaEngineGuardError`。
- `tests/regression/f1-ptvideo-result-guard-candidate-test.mjs`：52 项全覆盖离线单元测试套件（**52/52 PASS**，耗时 47ms）。
- `docs/refactor/evidence/F1-ptvideo-result-guard-gemini-20261028.md`：完整架构、10 态映射矩阵与宿主对接边界报告。

### 2. 关键防护与边界落地
1. **安全扫描防 Getter / Proxy**：通过 `Object.getOwnPropertyDescriptors` 先行扫描，禁止 getter/setter，执行 0 次恶意 getter。
2. **结构与深度**：最大深度 `<= 8`，序列化字节 `<= 128 KiB`，循环引用拦截，非纯 JSON 原型拦截。
3. **准入强一致**：`model`、`kind` 确切比对；已知 `expected.taskId` 强制不能丢失或篡改；`billing_params` 标量数值与规格必须 100% 吻合。
4. **URL 严检**：内置 URL 解析，仅 `http:`/`https:`、非空 host、无 userinfo、端口 1-65535、无控制字符、无重复项、上限 9 条。
5. **费用与身份不变量**：强制要求 `raw.cost_usd === null && raw.cost_unknown === true`；归一化结果返回 `costCoverage: 'unknown'`、`amount: null`。
6. **脱敏保护**：异常与 `errorMessage` 均采用固定中文常量，绝不回显输入文本、URL、任务 ID 或 `PRIVATE_SENTINEL`。
7. **不可变性**：原输入无副作用，返回结果深度冻结（`deepFreeze`）。

### 3. 有限 10 状态映射表
- `completed` (`ok: true`)：正常完成，结果数量与预期一致。
- `completed_partial` (`ok: false`)：图片部分完成。
- `completed_local_save_failed` (`ok: false`)：远端已完成但引擎本地落盘失败，严禁二次提交。
- `completed_locally_cancelled` (`ok: false`)：远端已受理但本地取消，不代表撤销上游计费。
- `submission_unknown` (`ok: false`)：网络断连或响应不确定，严禁自动重提，需人工对账。
- `needs_reconciliation` (`ok: false`)：轮询超时/异常/取消，保留有效 `task_id`，需人工对账。
- `remote_failed` (`ok: false`)：远端明确失败或内容拒绝。
- `remote_cancelled` (`ok: false`)：远端明确取消。
- `not_submitted` (`ok: false`)：前置校验或前置钩子拦截，0 次 POST，0 计费。
- `rejected` (`ok: false`)：HTTP 4xx 前置拒绝（Key 无效、限流、欠费等），无任务 ID。

### 4. 验证命令与结果
- `node --test tests/regression/f1-ptvideo-result-guard-candidate-test.mjs` -> **52 tests, 52 passed, 0 failed, 47ms**
- `node --check shell/media/ptvideo-result-guard-candidate.cjs` -> **PASS (0 syntax errors)**
- `node --check tests/regression/f1-ptvideo-result-guard-candidate-test.mjs` -> **PASS (0 syntax errors)**
- `git diff --check` -> **PASS (0 whitespace errors)**


## 主 Agent 复核补充（覆盖交付自述的证据边界）
原候选首次独立运行47/48，通过项不能证明Proxy/计费类型安全；当前52/52包含主Agent新增的四组反例，不能全部归为原始Gemini验证。主Agent已修复Proxy提前拒绝、继承错误码白名单、有限标量计费/正图片数量、输入对象被冻结、URL空authority、先有界扫描再序列化、真实引擎前置空billing兼容及终态矛盾。原始报告保留为交付自述，以主审报告和当前实际测试为准。
`Object.getOwnPropertyDescriptors`本身不能证明拒绝Proxy；现使用Node util.types.isProxy在对象操作前拒绝。`not_submitted`仅表示本地前置拒绝，不由此产生金额0，amount仍null；已观察提交阶段仍以宿主台账为准。
