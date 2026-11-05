# 原08主程独立审核：需局部修正，暂不直接集成
2026-11-04｜结论：**NEEDS_REVISION / INTEGRATION_BLOCKED**。原08作者已交付，但独立反例复现安全/契约缺口；需要原作者交局部修正分支或补丁后复审，不要求重做任务包，不改08正文。本次没有修原实现、合并主线、PT调用、生产验证或部署。

## 1. 已做审核与证据
读取了原08正文、实现、CONTRACT及探针，并搜索当前shell静态调用引用。原08实现/契约/探针指纹与交付报告一致；本轮读取后原文件指纹不变。原探针复跑26/26 PASS、退出0；新增独立14项检查，4项控制通过、10项未满足，退出1，失败原样保留，不把已知缺陷改成预期PASS。

| 证据 | 路径/结果 |
|---|---|
| 新独立探针 | [auto-08-main-review-20261104.mjs](../../../tests/probes/auto-08-main-review-20261104.mjs)，真实调用原候选，没有网络/推理请求 |
| 机器报告 | [AUTO-08-MAIN-REVIEW-20261104.json](AUTO-08-MAIN-REVIEW-20261104.json)，含Node、四份保护文件SHA、原探针结果及每项失败实际/预期 |
| 原探针 | `node tests/probes/auto-delivery-20261103.mjs`：26/26、退出0；已被新探针串行复跑 |
| 新探针命令 | `node tests/probes/auto-08-main-review-20261104.mjs --report docs/refactor/evidence/AUTO-08-MAIN-REVIEW-20261104.json`：14项，4 PASS / 10 FAIL，退出1 |
| 主线引用边界 | 本轮搜索shell的createTaskRouter/auto-20261103引用只见候选自身与CONTRACT示例，未见静态主线调用；这不是远程生产运行状态证明 |

本次测的是选择器/配置契约，**返回另一个模型≠已经执行了第二次收费请求**。尚无该候选已集成生产或造成重复扣费的证据；但它不能原样作为安全重试/选择门禁接入。用户最新“PT确认零费用拒绝才可继续”的执行协调由主程序补接，不能拿新需求未实现掩盖原合同已声明的未知结果保护缺口。

## 2. 复现发现与原作者局部修改要求

| ID/级别 | 代码位置与实际行为 | 局部补丁及复测要求 |
|---|---|---|
| R1 / P1阻断：未知费用被跳过后继续选模型 | `shell/candidates/auto-20261103/index.cjs:118–123,143–156`：eligible=true且reason=PAYMENT_UNKNOWN的a被skip，选择b；eligible=false且UNKNOWN_PAYMENT_RESULT的a同样不停止，可选c。原CONTRACT承诺UNKNOWN_PAYMENT_RESULT，但代码未产生此错误；原探针第12组反而把“跳过后选b”当PASS | 显式区分调用前资格拒绝与已有执行结果未知；任何可信未知执行状态先终止整个选择，不能只删除该模型。合同若继续识别PAYMENT/BILLING类unknown，需返回稳定安全错误。明确QUOTA资格拒绝不是天然付费未知，也不是零费用证明；更新原探针的错误安全预期，不让错误行为继续被测成PASS。复测R1-01/02 |
| R2 / P1阻断：dispatched检查范围不全 | 同文件`:126–145,149–156`：dispatched时有另一个primary或manual选择可直接成功，仅进入fallback数组时才拦；R2-01实际选b，R2-02手动b也成功 | 在任何选择分支之前执行统一状态门禁。旧选择器不得因“primary/manual”名称绕过已发尝试保护。新PT明确零费用拒绝后的下一attempt由外层协调器按补充契约创建，不能重置旧attempt为pre-dispatch。复测primary/fallback/manual及未知，已有合法pre-dispatch控制仍通过 |
| R3 / P1门禁输入缺口：未知状态/模式默许 | 同文件`:113–114,127,151`：dispatchState=unknown被当允许fallback，未识别selection.mode被当auto | 严格验证枚举/类型；非pre-dispatch/dispatched状态与非法mode返回具体配置/输入错误，不默认为安全状态。保留省略字段时原约定默认值，区分省略与非法显式值。复测R3-01/02和正常默认/手动 |
| R4 / P2配置契约缺口：fallback去重不全 | 同文件`:50–67`：只去重candidates，fallback自身重复、与primary重复均返回无错误 | 验证整条路由的候选集合重复，稳定返回DUPLICATE_CANDIDATE或兼容映射，防止外层有限尝试预算被重复条目绕过；复测R4-01/02 |
| R5 / P2版本pin不完整 | 同文件`:69–70`：空pinVersion被接受。pin只验证字符串类型，selectModel没有使用/返回pin，原输入资格schema也没有对应revision验证来源；原探针没有版本pin行为验证 | 至少拒绝空/全空白pin。给出真正版本pin由谁执行、如何与资格/模型revision绑定/传递的可验证接缝；能在候选内完成则局部补齐，若依赖宿主则交明确接口建议，由主程落实，不许把未验证pin宣称完成。R5-01测空值；有效/不匹配revision的完整行为仍需新证据，不能把只修空字符串当全pin通过 |
| R6 / P2配置版本可漂移 | 同文件`:94–95,139–145,164–167`：闭包保留外部config引用。创建router后改config.version，router.configVersion仍旧值，select结果却报新值；候选数组亦以外部对象引用保存 | 冻结或防御复制配置快照，或实现明确原子重载/新实例接口；同一router的路线和configVersion一致，不允许未发布对象修改改变已绑定版本。复测R6-01，并补候选数组/版本一起变更的反例 |

P1指接入阻断级风险，P2也需在本次契约修正中闭合或明确依赖、由负责人接受受限范围后再接入；不表示本轮认定已有生产事故。R1在现接口输入无法分辨资格原因与执行结果来源时，需要改清契约/调用边界，而不是继续靠reason正则“猜”。拒绝未知的安全接口可以限制输入；不得给出“调用方不会这样传”而无可执行门禁与测试。

### 关键最小复现
原路由：candidates=[a,b]、fallback=[c]，均为合成模型名，无真实PT调用。

| 独立检查 | 输入要点 | 原实现实际返回 | 安全预期 |
|---|---|---|---|
| R1-01 | a eligible=true/reason=PAYMENT_UNKNOWN；b eligible=true；pre-dispatch | ok=true，b，source=primary | UNKNOWN_PAYMENT_RESULT，停止 |
| R1-02 | a eligible=false/reason=UNKNOWN_PAYMENT_RESULT；c eligible=true；pre-dispatch | ok=true，c，source=fallback | UNKNOWN_PAYMENT_RESULT，停止 |
| R2-01 | a false、b true；dispatched | ok=true，b，source=primary | 拒绝重新选择执行模型 |
| R2-02 | a/b true；dispatched＋manual b | ok=true，b，source=manual | 拒绝已发尝试改模型 |
| R3-01 | 仅c true；dispatchState=unknown | ok=true，c，source=fallback | 具体输入错误，不推定未提交 |

## 3. 哪些归Gemini，哪些由主程序接线

| 责任 | 本次范围 |
|---|---|
| Gemini原08作者 | R1–R6的局部候选修正、对应契约澄清、原错误探针预期纠正与新增反例；交独立修复分支/补丁、完整base/tip、文件SHA与真实自测。08任务包正文不重写 |
| 主程序 | 审核局部补丁；17目录自动同步和当前Key预筛、31/34 PT语义映射、持久operation/attempt协调、可读错误/UI、共享主线接线与独立验收。不得直接让选择器在dispatch后再次挑primary |
| PT/负责人事实核查 | 确认哪些错误在适用端点/渠道确实未受理且零费用；未获确认，真实执行失败后的自动切换始终关闭 |

最新增强要求见[08补充接线契约](../AUTO-08-CATALOG-FALLBACK-CONTRACT-20261104.md)及[17包](../REFACTOR-GOVERNANCE-PACKAGE-20261103.md)。Gemini不用重做整包、不负责修改主server/runner或部署；新调度/实际失败重试协调不得塞回纯选择器形成第二执行器。
原候选文件可在原作者**独立修复分支**改动并交补丁，保留原交付证据；不得直接覆盖当前共享工作区里被冻结待审的原候选，不能改08任务包正文。涉及新增字段/错误码或改变合同，提供兼容映射和调用方要求，由主程决定落位。

## 4. 复审与接入门禁（不得遗忘）

- [ ] 原作者交局部修复base/完整tip/分支或补丁，逐项回应R1–R6及未闭合依赖。
- [ ] 原探针错误预期已纠正；正常选择、合法资格fallback、手动、全部无资格、稳定配置等不退化。
- [ ] 新独立探针缺陷用例通过；如改为兼容的不同安全错误码，先审核语义再调整断言，不能为变绿允许继续选模型。
- [ ] 版本pin实际绑定、配置快照、scope/过期资格的可信宿主过滤另有行为证据；原eligibility schema不含这些字段，不能仅由纯选择器测试宣称全部具备。
- [ ] 主程集成attempt/未知停止门禁，模拟协议确认只测规则，生产PT确认gate默认false；测SDK无隐式重发、重启/并发最多一活跃attempt。
- [ ] 同版staging独立E2E/接口及真实PT适用证据，未授权项BLOCKED；正式发布另走精确归档门禁。

当前处置：**已审核，局部修正待交付；禁止原样接入，不需要整包返工。** 台账第08行以本报告为主审阻断依据；本轮未向Gemini发送外部消息，用户可直接转交本文件或第2–4节。
