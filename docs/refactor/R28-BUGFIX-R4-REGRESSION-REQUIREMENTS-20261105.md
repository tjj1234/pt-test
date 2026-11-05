# r28 Bug修复：原生恢复与模型标签回归局部修订R4
状态：仅两处原范围回归需局部修复，当前禁止部署。此前HTML安全降级通过结论保持，不重开写端实现；Bug-12仍DEGRADED_PREVIEW。不要重做原20项或Gemini8包。

## 固定基线与证据
从主程代码候选db94e425d3746db8c7ab138b462049f5f8a7c5f2创建新独立分支fix/r28-r4-regressions-20261105和独立工作树；不重置原c58ffc6交付、不覆盖主工作区。主程已处理readyMedia语法与媒体原始错误回显，不重复实现。新归档冻结提交27cfa6df123124b2f06016feb9fd551f1d20ff6a仅为打包准备，因本轮回归阻断尚未批准部署，作者不修改归档或包指针。
主程扩大267默认suite后首轮222通过45失败。干净安装锁依赖并允许loopback后重跑45项，42通过，剩余为旧归档绑定、原生推理恢复、UI标签。旧归档已通过另建新包+独立审计解决，原历史归档不改。以下两项旧bbd9997基线均通过，新候选失败，属真实新增回归，不是新产品要求。

| ID/原范围 | 实证及可执行预期 | 修订边界 |
|---|---|---|
| R4-RUNNER-RECOVERY / 原Bug13–14会话恢复 | reasoning-native-runner-test.mjs：同session依次requested-a/high成功、requested-b成功、requested-a/invalid拒绝UNSUPPORTED_REASONING_EFFORT、requested-a/low应再次成功、slow-model在metadata阶段取消RUN_CANCELLED。候选第4次变为RUN_TASK_FAILED，没有第三次模型dispatch；基线全通过。原测试失败后未清理child导致进程挂住，主程临时加清理得到真实断言，不等于产品需要45秒处理 | 核对两处新增agentMap.delete和原生Agent/Session真实生命周期；确定性输入/metadata拒绝不得破坏仍健康的会话；真正不完整/失败turn需按原生生命周期安全恢复，不仅删除宿主Map留下SDK对象。先验证实际接口再改，不凭名字虚构dispose。除原测试外补真实SDK“实际失败→同会话合法请求”的恢复测试，验证预算、身份与取消未弱化 |
| R4-MODEL-LABEL / 原Bug19–20模型展示资格 | ui-model-switch-test.mjs原版57/57，新候选54/57；视频缺不支持聊天提示、图片类型文字退化、语音误标图像生成。loadModels新增isGen分支覆盖modelKindLabel/blockedReason，且disabled选项写“点击切换生成模式”，实际没有该操作 | 保留既有kind分类和不可执行原因，复用modelKindLabel，不把所有非video都归image；禁用选项不承诺可点击。可保留经证据支持的视觉标签，不改变服务端资格门禁、不硬编码解锁模型。不修改断言文字来掩盖能力退化 |

## 实施与交付
只修改shell/persistent-runner.mjs、shell/public/app.js以及新增作者专属tests/probes/r28-r4-author-regression-20261105.mjs；原回归可提供必要清理补丁建议由主程审，不能移除失败断言。保护共享鉴权/配置/原包及其他候选。沿锁npm ci，不用跨目录node_modules链接证明DSH可用；本机纯fixture，不调用PT或线上环境。
交付精确base/tip、两项根因/修复/真实SDK结果、补丁SHA、指定旧回归与新增恢复探针命令/退出码。语法门禁先行，13作者简化回归只作补充，不能代原生恢复与完整app交互。主程独立复测后重冻新包并决定部署，原作者不合并/推送生产或部署。
主程负责此前临时依赖链接和沙箱运行条件不合适造成的噪声，不将45个首轮失败全部归给作者；仅以上有基线对比的两项派修。HTML安全关闭及其他已通过修复保持认可。
