# T06 · 独立验收首验

日期：2026-10-16。验收者：架构子 Agent，未参与 capabilities.cjs 实现。范围：只读 `shell/models/capabilities.cjs`、实现方测试与 T06 证据，对照任务包 T06 的未知能力、快照保留、本地启用策略和适配／验证／AUTO 门禁。结论：**FAIL，三个模块级阻塞；不得将该纯函数模块标独立通过。** 当前模块未接入生产目录，因此以下不是已实证的线上越权利用。

新增独立检查件：`tests/regression/model-capabilities-review-test.mjs`。没有修改实现方文件、测试或证据，没有调用 PT、接入 model-catalog、使用真实 Key 或提交代码。

| 编号 | 可复现触发与实际行为 | 预期／最小修复方向 |
|---|---|---|
| R06-1 | 构造已明确授权、适配、验证、启用的 AUTO 模型；下一次快照 success=false，同时传可信 `permission:false`。mergeSnapshot 直接返回 prior，permission 与 AUTO 仍为 true | 上游失败可以保留模型能力事实，但不能忽略明确的权限撤销；对保留目录立即闭合路由权限 |
| R06-2 | 已启用模型未出现在 partial snapshot 中，传 `policies[id]={enabled:false,source,version:2}`；保留条目仍是旧 enabled:true、版本1、AUTO true | 本地启停策略必须作用于所有保留条目，不依赖上游本轮是否返回该模型 |
| R06-3 | 同样 partial 快照未含原模型，传 `adaptations[id]={}` 撤销适配；原 adapted／verified／AUTO 仍 true | 适配登记撤销应重算门禁并令旧验证失效，不以条目未返回而保留可执行资格 |

三项有共同根因：incoming 模型走 normalize，retained 模型仅处理部分 permission；失败快照更早返回，可信本地控制面更新未统一应用。建议把本地权限／策略／适配／验证的变化作为独立受控更新，对保留模型一致重算，保持 upstream availability 与执行授权两个维度；不要通过清空全部目录或把请求失败伪装下架来修。跨 permission scope 仍应隔离，不能把另一 scope 的更新覆盖旧记录。

## 实际命令与结果

`node --test tests/regression/model-capabilities-test.mjs tests/regression/model-capabilities-review-test.mjs`：**20 tests，17 pass，3 fail，0 skip**，exit 1。实现方 15 tests 全通过；独立 5 tests 中 2 通过、3 失败。失败均为 expected false／actual true，或撤销后的 gate 未变化，不是依赖缺失、网络或夹具错误。

通过的独立场景：上游同步失败保留原能力事实而不猜测缺失能力；显式能力 false 优先于 supported list；跨 scope 不污染原输入。失败场景分别覆盖“同步失败＋权限撤销”“部分同步＋平台禁用”“部分同步＋撤销适配”。全部是纯函数合成样本，未证明真实 PT 字段、每日调度、缓存、分页、实时鉴权、HTTP 或运行时模型选择。

## 完成判定

本次首验不能通过。实现者修复后需原独立测试保持不变重跑，并补“失效策略不复活旧 AUTO、失败快照本地更新与 upstream事实分离、同范围保留模型各类控制面撤销一致生效”的回归。最终即使纯函数通过，T06 全包仍需现有 model-catalog 接线、目录同步／缓存／唯一调度和真实 PT 权限范围验证，不能从本地 PASS 外推完整目录可上线。

## 修复后独立复验 · 2026-10-16

实现者 baseline 已修复三项首验 FAIL；架构子 Agent 保持原独立 review 测试不变，未修改实现或实现测试，重新运行：

`node --test tests/regression/model-capabilities-test.mjs tests/regression/model-capabilities-review-test.mjs`

实际结果：**21 tests／21 pass／0 fail／0 skip，exit 0**。其中原独立 5 项全部通过，原三项反例不再复现：失败快照的明确 permission:false 关闭 AUTO；partial snapshot 保留项收到平台禁用策略后立即停用；适配撤销令 adapted／verified／AUTO 均关闭。模型 availability 仍 present，没有用“伪下架”掩盖授权更新。

**复验结论：该纯函数模块在本次限定范围内独立 PASS，原三项模块阻塞已闭环。** 首验失败记录保留为原因与反例。没有运行 PT、接入现有 model-catalog、验证真实权限范围或每日同步，因此 T06 全包与生产 AUTO 仍不能标完成。
