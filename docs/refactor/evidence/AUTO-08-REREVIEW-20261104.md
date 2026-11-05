# 08 R1–R6补丁复审：候选＋主程小补丁局部通过，待主包接线
2026-11-04｜结论：**SELECTOR_REVIEW_PASS_WITH_LEAD_PATCH / INTEGRATION_PENDING**。复审基线是作者分支`fix/auto-08-r1-r6` tip `0c8841cfb1a658d7d4a7d118584fca7dc3e6e1f2`，加本报告登记的主程R3空值防护补丁；不是原0c8841c单独无条件通过，也不是已经合并或上线。
原14项及纠偏后的26项已独立复跑通过；扩展边界发现R3仍漏显式假值，主程在临时副本补最小防护后验证。作者分支及共享原候选未被覆盖，不再要求Gemini整包重做。08与r28 Bug修复线保持分开。

## 1. 交付核验与测试证据

| 核验 | 结果 |
|---|---|
| Git | base bbd9997，单提交0c8841c，4文件新增；base中这些候选/探针未跟踪，所以不是可直接覆盖共享未跟踪原文件的普通增量合并 |
| 指纹 | 用户交付的CONTRACT、index、原探针、审核探针4份SHA全部匹配；作者worktree干净；主工作区HEAD仍bbd9997 |
| 审核独立性 | 作者提交的14项审核断言与主程保留副本一致；本轮主程仅给自己探针增加`--candidate-root`目标参数，没有改变原14项断言 |
| 作者候选原14项 | [机器结果](AUTO-08-REREVIEW-ORIGINAL-ASSERTIONS-20261104.json)：14/14 PASS，原交付探针26/26 PASS，均退出0 |
| 作者候选新增边界 | [机器结果](AUTO-08-REREVIEW-EDGE-20261104.json)：14项，5 PASS / 9 FAIL，退出1。9个失败同属R3显式空/假值与null options处理，失败保留 |
| 主程补丁后原断言 | [机器结果](AUTO-08-REREVIEW-LEAD-PATCH-20261104.json)：14/14 PASS，原探针26/26 PASS，退出0 |
| 主程补丁后新增边界 | [机器结果](AUTO-08-REREVIEW-EDGE-LEAD-PATCH-20261104.json)：14/14 PASS，退出0 |

本轮纯选择器/配置测试，无网络、PT/付费、生产操作、调度启动或部署；没有据此宣称真实PT错误语义已确认或端到端AUTO接入通过。

## 2. R1–R6结论与边界

| 项 | 局部复审结果 | 主包仍须落实 |
|---|---|---|
| R1 | PAYMENT_UNKNOWN/UNKNOWN_PAYMENT_RESULT前置终止通过，原错误探针预期已纠正 | 31/执行协调将所有受理/费用未知归一化为可信未知状态；不能依赖两种字符串正则覆盖所有HTTP/断网/流中断 |
| R2 | dispatched对primary/fallback/manual的统一拒绝通过 | 旧attempt不可洗成pre-dispatch；PT确认零费用拒绝后的新attempt由持久协调器创建，不能绕开该门禁 |
| R3 | 非法字符串枚举已拦；原候选对`options.dispatchState`和`options.selection`使用逻辑或默认值，仍将空字符串/null/false/0当默认，null options抛TypeError | 必须同时带入主程补丁，显式假值报CONFIG_INVALID，真正省略/undefined继续保留原默认 |
| R4 | fallback内部及跨primary/fallback重复拒绝通过 | 有限attempt去重仍由协调器结合本次已尝试模型落实 |
| R5 | 空pin拒绝；有效pin在primary/fallback/manual输出透传均通过 | **透传不等于模型revision匹配已经验证**。主程必须在资格/选择/提交前核对实际revision，缺证据不声称严格pin执行通过；本轮只认可选择器接缝 |
| R6 | configVersion、候选数组、pin在外部对象突变后保持原快照，validateConfig仍验证绑定快照 | 原子配置/目录发布与在途Run快照绑定由17/现有仓储接线；注释提到Object.freeze但实现为深拷贝，已测结果仅证明隔离性，不宣称调用了freeze |

## 3. 主程补丁：只补R3漏项，不覆盖作者分支
[补丁文件](AUTO-08-LEAD-R3-FALSY-GUARD-20261104.patch)只改`index.cjs`：

- options必须是非null、非数组对象，否则返回CONFIG_INVALID。
- dispatchState只有`undefined`使用默认pre-dispatch，显式空/假值仍须接受枚举检查。
- selection只有`undefined`使用默认auto；显式非对象/null/数组拒绝，再检查mode枚举。

对作者0c8841c工作区执行`git apply --check`已通过，**未执行git apply实际写入**。主程用独立临时副本加载修订后源文件测试，作者分支/共享旧候选保持原样。初次在共享旧候选上做只读apply检查因版本不同失败；随后在正确0c8841c目标校验通过，未发生部分应用。

| 可复现绑定 | SHA256 |
|---|---|
| 0c8841c作者index | `a138f98ba63e40317cff7e0fe5c496f3c62f224820cdd0a48e43bf17cbd3f73c` |
| 主程小补丁 | `e178d60ee25db3c4d94417fd80b2c4dc6ff9f0e564cad525693c7c42ef3b00bc` |
| 补丁后index | `775121cbf9edc7d085d6c97c4268dd5bc912d72626fe26ce8d25405f54cf5547` |

临时副本、来源commit和补丁指纹见[overlay清单](AUTO-08-LEAD-R3-OVERLAY-20261104.json)。它不是Git提交/发布候选；后续接入必须使实际源码匹配补丁后SHA或重新复审等价实现，不能只拿本报告给原0c8841c无条件放行。

复现入口（参数替换为作者工作区或按清单重建的补丁后临时副本；不要混用两者报告）：

```sh
node tests/probes/auto-08-main-review-20261104.mjs --candidate-root /private/tmp/pt-fix-auto-08
node tests/probes/auto-08-rereview-edge-20261104.mjs --candidate-root /private/tmp/pt-fix-auto-08
```

第二条对原0c8841c应保留9项FAIL，对补丁后副本应全部PASS；两份独立探针分别验证原14项与新增14项。任意新增修订导致源SHA变化，重新跑相应反例，不沿用旧PASS。

## 4. 后续接入门禁

- [ ] 在保留共享未跟踪原候选/原证据的前提下，将0c8841c文件及主程小补丁纳入明确的集成候选；保持修复前报告，不用reset/clean清理冲突。
- [ ] 复核实际集成文件与本轮补丁后源SHA一致，原14＋新增14＋纠偏26全部通过。
- [ ] 05/06/07等相应契约就绪后，按[08补充接线契约](../AUTO-08-CATALOG-FALLBACK-CONTRACT-20261104.md)接真实Run/预算/批准/attempt、17目录/Key scope及revision校验，补足可读错误。
- [ ] PT未官方确认适用零费用拒绝语义时，执行失败后切换保持关闭；新模型目录同步不自动授予权限或伪造runtime verification。
- [ ] 同版独立staging验证与获准真实PT证据，正式发布另走归档和生产冒烟；本报告不解除r28 Bug候选的3项阻断。

主程负责接线时带入本小补丁，无需Gemini重复整包返工。作者若继续修订原分支，应以实际新tip重新核指纹和对应边界；不要把本报告写成“08已完成主线/生产验收”。
